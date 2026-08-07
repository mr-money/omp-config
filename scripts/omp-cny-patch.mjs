#!/usr/bin/env bun
/**
 * omp CNY cost patch — status-line `$` -> configurable symbol (default ¥).
 *
 * Also neutralizes the runtime bun-version floor check (see VERSION_CHECK_RE
 * below): bun 1.3.14 — the version omp pins as its floor — carries a known
 * segfault regression (type confusion when a top-level `await` resumes under an
 * active AsyncLocalStorage/OpenTelemetry context; fixed on bun main, no stable
 * release yet). omp refuses to start on the clean 1.3.13, so the floor check is
 * disabled and the machine is expected to run bun 1.3.13 until a fixed stable
 * bun ships. `--restore` puts the pristine bundle back and re-enables the check.
 *
 * Version-agnostic: locates the `id:"cost"` status segment structurally
 * (not by exact minified string), so it keeps working after pi-coding-agent
 * upgrades rewrite dist/cli.js. The omp.cmd wrapper runs `--check` on every
 * launch, so an upgrade is self-healed on the next `omp` invocation.
 *
 * Cost config: ~/.omp/agent/cost.json
 *   {
 *     "symbol": "¥",
 *     "rate": 7.25,
 *     "models": {
 *       "deepseek:deepseek-chat": { "input": 1, "output": 2, "cacheRead": 0.1, "cacheWrite": 1 }
 *     }
 *   }
 *
 * Keys accept "provider:model" (colon) or "provider/model" (slash).
 * Per message:
 * 1. exact per-model CNY price from `models` -> token-based CNY total
 * 2. else provider-computed USD cost (usage.cost.total) x rate
 * Advisor cost is always USD x rate. With no config file the original `$`
 * rendering is preserved unchanged.
 *
 * Usage:
 *   bun omp-cny-patch.mjs          # patch once
 *   bun omp-cny-patch.mjs --check  # idempotent self-heal (used by omp.cmd wrapper)
 *   bun omp-cny-patch.mjs --setup  # create ~/.bun/bin/omp.cmd wrapper (+ remove bun shims)
 *   bun omp-cny-patch.mjs --restore# restore original bundle, remove wrapper
 *
 * Fresh-machine safe: setup self-installs this script to ~/.omp/omp-cny-patch.mjs
 * (the wrapper calls back into it by absolute path), and bun.exe is resolved via
 * $BUN_INSTALL, then ~/.bun/bin, then `where bun` on PATH — so a bun installed
 * by winget/scoop/npm/portable zip still works. Shim removal is best-effort:
 * a shim locked by a running omp process is renamed aside, never fatal.
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	rmSync,
	renameSync,
	statSync,
	readdirSync,
	mkdirSync,
	appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const HOME = homedir();
// Respect a non-default bun location (official installer sets BUN_INSTALL);
// fall back to the default ~/.bun layout. Bun's global install dir always
// lives under $BUN_INSTALL, so BUNDLE and BIN_DIR follow the same base.
const BUN_INSTALL = process.env.BUN_INSTALL || join(HOME, ".bun");
const BUNDLE = join(BUN_INSTALL, "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
const ORIG = BUNDLE + ".orig";
const BIN_DIR = join(BUN_INSTALL, "bin");
const BUN_EXE = join(BIN_DIR, "bun.exe");
const WRAPPER = join(BIN_DIR, "omp.cmd");
const PATCH_SCRIPT = join(HOME, ".omp", "omp-cny-patch.mjs");
const LOG_FILE = join(HOME, ".omp", "logs", "omp-cny-patch.log");

/**
 * Resolve bun.exe: $BUN_INSTALL/bin/bun.exe, then default ~/.bun/bin/bun.exe,
 * then `where bun` on PATH (winget/scoop/npm/portable installs). Only an .exe
 * match is accepted — invoking a .cmd shim from inside a batch file without
 * `call` would swallow the rest of the wrapper.
 */
let _bunExe = null;
function resolveBunExe() {
	if (_bunExe) return _bunExe;
	if (existsSync(BUN_EXE)) return (_bunExe = BUN_EXE);
	try {
		const out = execFileSync("where.exe", ["bun"], { encoding: "utf8" });
		const exe = out
			.split(/\r?\n/)
			.map((s) => s.trim())
			.find((s) => s && /\.exe$/i.test(s));
		if (exe && existsSync(exe)) return (_bunExe = exe);
	} catch {}
	fail(
		`bun.exe not found: tried ${BUN_EXE}, then \`where bun\` on PATH. ` +
			"Install bun via the official installer (https://bun.sh) or set BUN_INSTALL to its location."
	);
}

/** Injected import + helpers. `__cnyCfgCache` caches the parsed config. */
const HELPERS = `import{readFileSync as __cnyRead}from"node:fs";
var __cnyCfgCache=void 0;
function __cnyCfg(){if(__cnyCfgCache!==void 0)return __cnyCfgCache;var b=process.env.PI_CODING_AGENT_DIR;var base=b?b:((process.env.USERPROFILE||process.env.HOME||"")+"/.omp/agent");var c=null;try{var t=__cnyRead(base+"/cost.json","utf8");c=JSON.parse(t)}catch(e){c=null}__cnyCfgCache=c;return c}
function __cnyFmt(v,c){var s=c&&c.symbol?c.symbol:"$";if(v<0.01)return s+v.toFixed(4);if(v<1)return s+v.toFixed(3);return s+v.toFixed(2)}
function __cnyAdvisor(v){var c=__cnyCfg();var r=c&&typeof c.rate==="number"?c.rate:1;return __cnyFmt(v*r,c)}
function __cnyCalc(n){var c=__cnyCfg();if(!c)return null;var sm=n.session.state.model;var cur=sm&&sm.provider&&sm.id?(sm.provider+"/"+sm.id):null;var total=0;var r=typeof c.rate==="number"?c.rate:1;var mo=c.models||{};var br=n.session.sessionManager&&n.session.sessionManager.getBranch?n.session.sessionManager.getBranch():null;if(br)for(var e of br){if(e&&e.type==="model_change"&&typeof e.model==="string"){cur=e.model}else if(e&&e.type==="message"&&e.message&&e.message.role==="assistant"){var u=e.message.usage;if(!u)continue;var k=cur?cur.replace("/",":"):"";var pr=mo[k]||mo[cur]||null;if(pr){total+=(u.input||0)/1e6*(pr.input||0)+(u.cacheRead||0)/1e6*(pr.cacheRead||0)+(u.cacheWrite||0)/1e6*(pr.cacheWrite||0)+(u.output||0)/1e6*(pr.output||0)}else{total+=(u.cost&&u.cost.total?u.cost.total:0)*r}}}return __cnyFmt(total,c)}`;

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

/**
 * Locate the cost status segment: `{id:"cost",render(n){...}}},`.
 * Bounded by the stable `id:"cost",render(` anchor and the `statusLineCost`
 * render tail — both survive minification; inner var names do not.
 */
function findCostSegment(src) {
	const i0 = src.indexOf('id:"cost",render(');
	if (i0 === -1) return null;
	const sc = src.indexOf("statusLineCost", i0);
	if (sc === -1) return null;
	const end = src.indexOf("}}},", sc);
	if (end === -1) return null;
	return [i0, end + 4];
}

/**
 * The CLI bootstrap exits when `Bun.semver.order(Bun.version, <min>) < 0`, where
 * `<min>` comes from the embedded package.json engines (currently >=1.3.14). Bun
 * 1.3.14 has a known segfault regression (top-level `await` resuming under an
 * active AsyncLocalStorage/OpenTelemetry context — type confusion; fixed on bun
 * main, unreleased as of 2026-08-07; 1.3.13 is clean), so the machine runs bun
 * 1.3.13 and this check is replaced with `!1` (dead code). The regex anchors on
 * the stable API call shape — inner minified var names may drift. Non-fatal: if
 * the pattern ever drifts out of recognition, the CNY patch still applies and
 * omp keeps its own floor.
 */
const VERSION_CHECK_RE = /Bun\.semver\.order\(Bun\.version,[A-Za-z_$][\w$]*\)<0/;
function hasVersionCheckBypass(src) {
	return !VERSION_CHECK_RE.test(src);
}

function patchBundle() {
	if (!existsSync(BUNDLE)) fail(`bundle not found: ${BUNDLE}`);
	let src = readFileSync(BUNDLE, "utf8");
	let pristine = false;

	const preSeg = findCostSegment(src);
	if (src.includes("__cnyCfg")) {
		const pre = preSeg ? src.slice(preSeg[0], preSeg[1]) : "";
		const ADVISOR_OK = /`\$\{[A-Za-z_$][\w$]*\.length\?"\+ ":""\}\$\{__cnyAdvisor\(/.test(pre);
		if (preSeg && ADVISOR_OK && pre.includes("__cnyCalc(n)") && hasVersionCheckBypass(src)) {
			log("already patched — nothing to do");
			return false;
		}
		log("stale patch detected — restoring pristine bundle from .orig, re-patching");
		if (!existsSync(ORIG)) fail("stale patch detected but no .orig backup to restore from");
		src = readFileSync(ORIG, "utf8");
	} else {
		pristine = true;
	}

	if (!src.includes("__cnyCfg")) {
		const at = src.indexOf("// @bun");
		if (at === -1) fail("unexpected bundle head (marker `// @bun` missing)");
		const nl = src.indexOf("\n", at);
		const injectAt = nl === -1 ? src.length : nl + 1;
		src = src.slice(0, injectAt) + HELPERS + src.slice(injectAt);
	}

	const seg = findCostSegment(src);
	if (!seg) fail('cost segment not found — bundle structure changed; patch needs updating');
	const [i0, i1] = seg;
	let s = src.slice(i0, i1);

	// usage cost push
	const usageRe = /if\(([A-Za-z_$][\w$]*)\)([A-Za-z_$][\w$]*)\.push\(`\$\$\{([A-Za-z_$][\w$]*)\.toFixed\(2\)\}`\);/;
	const um = s.match(usageRe);
	if (!um) fail('usage cost push pattern not matched — version drift');
	s = s.replace(usageRe, (_m, g1, g2, g3) =>
		'if(' + g1 + '){let __c=__cnyCalc(n);' + g2 + '.push(__c?__c:`$${' + g3 + '.toFixed(2)}`)}'
	);

	// advisor push
	const arr = um[2];
	const advRe = new RegExp(
		'([A-Za-z_$][\\w$]*)\\.push\\(`\\$\\{' + arr + '\\.length\\?"\\+ ":""\\}\\$\\$\\{([A-Za-z_$][\\w$]*)\\.toFixed\\(2\\)\\} \\(adv\\)`\\);'
	);
	const am = s.match(advRe);
	if (!am) fail('advisor push pattern not matched — version drift');
	s = s.replace(advRe, (_m, p1, p2) => p1 + '.push(`${' + arr + '.length?"+ ":""}${__cnyAdvisor(' + p2 + ')} (adv)`);');

	if (pristine) {
		copyFileSync(BUNDLE, ORIG);
		log(`refreshed pristine backup ${ORIG}`);
	}

	let out = src.slice(0, i0) + s + src.slice(i1);
	// bun-version floor check bypass — see VERSION_CHECK_RE note. Non-fatal: the
	// CNY patch is the critical part; a drifted check just keeps omp's own floor.
	if (VERSION_CHECK_RE.test(out)) {
		out = out.replace(VERSION_CHECK_RE, "!1");
		log("disabled bun runtime version floor check (running bun 1.3.13 — see header note)");
	} else if (!hasVersionCheckBypass(out)) {
		log("WARN: bun version check pattern not found — leaving omp's own floor intact");
	}
	if (out.split('id:"cost",render(').length !== 2 || !out.includes("__cnyCalc(n)")) {
		fail("sanity check failed after patching — bundle left unchanged, please report");
	}
	writeFileSync(BUNDLE, out, "utf8");
	log(`patched ${BUNDLE} (${statSync(BUNDLE).size} bytes)`);
	return true;
}

/**
 * Remove bun-generated shims (`omp.exe` / `omp.pi.exe`) that would shadow the
 * .cmd wrapper, since PATHEXT resolves .EXE before .CMD.
 *
 * bun-installed omp: the shim IS the running process image. Windows refuses to
 * delete a running executable (EACCES/EPERM) but allows renaming it — so on a
 * delete failure we rename the shim aside (`omp.exe.disabled[.N]`) and let the
 * wrapper take over; the leftover is swept on a later run once the old process
 * has exited and the lock is gone.
 */
function removeShims() {
	if (!existsSync(BIN_DIR)) return;

	let entries;
	try {
		entries = readdirSync(BIN_DIR);
	} catch (e) {
		// Directory vanished/unreadable mid-flight (fresh-machine edge: the dir
		// can be a junction or be recreated by an installer concurrently) — skip
		// shim removal rather than abort the whole setup.
		log(`WARN: cannot list ${BIN_DIR} (${e.code || e.message}) — shim removal skipped; the .cmd wrapper may stay shadowed until the next --setup`);
		return;
	}

	// Sweep stale `.disabled*` leftovers from earlier in-use renames —
	// independent of whether a live shim is present. Best-effort: a copy
	// still mapped by a running omp process cannot be deleted (EACCES) and is
	// skipped; it will be swept on a later run once that process exits.
	for (const s of entries) {
		if (/^omp\.(exe|pi\.exe)\.disabled/i.test(s)) {
			try {
				rmSync(join(BIN_DIR, s));
				log(`removed stale shim copy ${join(BIN_DIR, s)}`);
			} catch {}
		}
	}

	for (const f of entries) {
		if (!/^omp\.(exe|pi\.exe)$/i.test(f)) continue;
		const p = join(BIN_DIR, f);

		try {
			rmSync(p);
			log(`removed bun shim ${p} (would shadow the .cmd wrapper)`);
		} catch (e) {
			// Shim is locked by a running omp process — rename it aside instead.
			let target = p + ".disabled";
			for (let i = 1; existsSync(target); i++) target = `${p}.disabled.${i}`;
			try {
				renameSync(p, target);
				log(`shim ${p} is in use by a running omp — renamed to ${target}; will be swept after omp exits`);
			} catch (e2) {
				log(`WARN: cannot remove or rename shim ${p} (${e2.code || e2.message}); the .cmd wrapper stays shadowed until omp exits — re-run setup after closing omp`);
			}
		}
	}
}

/**
 * The wrapper calls back into this script by absolute path, so setup must make
 * sure the script lives at PATCH_SCRIPT — even when run straight from a repo
 * checkout (fresh-machine deploy). Idempotent: skips when already identical.
 */
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

function setupWrapper() {
	// Validate everything the wrapper depends on BEFORE removing the shims —
	// a failed resolve must not leave the machine without any `omp` entry.
	ensureSelfInstalled();
	const bun = resolveBunExe().replaceAll("/", "\\");
	removeShims();
	const body =
		"@echo off\r\n" +
		`"${bun}" "${PATCH_SCRIPT.replaceAll("/", "\\")}" --check >nul 2>&1\r\n` +
		`"${bun}" "${BUNDLE.replaceAll("/", "\\")}" %*\r\n`;
	writeFileSync(WRAPPER, body, "utf8");
	log(`wrapper ready: ${WRAPPER}`);
}

function restore() {
	if (existsSync(WRAPPER)) {
		rmSync(WRAPPER);
		log(`removed wrapper ${WRAPPER}`);
	}
	if (existsSync(ORIG)) {
		copyFileSync(ORIG, BUNDLE);
		log(`restored pristine bundle ${BUNDLE}`);
	}
	// Sweep `.disabled*` shim leftovers so a later `bun install -g` recreates a
	// clean shim; a copy still mapped by a running omp process stays locked
	// (EACCES) and is skipped — it will be swept by the next --setup.
	if (existsSync(BIN_DIR)) {
		for (const f of readdirSync(BIN_DIR)) {
			if (/^omp\.(exe|pi\.exe)\.disabled/i.test(f)) {
				try {
					rmSync(join(BIN_DIR, f));
					log(`removed stale shim copy ${join(BIN_DIR, f)}`);
				} catch {}
			}
		}
	}
	log("restore done — run `bun install -g @oh-my-pi/pi-coding-agent` to recreate the omp shim");
}

const arg = process.argv[2];
if (arg === "--restore") restore();
else {
	patchBundle();
	setupWrapper();
}