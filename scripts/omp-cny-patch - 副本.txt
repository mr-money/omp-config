#!/usr/bin/env bun
/**
 * omp CNY cost patch — status-line cost segment `$` -> ¥ (CNY, USD×rate),
 * with `coding plan` for subscription providers.
 *
 * Target: omp 18.0.2+ bun global package (current). `omp.exe` is a small bun
 * shim launcher that reads `omp.bunx` and runs `dist/cli.js` (plain JS)
 * from the global node_modules. No length constraint — runtime helpers are
 * injected at the bundle head and three sites are string-replaced.
 * `omp update` rewrites dist/cli.js AND its `bun install -g` recreates the
 * `~/.bun/bin/omp.exe` shim - which shadows `omp.cmd` (PATHEXT puts .EXE
 * before .CMD). The optional `omp.cmd` wrapper therefore (a) runs `--check`
 * before every launch to re-patch a rewritten bundle, and (b) re-renames a
 * recreated `omp.exe` shim aside first, so the self-heal survives upgrades.
 *
 * The sites rewritten:
 *
 *   1. Cost formatter (`xEs`): emits `¥<usd×rate>` instead of `$<usd>` /
 *      `S<usd>`.
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
 * Version gate: omp below 18.0.2 is not supported (the 18.0.1 embedded-exe
 * layout is NOT patched). If the installed bun package is older, the script
 * first runs `bun dist/cli.js update` (the bundle's own non-interactive
 * update, never the `omp` alias - that would recurse into this --check;
 * 60s timeout so a hung network cannot block every launch) to bring omp up
 * to a compatible version, then patches, refreshes the pristine `.orig`
 * backup and re-secures the wrapper. A failed upgrade is logged and
 * patching continues; the anchor checks decide whether the current bundle
 * still patches.
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

// bun global package — target bundle + launcher artifacts
const PKG_DIR = join(HOME, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent");
const BUNDLE = join(PKG_DIR, "dist", "cli.js");
const BUNDLE_PKG = join(PKG_DIR, "package.json");
const BIN_DIR = join(HOME, ".bun", "bin");
const OMP_EXE = join(BIN_DIR, "omp.exe");
const WRAPPER = join(BIN_DIR, "omp.cmd");
const SHIM_BAK = join(BIN_DIR, "omp.exe.bak");

// Defaults used when cost.json is missing or unreadable (also repo defaults).
const DEFAULT_RATE = 7.25;
const DEFAULT_FREE = ["volcengine-coding"];

// Layout B floor: omp below this is not supported and gets upgraded first.
const MIN_BUNDLE_VER = [18, 0, 2];

let _target = null;
/**
 * Resolve the patch target: the bun global package bundle (layout B).
 * CNY_PATCH_TARGET overrides for testing.
 */
function resolveTarget() {
	if (_target) return _target;
	if (process.env.CNY_PATCH_TARGET && existsSync(process.env.CNY_PATCH_TARGET)) {
		return (_target = { kind: "bundle", path: process.env.CNY_PATCH_TARGET, orig: process.env.CNY_PATCH_TARGET + ".orig" });
	}
	if (existsSync(BUNDLE)) {
		return (_target = { kind: "bundle", path: BUNDLE, orig: BUNDLE + ".orig" });
	}
	fail(
		`no patch target found: tried bundle ${BUNDLE}. ` +
			"Install omp 18.0.2+ as a bun global package first (curl -fsSL https://omp.sh/install | sh)."
	);
}

/** Parse `x.y.z` into a numeric array; NaN parts become 0. */
function parseVersion(v) {
	return String(v || "")
		.split(".")
		.map((s) => parseInt(s, 10) || 0)
		.slice(0, 3);
}

/** -1 / 0 / 1: a before / equal / after b (arrays of 3 numbers). */
function cmpVersion(a, b) {
	for (let i = 0; i < 3; i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

/**
 * Version gate: read the installed bun package version from its package.json.
 * If it predates the 18.0.2 floor, run the bundle's own `update`
 * (non-interactive, 60s timeout so a hung network never blocks launches)
 * to self-upgrade, then re-read. Returns true when an update ran (caller
 * must refresh the `.orig` backup and re-secure the wrapper, because the
 * upgrade rewrote the bundle and `bun install -g` recreated the omp.exe
 * shim that shadows the omp.cmd wrapper). A failed upgrade does not abort:
 * the patch's anchor checks are the real compatibility test and will fail
 * loudly if the bundle still drifted.
 */
function ensureCompatibleBundleVersion() {
	if (process.env.CNY_PATCH_TARGET) return false; // test override: never trigger a real update
	const minStr = MIN_BUNDLE_VER.join(".");
	try {
		const pkg = JSON.parse(readFileSync(BUNDLE_PKG, "utf8"));
		const cur = parseVersion(pkg.version);
		if (cmpVersion(cur, MIN_BUNDLE_VER) >= 0) return false;
		log(`omp bundle ${pkg.version} < required ${minStr} - running \`bun ${BUNDLE} update\` first`);
		if (process.env.CNY_PATCH_DRYRUN) {
			log("CNY_PATCH_DRYRUN set - skipping the update (would have run `bun <bundle> update`)");
			return false;
		}
		const out = execFileSync(process.execPath, [BUNDLE, "update"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 60000,
		});
		log(`omp update output: ${out.trim().split(/\r?\n/)[0]}`);
		const again = JSON.parse(readFileSync(BUNDLE_PKG, "utf8"));
		log(`omp bundle now ${again.version}`);
		return true;
	} catch (e) {
		log(`WARN: version gate skipped (${e.code || e.message}) - patch anchors will verify compatibility`);
		return false;
	}
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
function __cnyIsFree(){var c=__cnyCfg();if(!c)return false;var f=c.freeProviders;if(!f||!f.length)return false;var m=null;try{m=(typeof __cnySess!=="undefined"&&__cnySess)?__cnySess.state&&__cnySess.state.model:null}catch(e){}if(!m||!m.provider)return false;return f.indexOf(m.provider)>=0}
`;

/** True if the bundle already carries the CNY patch markers. */
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
/* Wrapper: self-heal on every launch.                                 */
/* ------------------------------------------------------------------ */

/**
 * Wrapper: `omp` resolves to omp.cmd, which runs `--check` (self-heal after
 * an upgrade rewrites dist/cli.js) then executes the real bundle.
 * The bun `omp.exe` shim is renamed aside (it wins PATHEXT over .cmd);
 * `omp update` / `bun install -g` recreates it, so setupWrapper is also
 * re-run after any upgrade to reclaim the `omp` name.
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
		`bun "%USERPROFILE%\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n` +
		// `omp update` recreates the omp.exe shim (shadowing this wrapper on
		// the next launch) and rewrites the bundle (dropping the patch), so
		// after an update command exits, reclaim the `omp` name and re-patch.
		// Non-update commands skip the %1 match, so normal exits pay nothing.
		`if /I "%1"=="update" bun "${PATCH_SCRIPT.replaceAll("/", "\\")}" --setup >nul 2>&1\r\n`;
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
	teardownWrapper();
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
	const upgraded = ensureCompatibleBundleVersion();
	const target = resolveTarget();
	sweepStale(target.path);
	if (upgraded) {
		// The upgrade rewrote the bundle: the old `.orig` is now a stale
		// foreign-version backup (restoring it would downgrade the package),
		// so drop it - ensureBackup re-saves the new pristine below.
		try {
			if (existsSync(target.orig)) rmSync(target.orig);
		} catch {}
		// `bun install -g` recreated the omp.exe shim - take the `omp` name
		// back so the wrapper keeps running --check on every launch.
		if (existsSync(WRAPPER) || existsSync(SHIM_BAK)) setupWrapper();
	}
	ensureBackup(target.path, target.orig);

	const { rate, free } = loadCostCfg();
	log(`cost config: rate=${rate} freeProviders=[${free.join(", ")}] target=${target.kind}`);

	const out = patchBundle(target.path, rate, free);
	if (out !== null) {
		writeFileSync(target.path, out, "utf8");
		log(`patched ${target.path} (${Buffer.byteLength(out, "utf8")} bytes)`);
	}
	if (arg === "--setup") setupWrapper();
	log("done");
}
