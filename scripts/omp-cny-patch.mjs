#!/usr/bin/env bun
/**
 * omp CNY cost patch — status-line cost segment `$` -> ¥ (CNY, USD×rate),
 * with `coding plan` for subscription providers.
 *
 * Layouts supported:
 *
 *   A) omp 18.0.1-era standalone native exe (win32-x64): the whole JS bundle
 *      is embedded in `omp.exe`; the ONLY safe edit is a strictly same-length
 *      byte replacement (any length change shifts embedded blob offsets and
 *      the exe falls back to the bun REPL). The cost formatter (`Rno`) and
 *      the `id:"cost"` segment are patched as same-length byte swaps.
 *
 *   B) omp 18.0.2+ bun global package (current): `omp.exe` is a small bun
 *      shim launcher that reads `omp.bunx` and runs `dist/cli.js` (plain JS)
 *      from the global node_modules. No length constraint — runtime helpers
 *      are injected at the bundle head and three sites are string-replaced.
 *      `omp update` rewrites dist/cli.js, so the optional `omp.cmd` wrapper
 *      re-runs `--check` before every launch to self-heal after upgrades.
 *
 * The sites rewritten (both layouts):
 *
 *   1. Cost formatter (`Rno` in the exe, `xEs` in the bundle): emits
 *      `¥<usd×rate>` instead of `$<usd>` / `S<usd>`.
 *
 *   2. `id:"cost"` status segment: adds a `freeProviders` check — when the
 *      active model's provider is a subscription provider (default
 *      `volcengine-coding`), the segment shows `coding plan` instead of a
 *      token price and suppresses the advisor tail.
 *
 *   3. `id:"context_pct"` status segment: drops the `xx.x%/window` double
 *      figure and keeps only the usage percent plus the auto-compact spinner.
 *      The percent is an integer right-aligned to a fixed 4-column field
 *      (`  0%`..`100%`) so the segment never changes width.
 *
 * Rate / freeProviders come from `~/.omp/agent/cost.json` (single source of
 * truth):
 *   { "symbol": "¥", "rate": 7.25, "freeProviders": ["volcengine-coding"] }
 * Missing/unreadable config falls back to ¥ / 7.25 / ["volcengine-coding"].
 *
 * Usage:
 *   bun omp-cny-patch.mjs           # patch once (idempotent)
 *   bun omp-cny-patch.mjs --check   # idempotent self-heal (wrapper runs this)
 *   bun omp-cny-patch.mjs --setup   # ensure patched + install launch wrapper
 *   bun omp-cny-patch.mjs --restore # restore pristine from .orig
 *
 * First patch backs up the pristine target to `<target>.orig`; `--restore`
 * puts it back.
 *
 * Verified against: omp 18.0.3 (bun global package, plain-JS bundle)
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, mkdirSync, appendFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const PATCH_SCRIPT = join(HOME, ".omp", "omp-cny-patch.mjs");
const LOG_FILE = join(HOME, ".omp", "logs", "omp-cny-patch.log");
const COST_CFG = join(HOME, ".omp", "agent", "cost.json");

// bun global package (layout B) — target bundle + launcher artifacts
const PKG_DIR = join(HOME, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const BUNDLE = join(PKG_DIR, "dist", "cli.js");
const BIN_DIR = join(HOME, ".bun", "bin");
const OMP_EXE = join(BIN_DIR, "omp.exe");
const WRAPPER = join(BIN_DIR, "omp.cmd");
const SHIM_BAK = join(BIN_DIR, "omp.exe.bak");

// Defaults used when cost.json is missing or unreadable (also repo defaults).
const DEFAULT_RATE = 7.25;
const DEFAULT_FREE = ["volcengine-coding"];

let _target = null;
/**
 * Resolve the patch target. Prefers the plain-JS bundle (layout B, the
 * current omp); falls back to the embedded-exe (layout A, omp 18.0.1).
 * CNY_PATCH_TARGET overrides for testing.
 */
function resolveTarget() {
	if (_target) return _target;
	if (process.env.CNY_PATCH_TARGET && existsSync(process.env.CNY_PATCH_TARGET)) {
		return (_target = { kind: "bundle", path: process.env.CNY_PATCH_TARGET, orig: process.env.CNY_PATCH_TARGET + ".orig" });
	}
	// Layout B: bun global package bundle
	if (existsSync(BUNDLE)) {
		return (_target = { kind: "bundle", path: BUNDLE, orig: BUNDLE + ".orig" });
	}
	// Layout A: embedded-exe
	if (existsSync(OMP_EXE) && statSize(OMP_EXE) > 100000) {
		return (_target = { kind: "exe", path: OMP_EXE, orig: OMP_EXE + ".orig" });
	}
	// Final fallback: a bare `omp` on PATH that is a large native exe
	try {
		const out = execFileSync("where.exe", ["omp"], { encoding: "utf8" });
		const exe = out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s && /omp\.exe$/i.test(s));
		if (exe && existsSync(exe) && statSize(exe) > 100000) {
			return (_target = { kind: "exe", path: exe, orig: exe + ".orig" });
		}
	} catch {}
	fail(
		`no patch target found: tried bundle ${BUNDLE}, native exe ${OMP_EXE}, then \`where omp\`. ` +
			"Install omp 18.x first (standalone exe or bun global package)."
	);
}

function statSize(p) {
	try {
		return statSync(p).size;
	} catch {
		return 0;
	}
}

function log(msg) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
	} catch {}
	console.error(`[omp-cny-patch] ${msg}`);
}

function fail(msg) {
	log(`FAIL: ${msg}`);
	process.exit(1);
}

/** Read rate + freeProviders from cost.json; fall back to defaults. */
function loadCostCfg() {
	try {
		const cfg = JSON.parse(readFileSync(COST_CFG, "utf8"));
		const rate = typeof cfg.rate === "number" && cfg.rate > 0 ? cfg.rate : DEFAULT_RATE;
		const free = Array.isArray(cfg.freeProviders) && cfg.freeProviders.length > 0 ? cfg.freeProviders : DEFAULT_FREE;
		return { rate, free };
	} catch {
		return { rate: DEFAULT_RATE, free: DEFAULT_FREE };
	}
}

/* ------------------------------------------------------------------ */
/* Layout A: same-length byte replacement on the embedded exe bundle.  */
/* ------------------------------------------------------------------ */

/** Same-length replacement body for `Rno()`. `e` = USD cost, `t` = isOAuth,
 *  `s` = theme. Emits `¥<usd×rate>`; nerd preset keeps the subscription icon. */
function buildRnoReplacement(rate) {
	const r = String(rate);
	const body =
		"function Rno(e,t,s){const n=(e*" + r + ").toFixed(2);\n" +
		"if(!t)return`\\u00a5${n}`;\n" +
		"if(s.getSymbolPreset()===\"nerd\"){\n" +
		"const o=s.icon.subscription;\n" +
		"return o?`${o} ${n}`:`\\u00a5${n}`}\n" +
		"return`\\u00a5${n}`}\n";
	return Buffer.from(body, "utf8");
}

/** Same-length replacement for the `id:"cost"` segment (Saa). Adds a
 *  freeProviders check so subscription providers show "coding plan". */
function buildSegmentReplacement(free) {
	const list = "[" + free.map((p) => JSON.stringify(p)).join(",") + "]";
	const fpExpr =
		free.length === 1
			? 'r.model?.provider==="' + free[0] + '"'
			: list + '.indexOf(r.model?.provider)>=0';
	const lines = [
		"Saa = {",
		'    id: "cost",',
		'    render(e) {',
		"      const { cost: t, premiumRequests: s } = e.usageStats;",
		"      const n = e.session.getAdvisorCost?.() ?? 0;",
		"      const o = iaa(s);",
		"      const r = e.session.state;",
		"      const i = r.model ? e.session.modelRegistry?.isUsingOAuth(r.model) ?? false : false;",
		"      const a = e.session.isAdvisorUsingSubscription?.() ?? false;",
		"      const fp = " + fpExpr + ";",
		'      if (!t && !n && !i && !o && !fp) return { content: "", visible: false };',
		"      const l = [];",
		'      if (fp) l.push("coding plan");',
		"      else if (t) l.push(Rno(t, i, k));",
		'      else if (i) l.push(k.getSymbolPreset() === "nerd" && k.icon.subscription ? k.icon.subscription : "(sub)");',
		"      if (o) l.push(`\\u2605 ${Pe(o)}`);",
		'      if (n && !fp) l.push((l.length?"+ ":"")+aaa(n, a, k));',
		'      if (l.length === 0) return { content: "", visible: false };',
		'      return { content: k.fg("statusLineCost", l.join(" ")), visible: true };',
		"    }",
		"  };",
		"  ",
	].join("\n");
	let text = lines;
	while (Buffer.byteLength(text, "utf8") > 969) {
		const rep = text.replace(/\n      (?=\S)/, "\n    ");
		if (rep === text) break;
		text = rep;
	}
	return Buffer.from(text, "utf8");
}

/** Same-length replacement for the `context_pct` segment (xaa). */
function buildContextReplacement() {
	const body =
		'xaa = {\n' +
		'    id: "context_pct",\n' +
		'    render(e) {\n' +
		"      const t = e.contextPercent;\n" +
		"      const n = kNe(bNe(t ?? 0, e.contextWindow));\n" +
		'      let o = "";\n' +
		"      if (e.autoCompactEnabled && k.icon.auto) {\n" +
		"        const a = e.compactionSpeculation;\n" +
		'        const l = a === "running" ? e.speculationBlinkOn ? "accent" : "muted" : a === "armed" ? "accent" : n;\n' +
		"        o = ` ${k.fg(l, k.icon.auto)}`;\n" +
		"      }\n" +
		'      const r = k.fg(n, `${String(Math.round(t ?? 0)).padStart(3)}%`);\n' +
		"      const i = vc(k.icon.context, r + o);\n" +
		"      return { content: i, visible: true };\n" +
		"    }\n" +
		"  };\n";
	return Buffer.from(body, "utf8");
}

/** Pad `buf` to exactly `target` bytes with a trailing `/* ... *​/` comment. */
function padTo(buf, target) {
	if (buf.length === target) return buf;
	if (buf.length > target) fail(`replacement too large (${buf.length} > ${target}) — patch needs updating`);
	const under = target - buf.length;
	if (under < 4) fail(`no room to pad replacement (${buf.length} vs ${target})`);
	const lastNl = buf.lastIndexOf(10 /* \n */);
	if (lastNl === -1) fail("replacement has no trailing newline — cannot pad");
	const prefix = buf.subarray(0, lastNl);
	const comment = Buffer.from("/*" + " ".repeat(under - 4) + "*/" + "\n", "utf8");
	const padded = Buffer.concat([prefix, comment]);
	if (padded.length !== target) fail(`pad mismatch (${padded.length} vs ${target})`);
	return padded;
}

/** True if the exe already carries the CNY patch markers (layout A). */
function isExePatched(buf) {
	const rnoMark =
		buf.indexOf(Buffer.from("const n=(e*7.25).toFixed(2);", "utf8")) !== -1 ||
		buf.indexOf(Buffer.from("(e*7.25).toFixed(2)", "utf8")) !== -1;
	const ctxMark =
		buf.indexOf(Buffer.from("String(Math.round(t ?? 0)).padStart(3)}%`", "utf8")) !== -1;
	return rnoMark && ctxMark;
}

function patchExe(ompExe, rate, free) {
	let buf = readFileSync(ompExe);
	if (isExePatched(buf)) {
		log(`already patched — nothing to do (${ompExe})`);
		return null;
	}
	const pristineSize = buf.length;

	// --- Patch 1: Rno (¥ formatter) ---
	const rnoAnchor = Buffer.from("function Rno(e, t, s) {");
	const aaaAnchor = Buffer.from("function aaa(e, t, s) {");
	const ri = buf.indexOf(rnoAnchor);
	const ai = ri === -1 ? -1 : buf.indexOf(aaaAnchor, ri);
	if (ri === -1 || ai === -1) fail("Rno anchor not found — 18.x bundle drifted; patch needs updating");
	const rnoOrig = buf.subarray(ri, ai);
	const rnoRepl = padTo(buildRnoReplacement(rate), rnoOrig.length);
	buf = Buffer.concat([buf.subarray(0, ri), rnoRepl, buf.subarray(ai)]);
	log(`patched Rno() cost formatter (${rnoOrig.length} bytes, same-length)`);

	// --- Patch 2: cost segment (Saa) freeProviders ---
	const sa = buf.indexOf(Buffer.from("Saa = {"));
	const xa = sa === -1 ? -1 : buf.indexOf(Buffer.from("xaa = {"));
	if (sa === -1 || xa === -1) fail("cost segment (Saa) not found — 18.x bundle drifted; patch needs updating");
	const segOrig = buf.subarray(sa, xa);
	const segRepl = padTo(buildSegmentReplacement(free), segOrig.length);
	buf = Buffer.concat([buf.subarray(0, sa), segRepl, buf.subarray(xa)]);
	log(`patched cost segment (Saa) (${segOrig.length} bytes, same-length)`);

	// --- Patch 3: context_pct segment (xaa) — fixed-width percent ---
	const xc = buf.indexOf(Buffer.from("xaa = {"));
	const ec = xc === -1 ? -1 : buf.indexOf(Buffer.from("Eaa = {"));
	if (xc === -1 || ec === -1) fail("context_pct segment (xaa) not found — 18.x bundle drifted; patch needs updating");
	const ctxOrig = buf.subarray(xc, ec);
	const ctxRepl = padTo(buildContextReplacement(), ctxOrig.length);
	buf = Buffer.concat([buf.subarray(0, xc), ctxRepl, buf.subarray(ec)]);
	log(`patched context_pct segment (xaa) (${ctxOrig.length} bytes, same-length)`);

	if (buf.length !== pristineSize) fail("size changed after patch — aborting (must be same-length)");
	return buf;
}

/* ------------------------------------------------------------------ */
/* Layout B: plain-JS bundle — runtime helper injection + string swap. */
/* ------------------------------------------------------------------ */

/**
 * Runtime helpers injected at the bundle head. Read cost.json at runtime
 * (the render functions have no other way to reach it). `__cnySess` is set
 * by the cost segment render each tick so `__cnyIsFree` can inspect the
 * active model's provider without touching the render closure.
 */
const HELPERS = `import{readFileSync as __cnyRead}from"node:fs";
var __cnyCfgCache=void 0,__cnySess=void 0;
function __cnyCfg(){if(__cnyCfgCache!==void 0)return __cnyCfgCache;var b=process.env.PI_CODING_AGENT_DIR;var base=b?b:((process.env.USERPROFILE||process.env.HOME||"")+"/.omp/agent");var c=null;try{var t=__cnyRead(base+"/cost.json","utf8");c=JSON.parse(t)}catch(e){c=null}__cnyCfgCache=c;return c}
function __cnyFmt(v,c){var s=c&&c.symbol?c.symbol:"$";if(v<0.01)return s+v.toFixed(4);if(v<1)return s+v.toFixed(3);return s+v.toFixed(2)}
function __cnyAdvisor(v){var c=__cnyCfg();var r=c&&typeof c.rate==="number"?c.rate:1;return __cnyFmt(v*r,c)}
function __cnyIsFree(){var c=__cnyCfg();if(!c)return false;var f=c.freeProviders;if(!f||!f.length)return false;var m=null;try{m=(typeof __cnySess!=="undefined"&&__cnySess)?__cnySess.state&&__cnySess.state.model:null}catch(e){}if(!m||!m.provider)return false;return f.indexOf(m.provider)>=0}
`;

/** True if the bundle already carries the CNY patch markers (layout B). */
function isBundlePatched(src) {
	return src.includes("__cnyIsFree") && src.includes("__cnyFmt");
}

function patchBundle(bundle, rate, free) {
	let src = readFileSync(bundle, "utf8");
	if (isBundlePatched(src)) {
		log(`already patched — nothing to do (${bundle})`);
		return null;
	}

	if (!src.includes('id:"cost",render(')) fail("cost segment (`id:\"cost\",render(`) not found — 18.x bundle drifted; patch needs updating");
	if (!src.includes('id:"context_pct"')) fail("context_pct segment not found — 18.x bundle drifted; patch needs updating");

	// --- Inject helpers at head (after the `// @bun` marker) ---
	const at = src.indexOf("// @bun");
	if (at === -1) fail("unexpected bundle head (marker `// @bun` missing)");
	const nl = src.indexOf("\n", at);
	const injectAt = nl === -1 ? src.length : nl + 1;
	src = src.slice(0, injectAt) + HELPERS + src.slice(injectAt);

	// --- Rewrite cost formatter xEs ---
	const xEsOld = 'function xEs(e,t,n){let s=e.toFixed(2);if(!t)return`$${s}`;if(n.getSymbolPreset()==="nerd"){let o=n.icon.subscription;return o?`${o} ${s}`:`S${s}`}return`S${s}`}';
	if (!src.includes(xEsOld)) fail("xEs formatter pattern not matched — 18.x bundle drifted; patch needs updating");
	src = src.replace(
		xEsOld,
		'function xEs(e,t,n){let s=e.toFixed(2),c=__cnyCfg(),r=c&&typeof c.rate==="number"?c.rate:1,v=Number(s)*r,f=__cnyFmt(v,c);if(!t)return f;if(n.getSymbolPreset()==="nerd"){let o=n.icon.subscription;return o?`${o} ${f}`:f}return f}'
	);

	// --- Rewrite cost segment: freeProviders check ---
	const costOld =
		'a=e.session.isAdvisorUsingSubscription?.()??!1;if(!t&&!s&&!i&&!o)return{content:"",visible:!1};let l=[];if(t)l.push(xEs(t,i,S));else if(i)l.push(S.getSymbolPreset()==="nerd"&&S.icon.subscription?S.icon.subscription:"(sub)");if(o)l.push(`\\u2605 ${Ae(o)}`);if(s){let u=l.length?"+ ":"";l.push(`${u}${C_i(s,a,S)}`)}';
	if (!src.includes(costOld)) fail("cost segment render pattern not matched — 18.x bundle drifted; patch needs updating");
	src = src.replace(
		costOld,
		'a=e.session.isAdvisorUsingSubscription?.()??!1;__cnySess=e.session;let fp=__cnyIsFree();if(fp)return{content:S.fg("statusLineCost","coding plan"),visible:!0};if(!t&&!s&&!i&&!o)return{content:"",visible:!1};let l=[];if(t)l.push(xEs(t,i,S));else if(i)l.push(S.getSymbolPreset()==="nerd"&&S.icon.subscription?S.icon.subscription:"(sub)");if(o)l.push(`\\u2605 ${Ae(o)}`);if(s){let u=l.length?"+ ":"";l.push(`${u}${C_i(s,a,S)}`)}'
	);

	// --- Rewrite context_pct: fixed-width percent ---
	const ctxOld = 'let r=S.fg(s,XE(t,n,e.contextTokens));return{content:zl(S.icon.context,`${r}${o}`),visible:!0}';
	if (!src.includes(ctxOld)) fail("context_pct render pattern not matched — 18.x bundle drifted; patch needs updating");
	src = src.replace(
		ctxOld,
		'let pct=Math.round((t??0));let r=S.fg(s,`${String(pct).padStart(3)}%`);return{content:zl(S.icon.context,`${r}${o}`),visible:!0}'
	);

	// Post-write sanity
	if (src.split('id:"cost",render(').length !== 2 || !src.includes("__cnyIsFree")) {
		fail("sanity check failed after patching — bundle left unchanged, please report");
	}
	return src;
}

/* ------------------------------------------------------------------ */
/* Shared file plumbing.                                               */
/* ------------------------------------------------------------------ */

/**
 * Replace a target file on Windows even while it is running. A running image
 * cannot be opened for writing (EBUSY), but NTFS allows RENAMING it aside.
 * Stage the patched bytes at `<target>.cny` (never locked), then swap:
 *   rename(current -> .cny.old)   // rename of a running image works
 *   rename(.cny -> current)        // fresh name, not locked
 */
function replaceFile(target, bytes) {
	const staged = target + ".cny";
	const old = target + ".cny.old";
	writeFileSync(staged, bytes);
	try {
		if (existsSync(old)) rmSync(old);
	} catch {}
	renameSync(target, old);
	renameSync(staged, target);
	try {
		if (existsSync(old)) rmSync(old);
	} catch {}
}

function ensureBackup(target, orig) {
	if (!existsSync(orig)) {
		copyFileSync(target, orig);
		log(`pristine backup saved → ${orig}`);
	}
}

/** Best-effort sweep of leftover swap artifacts. */
function sweepStale(target) {
	for (const f of [target + ".cny.old", target + ".cny"]) {
		try {
			if (existsSync(f)) rmSync(f);
		} catch {}
	}
}

/* ------------------------------------------------------------------ */
/* Wrapper (layout B): self-heal on every launch.                      */
/* ------------------------------------------------------------------ */

/**
 * Layout B wrapper: `omp` resolves to omp.cmd, which runs `--check` (self-heal
 * after an upgrade rewrites dist/cli.js) then executes the real bundle.
 * The bun `omp.exe` shim is renamed aside (it wins PATHEXT over .cmd).
 * A still-running shim cannot be deleted, but CAN be renamed on NTFS.
 */
function setupWrapper() {
	if (existsSync(OMP_EXE) && statSize(OMP_EXE) <= 100000) {
		try {
			if (existsSync(SHIM_BAK)) rmSync(SHIM_BAK);
		} catch {}
		try {
			renameSync(OMP_EXE, SHIM_BAK);
			log(`renamed bun shim ${OMP_EXE} → ${SHIM_BAK} (wrapper takes over)`);
		} catch {
			log(`WARN: could not rename running shim ${OMP_EXE} — wrapper will be shadowed until omp exits and setup is re-run`);
		}
	}
	const body =
		"@echo off\r\n" +
		`bun "${PATCH_SCRIPT.replaceAll("/", "\\")}" --check >nul 2>&1\r\n` +
		`bun "%USERPROFILE%\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n`;
	writeFileSync(WRAPPER, body, "utf8");
	log(`wrapper ready: ${WRAPPER}`);
}

/** Undo the wrapper: put the shim back, remove omp.cmd. */
function teardownWrapper() {
	try {
		if (existsSync(WRAPPER)) {
			rmSync(WRAPPER);
			log(`removed wrapper ${WRAPPER}`);
		}
	} catch {}
	if (existsSync(SHIM_BAK) && !existsSync(OMP_EXE)) {
		try {
			renameSync(SHIM_BAK, OMP_EXE);
			log(`restored bun shim ${OMP_EXE} from ${SHIM_BAK}`);
		} catch {
			log(`WARN: could not restore shim ${OMP_EXE} from ${SHIM_BAK}`);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Entry points.                                                       */
/* ------------------------------------------------------------------ */

function restore() {
	const t = resolveTarget();
	if (existsSync(t.orig)) {
		replaceFile(t.path, readFileSync(t.orig));
		log(`restored pristine ${t.path} from ${t.orig}`);
	} else {
		log(`no pristine backup (${t.orig}) — nothing to restore`);
	}
	if (t.kind === "bundle") teardownWrapper();
}

/** Self-install to ~/.omp/omp-cny-patch.mjs (setup runs from a repo checkout). */
function ensureSelfInstalled() {
	const here = process.argv[1];
	if (!here || here === PATCH_SCRIPT) return;
	try {
		if (existsSync(PATCH_SCRIPT) && readFileSync(PATCH_SCRIPT, "utf8") === readFileSync(here, "utf8")) return;
		mkdirSync(dirname(PATCH_SCRIPT), { recursive: true });
		copyFileSync(here, PATCH_SCRIPT);
		log(`installed patch script → ${PATCH_SCRIPT}`);
	} catch (e) {
		fail(`cannot install patch script to ${PATCH_SCRIPT}: ${e.code || e.message}`);
	}
}

const arg = process.argv[2];

if (arg === "--restore") {
	restore();
} else {
	ensureSelfInstalled();
	const target = resolveTarget();
	sweepStale(target.path);
	ensureBackup(target.path, target.orig);

	const { rate, free } = loadCostCfg();
	log(`cost config: rate=${rate} freeProviders=[${free.join(", ")}] target=${target.kind}`);

	let out = null;
	if (target.kind === "bundle") {
		out = patchBundle(target.path, rate, free);
		if (out !== null) {
			writeFileSync(target.path, out, "utf8");
			log(`patched ${target.path} (${Buffer.byteLength(out, "utf8")} bytes)`);
		}
		if (arg === "--setup") setupWrapper();
	} else {
		const bytes = patchExe(target.path, rate, free);
		if (bytes) {
			replaceFile(target.path, bytes);
			log(`patched ${target.path} (${bytes.length} bytes)`);
		}
	}
	log("done");
}
