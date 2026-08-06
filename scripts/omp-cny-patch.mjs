#!/usr/bin/env bun
/**
 * omp CNY cost patch — status-line `$` -> configurable symbol (default ¥).
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
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	copyFileSync,
	rmSync,
	statSync,
	readdirSync,
	mkdirSync,
	appendFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const HOME = homedir();
const BUNDLE = join(HOME, ".bun", "install", "global", "node_modules", "@oh-my-pi", "pi-coding-agent", "dist", "cli.js");
const ORIG = BUNDLE + ".orig";
const BIN_DIR = join(HOME, ".bun", "bin");
const WRAPPER = join(BIN_DIR, "omp.cmd");
const PATCH_SCRIPT = join(HOME, ".omp", "omp-cny-patch.mjs");
const LOG_FILE = join(HOME, ".omp", "logs", "omp-cny-patch.log");

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

function patchBundle() {
	if (!existsSync(BUNDLE)) fail(`bundle not found: ${BUNDLE}`);
	let src = readFileSync(BUNDLE, "utf8");
	let pristine = false;

	const preSeg = findCostSegment(src);
	if (src.includes("__cnyCfg")) {
		const pre = preSeg ? src.slice(preSeg[0], preSeg[1]) : "";
		const ADVISOR_OK = /`\$\{[A-Za-z_$][\w$]*\.length\?"\+ ":""\}\$\{__cnyAdvisor\(/.test(pre);
		if (preSeg && ADVISOR_OK && pre.includes("__cnyCalc(n)")) {
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

	const out = src.slice(0, i0) + s + src.slice(i1);
	if (out.split('id:"cost",render(').length !== 2 || !out.includes("__cnyCalc(n)")) {
		fail("sanity check failed after patching — bundle left unchanged, please report");
	}
	writeFileSync(BUNDLE, out, "utf8");
	log(`patched ${BUNDLE} (${statSync(BUNDLE).size} bytes)`);
	return true;
}

function removeShims() {
	if (!existsSync(BIN_DIR)) return;
	for (const f of readdirSync(BIN_DIR)) {
		if (/^omp\.(exe|pi\.exe)$/i.test(f)) {
			const p = join(BIN_DIR, f);
			rmSync(p);
			log(`removed bun shim ${p} (would shadow the .cmd wrapper)`);
		}
	}
}

function setupWrapper() {
	removeShims();
	const body =
		"@echo off\r\n" +
		`bun "${PATCH_SCRIPT.replaceAll("/", "\\")}" --check >nul 2>&1\r\n` +
		`bun "%USERPROFILE%\\.bun\\install\\global\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js" %*\r\n`;
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
	log("restore done — run `bun install -g @oh-my-pi/pi-coding-agent` to recreate the omp shim");
}

const arg = process.argv[2];
if (arg === "--restore") restore();
else {
	patchBundle();
	setupWrapper();
}