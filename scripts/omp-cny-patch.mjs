#!/usr/bin/env bun
/**
 * omp CNY cost patch — status-line cost segment `$` -> ¥ (CNY, USD×rate).
 *
 * omp 18.x ships as a standalone native executable (`omp.exe`) with the whole
 * JS bundle embedded in the binary — there is no `dist/cli.js` to patch and no
 * bun shim/wrapper to install. The bundle is loaded by absolute offsets, so the
 * ONLY safe edit is a strictly same-length byte replacement: any length change
 * (even +1 byte) shifts the embedded blobs and the exe falls back to the bun
 * REPL instead of launching omp.
 *
 * This patch rewrites three code fragments in the embedded bundle, in place, to
 * exactly the same byte length:
 *
 *   1. `Rno()` — the cost formatter. Original emits `$<usd>` / `S<usd>`.
 *      Patched emits `¥<usd×rate>` with rate 7.25 (and keeps the `nerd`
 *      subscription-icon branch).
 *
 *   2. `Saa` — the `id:"cost"` status segment. Patched adds a
 *      `freeProviders` check: when the active model's provider is a
 *      subscription provider (default `volcengine-coding`), the segment shows
 *      `coding plan` instead of a token price and suppresses the advisor tail
 *      (the subscription is already paid; a ¥ token bill would mislead).
 *
 *   3. `xaa` — the `id:"context_pct"` status segment. Patched drops the
 *      `xx.x%/window` double figure (the raw context-window size) and keeps
 *      only the usage percent plus the auto-compact spinner. Same information
 *      about the peak usage. The percent is an integer right-aligned to a
 *      fixed 4-column field (`  0%`..`100%`) so the segment never changes
 *      width.
 *
 * Rate / freeProviders are compiled in at patch time from
 * `~/.omp/agent/cost.json` (the patch script can read files; the runtime
 * bundle cannot), so cost.json stays the single source of truth:
 *   { "symbol": "¥", "rate": 7.25, "freeProviders": ["volcengine-coding"] }
 * If cost.json is absent/unreadable the patch falls back to ¥ / 7.25 /
 * ["volcengine-coding"], which are also the repo defaults.
 *
 * Peak/offpeak per-model pricing (17.x-era, driven by a per-message token walk)
 * is intentionally NOT carried over: 18.x computes `usageStats.cost` natively
 * from provider pricing, and the same-length constraint leaves no room for the
 * ~1.5KB helper block the old approach injected. The visible outcome — a ¥ cost
 * in the status bar — is preserved.
 *
 * Usage:
 *   bun omp-cny-patch.mjs          # patch once (same-length, in place)
 *   bun omp-cny-patch.mjs --check  # idempotent self-heal (re-patch if upgraded)
 *   bun omp-cny-patch.mjs --setup  # ensure patched + self-install to ~/.omp
 *   bun omp-cny-patch.mjs --restore# restore pristine omp.exe from .orig
 *
 * The first patch backs up the pristine exe to `omp.exe.orig` so `--restore`
 * can put it back. `omp update` replaces the exe; the patch is lost and the
 * next `--check`/`--setup` re-applies it (setup.ps1 runs --setup on deploy).
 *
 * Verified against: omp 18.0.1 (win32-x64 native exe, embedded bundle)
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, renameSync, mkdirSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = homedir();
const PATCH_SCRIPT = join(HOME, ".omp", "omp-cny-patch.mjs");
const LOG_FILE = join(HOME, ".omp", "logs", "omp-cny-patch.log");
const COST_CFG = join(HOME, ".omp", "agent", "cost.json");

// Defaults used when cost.json is missing or unreadable (also repo defaults).
const DEFAULT_RATE = 7.25;
const DEFAULT_FREE = ["volcengine-coding"];

let _ompExe = null;
function resolveOmpExe() {
	if (_ompExe) return _ompExe;
	if (process.env.CNY_PATCH_TARGET && existsSync(process.env.CNY_PATCH_TARGET)) {
		return (_ompExe = process.env.CNY_PATCH_TARGET);
	}
	const cands = [];
	if (process.env.BUN_INSTALL) cands.push(join(process.env.BUN_INSTALL, "bin", "omp.exe"));
	cands.push(join(HOME, ".bun", "bin", "omp.exe"));
	for (const c of cands) {
		if (existsSync(c)) return (_ompExe = c);
	}
	try {
		const out = execFileSync("where.exe", ["omp"], { encoding: "utf8" });
		const exe = out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s && /omp\.exe$/i.test(s));
		if (exe && existsSync(exe)) return (_ompExe = exe);
	} catch {}
	fail(
		`omp.exe not found: tried ${cands.join(", ")}, then \`where omp\`. ` +
			"Install omp 18.x (standalone binary) first — this patch targets the native exe, not the 17.x bun package."
	);
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

/**
 * Same-length replacement body for `Rno()`. `e` = USD cost, `t` = isOAuth,
 * `s` = theme. Emits `¥<usd×rate>`; nerd preset keeps the subscription icon.
 */
function buildRnoReplacement(rate) {
	// rate is baked in at patch time. rate 7.25 -> "7.25" (4 chars).
	// Keep the body ≤ target length; the caller pads to byte-exact length.
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

/**
 * Same-length replacement for the `context_pct` segment (xaa). Drops the
 * `xx.x%/window` double figure — only the usage percent stays, plus the
 * auto-compact spinner. The percent is an integer right-aligned to a fixed
 * 4-column field (`  0%`..`100%`), so the segment never changes width.
 */
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

/**
 * Same-length replacement for the `id:"cost"` segment (Saa). Adds a
 * freeProviders check so subscription providers show "coding plan".
 * `free` is baked in as a JS array literal.
 */
function buildSegmentReplacement(free) {
	const list = "[" + free.map((p) => JSON.stringify(p)).join(",") + "]";
	// The fp expression: r.model?.provider is one of the free providers.
	// list len varies; build the check expression accordingly.
	// For a single provider (common case) use ===; for multiple use indexOf.
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
	// Compact: reduce 6-space indents to 4 where needed so the body fits the
	// 969-byte slot (padTo tops it up to the exact byte length).
	let text = lines;
	while (Buffer.byteLength(text, "utf8") > 969) {
		const rep = text.replace(/\n      (?=\S)/, "\n    ");
		if (rep === text) break;
		text = rep;
	}
	return Buffer.from(text, "utf8");
}

/** Pad `buf` to exactly `target` bytes with a trailing `/* ... *​/` comment. */
function padTo(buf, target) {
	if (buf.length === target) return buf;
	if (buf.length > target) fail(`replacement too large (${buf.length} > ${target}) — patch needs updating`);
	const under = target - buf.length;
	if (under < 4) fail(`no room to pad replacement (${buf.length} vs ${target})`);
	// insert the padding comment right before the final newline
	const lastNl = buf.lastIndexOf(10 /* \n */);
	if (lastNl === -1) fail("replacement has no trailing newline — cannot pad");
	const prefix = buf.subarray(0, lastNl);
	const comment = Buffer.from("/*" + " ".repeat(under - 4) + "*/" + "\n", "utf8");
	const padded = Buffer.concat([prefix, comment]);
	if (padded.length !== target) fail(`pad mismatch (${padded.length} vs ${target})`);
	return padded;
}

/** True if the exe already carries the CNY patch markers. */
function isPatched(buf) {
	// Rno patched: has the CNY body.
	const rnoMark =
		buf.indexOf(Buffer.from("const n=(e*7.25).toFixed(2);", "utf8")) !== -1 ||
		buf.indexOf(Buffer.from("(e*7.25).toFixed(2)", "utf8")) !== -1;
	// context_pct patched: fixed-width percent-only body.
	const ctxMark =
		buf.indexOf(Buffer.from("String(Math.round(t ?? 0)).padStart(3)}%`", "utf8")) !== -1;
	return rnoMark && ctxMark;
}

function patchOmpExe(ompExe) {
	let buf = readFileSync(ompExe);
	if (isPatched(buf)) {
		log(`already patched — nothing to do (${ompExe})`);
		return false;
	}
	const pristineSize = buf.length;
	ensureBackup(ompExe);

	const { rate, free } = loadCostCfg();
	log(`cost config: rate=${rate} freeProviders=[${free.join(", ")}]`);

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
	replaceExe(ompExe, buf);
	log(`patched ${ompExe} (${buf.length} bytes)`);
	return true;
}

/**
 * Replace omp.exe on Windows even while it is running. A running exe cannot be
 * opened for writing (EBUSY), but NTFS allows RENAMING a running image aside.
 * So: stage the patched bytes at `omp.exe.cny` (never locked), then swap:
 *   rename(current running exe -> .cny.old)   // rename of a running image works
 *   rename(.cny -> exe)                        // fresh name, not locked
 * If the exe is NOT currently locked, this still works via the same path.
 */
function replaceExe(ompExe, bytes) {
	const staged = ompExe + ".cny";
	const old = ompExe + ".cny.old";
	writeFileSync(staged, bytes); // stage; staged name is never a running image

	// best-effort clean of a previous failed swap
	try { if (existsSync(old)) rmSync(old); } catch {}

	// swap: move current exe aside, then move staged into place
	renameSync(ompExe, old); // works even if omp.exe is currently running
	renameSync(staged, ompExe);
	try { if (existsSync(old)) rmSync(old); } catch {}
}

function ensureBackup(ompExe) {
	const orig = ompExe + ".orig";
	if (!existsSync(orig)) {
		copyFileSync(ompExe, orig);
		log(`pristine backup saved → ${orig}`);
	}
}

function restore(ompExe) {
	const orig = ompExe + ".orig";
	if (!existsSync(orig)) {
		log(`no pristine backup (${orig}) — nothing to restore`);
		return;
	}
	const pristine = readFileSync(orig);
	if (pristine.length !== readFileSync(ompExe).length && !isPatched(readFileSync(ompExe))) {
		log("WARN: current omp.exe differs from backup and is not patched — leaving as-is (likely an omp upgrade)");
		return;
	}
	replaceExe(ompExe, pristine);
	log(`restored pristine ${ompExe} from ${orig}`);
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

/** Best-effort sweep of leftover swap artifacts (a previous swap's `.cny.old`,
 *  locked by a still-running omp, is skipped until that process exits). */
function sweepStale(ompExe) {
	for (const f of [ompExe + ".cny.old", ompExe + ".cny"]) {
		try {
			if (existsSync(f)) rmSync(f);
		} catch {}
	}
}

const arg = process.argv[2];
const ompExe = resolveOmpExe();

if (arg === "--restore") {
	restore(ompExe);
} else {
	ensureSelfInstalled();
	sweepStale(ompExe);
	ensureBackup(ompExe);
	patchOmpExe(ompExe);
}
