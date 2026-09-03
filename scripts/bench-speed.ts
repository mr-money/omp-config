// bench-speed.ts — 模型输出速度基准测试（成本受控）
//
// 行为：读取 ~/.omp/agent/models.yml（部署后的真实配置），对每个模型顺序发送
// 1 次流式请求（固定短 prompt + max_tokens 硬顶），报告 TTFT 与 output tok/s。
//
// 成本控制：prompt 固定一句话；completion_tokens 由 max_tokens 硬顶（默认 128）；
// 超限检测：若 usage 超过上限，改用 max_completion_tokens 重试一次，仍超限则标注。
// reasoning 模型尝试厂商参数关思考/降思考，400 时自动去掉扩展参数重试一次。
//
// 用法：
//   bun scripts/bench-speed.ts                 # 测全部模型
//   bun scripts/bench-speed.ts --only glm      # 只测 id 含 "glm" 的模型
//   bun scripts/bench-speed.ts --list          # 只列出将被测试的模型，不发请求
//
// 占位符 apiKey（<...>）的 provider 整组跳过，不发请求。

const MODELS_YML = `${process.env.USERPROFILE || process.env.HOME}/.omp/agent/models.yml`;
const PROMPT = "用一句话介绍你自己。";
const MAX_COMPLETION_TOKENS = 128; // 输出硬顶，成本上界
const REQUEST_TIMEOUT_MS = 120_000;

interface YmlModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  compat?: { maxTokensField?: string };
}
interface YmlProvider {
  baseUrl: string;
  apiKey: string;
  authHeader?: boolean;
  models: YmlModel[];
}
interface YmlRoot {
  providers: Record<string, YmlProvider>;
}

// reasoning 模型的“关思考/降思考”参数猜测（各厂商不统一）。400 时自动去掉重试。
// zhipu: GLM-5.3 系强制思考不接受 disabled，用 reasoning_effort 降档；旧 GLM 用 thinking.disabled。
// amd: 平台参数无公开文档，按 Qwen 惯例 enable_thinking 试探，失败降级。
function noThinkParams(provider: string, model: YmlModel): Record<string, unknown> | null {
  if (!model.reasoning) return null;
  if (provider === "zhipu") {
    if (/^glm-5\.3/.test(model.id)) return { reasoning_effort: "low" };
    return { thinking: { type: "disabled" } };
  }
  if (provider === "amd") return { enable_thinking: false };
  return null;
}

interface BenchResult {
  provider: string;
  model: string;
  status: "OK" | "SKIP" | "FAIL";
  note?: string;
  ttftMs?: number;           // 请求发起到首个增量 chunk（含网络+排队+模型首 token）
  tokPerSec?: number;        // completion_tokens / 首 chunk→末 chunk 时长
  completionTokens?: number;
  genMs?: number;            // 首 chunk 到末 chunk（tok/s 的分母）
  wallMs?: number;           // 整个请求墙钟时间
  error?: string;
}

const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const ymlText = await Bun.file(MODELS_YML).text();
const cfg = Bun.YAML.parse(ymlText) as YmlRoot;

type Job = { provider: string; model: YmlModel; baseUrl: string; apiKey: string; authHeader: boolean };
const jobs: Job[] = [];
const skipped: { provider: string; model: string; reason: string }[] = [];

for (const [provider, p] of Object.entries(cfg.providers)) {
  const placeholder = /^<.*>$/.test(p.apiKey);
  for (const m of p.models ?? []) {
    if (only && !m.id.includes(only)) continue;
    if (placeholder) {
      skipped.push({ provider, model: m.id, reason: `apiKey 未填 (${p.apiKey.trim()})` });
      continue;
    }
    jobs.push({ provider, model: m, baseUrl: p.baseUrl.replace(/\/+$/, ""), apiKey: p.apiKey, authHeader: p.authHeader !== false });
  }
}

console.log(`配置: ${MODELS_YML}`);
console.log(`模型: ${jobs.length} 个待测, ${skipped.length} 个跳过 (输出上限 ${MAX_COMPLETION_TOKENS} tokens)\n`);

if (listOnly) {
  for (const j of jobs) console.log(`  ${j.provider.padEnd(18)} ${j.model.id}`);
  for (const s of skipped) console.log(`  ${s.provider.padEnd(18)} ${s.model}  [SKIP ${s.reason}]`);
  process.exit(0);
}

interface StreamMetrics {
  ttftMs: number;
  genMs: number;
  wallMs: number;
  usageTokens: number | null;
  deltaChunks: number;
}

// 消费 SSE 流。t0 必须在 fetch 之前取——部分网关把响应头憋到首个 token 才发，
// 若在 fetch 返回后取基线，TTFT 恒为 0。
async function consumeStream(res: Response, t0: number): Promise<StreamMetrics | { error: string }> {
  if (!res.body) return { error: "空响应体" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let ttftMs: number | null = null;
  let lastReadMs = 0;        // 最后一次读到任何数据（含空 delta/usage chunk）的相对时刻
  let usageTokens: number | null = null;
  let deltaChunks = 0;
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    lastReadMs = Date.now() - t0;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break outer;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (delta && (delta.content || delta.reasoning_content || delta.reasoning)) {
          if (ttftMs === null) ttftMs = Date.now() - t0;
          deltaChunks++;
        }
        if (chunk.usage?.completion_tokens != null) usageTokens = chunk.usage.completion_tokens;
      } catch { /* 忽略无法解析的行 */ }
    }
  }
  if (ttftMs === null) return { error: "流中无任何增量 chunk" };
  return { ttftMs, genMs: Math.max(lastReadMs - ttftMs, 0), wallMs: Date.now() - t0, usageTokens, deltaChunks };
}

async function benchOne(job: Job): Promise<BenchResult> {
  const { provider, model, baseUrl, apiKey, authHeader } = job;
  const capField = model.compat?.maxTokensField || "max_tokens";

  const attempt = (extras: Record<string, unknown> | null, cap: string) => {
    const body = {
      model: model.id,
      messages: [{ role: "user", content: PROMPT }],
      stream: true,
      stream_options: { include_usage: true },
      [cap]: MAX_COMPLETION_TOKENS,
      ...(extras ?? {}),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authHeader) headers["Authorization"] = `Bearer ${apiKey}`;
    return fetch(`${baseUrl}/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  const notes: string[] = [];
  const noThink = noThinkParams(provider, model);
  let extras = noThink;

  let t0 = Date.now();
  let res = await attempt(extras, capField);
  if (res.status === 400 && noThink) {
    // 扩展参数被拒：去掉全部 extras 降级重试一次
    await res.body?.cancel();
    extras = null;
    notes.push("(extras off)");
    t0 = Date.now();
    res = await attempt(extras, capField);
  }
  if (!res.ok) {
    return { provider, model: model.id, status: "FAIL", error: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
  }
  let m = await consumeStream(res, t0);
  if ("error" in m) return { provider, model: model.id, status: "FAIL", error: m.error };

  // 输出上限未被尊重（如思考 token 不计入 max_tokens）：换标准字段 max_completion_tokens 重试一次
  if (m.usageTokens != null && m.usageTokens > MAX_COMPLETION_TOKENS) {
    t0 = Date.now();
    const res2 = await attempt(extras, "max_completion_tokens");
    if (res2.ok) {
      const m2 = await consumeStream(res2, t0);
      if (!("error" in m2)) {
        m = m2;
        notes.push(m2.usageTokens != null && m2.usageTokens <= MAX_COMPLETION_TOKENS
          ? "(cap via max_completion_tokens)" : `(cap ignored, ${m2.usageTokens} tokens)`);
      }
    } else {
      notes.push(`(cap ignored, ${m.usageTokens} tokens)`);
    }
  }

  const approx = m.usageTokens === null;
  const tokens = approx ? m.deltaChunks : m.usageTokens;
  if (approx) notes.push("(approx)");
  // 单增量 chunk（整段一次性到达，AMD 网关常见）时生成时长为 0，
  // tok/s 无意义——回退用 TTFT 作分母给出下界估计，并标注
  let tokPerSec = 0;
  if (m.genMs > 0) {
    tokPerSec = ((tokens as number) / m.genMs) * 1000;
  } else {
    tokPerSec = ((tokens as number) / Math.max(m.ttftMs, 1)) * 1000;
    notes.push("(single-chunk, rate~lower bound)");
  }
  return {
    provider, model: model.id, status: "OK", note: notes.join(" ") || undefined,
    ttftMs: Math.round(m.ttftMs), tokPerSec: Math.round(tokPerSec * 10) / 10,
    completionTokens: tokens, genMs: Math.round(m.genMs), wallMs: Math.round(m.wallMs),
  };
}

const results: BenchResult[] = [...skipped.map(s => ({ provider: s.provider, model: s.model, status: "SKIP" as const, note: s.reason }))];
for (const job of jobs) {
  process.stdout.write(`测试 ${job.provider}/${job.model.id} ...`);
  let r: BenchResult;
  try {
    r = await benchOne(job);
  } catch (e: any) {
    r = { provider: job.provider, model: job.model.id, status: "FAIL", error: String(e?.message ?? e).slice(0, 160) };
  }
  process.stdout.write("\r" + " ".repeat(60) + "\r");
  results.push(r);
}

// 汇总表
console.log("");
const hdr = `${"provider".padEnd(18)} ${"model".padEnd(34)} ${"TTFT(ms)".padStart(8)} ${"tok/s".padStart(9)} ${"tokens".padStart(7)} ${"生成(s)".padStart(7)} ${"总(s)".padStart(6)}  状态`;
console.log(hdr);
console.log("-".repeat(hdr.length));
for (const r of results) {
  const cols = [
    r.provider.padEnd(18),
    r.model.padEnd(34),
    r.ttftMs != null ? String(r.ttftMs).padStart(8) : " ".repeat(8),
    r.tokPerSec != null ? String(r.tokPerSec).padStart(9) : " ".repeat(9),
    r.completionTokens != null ? String(r.completionTokens).padStart(7) : " ".repeat(7),
    r.genMs != null ? (r.genMs / 1000).toFixed(1).padStart(7) : " ".repeat(7),
    r.wallMs != null ? (r.wallMs / 1000).toFixed(1).padStart(6) : " ".repeat(6),
  ];
  let status = r.status;
  if (r.note) status += ` ${r.note}`;
  if (r.error) status += ` ${r.error}`;
  console.log(`${cols.join(" ")}  ${status}`);
}
console.log(`\n说明: TTFT=首 token 延迟(含网络)  tok/s 生成阶段速率  (extras off)=厂商关思考参数被拒已降级\n      (cap via max_completion_tokens)=原上限字段无效已改用标准字段  (cap ignored)=该模型不尊重输出上限  (approx)=无 usage 按 chunk 数近似`);
const failed = results.filter(r => r.status === "FAIL").length;
const ok = results.filter(r => r.status === "OK").length;
console.log(`完成: ${ok} OK, ${results.filter(r => r.status === "SKIP").length} SKIP, ${failed} FAIL`);
process.exit(ok > 0 || results.length === 0 ? 0 : 1);
