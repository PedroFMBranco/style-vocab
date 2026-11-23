#!/usr/bin/env node
// style-vocab: open a running app in a browser, and check that a new piece of UI uses only the style
// values (font sizes, weights, colours, gaps, paddings, radii, control heights, insets) that a reference
// region already uses. Built for reviewing UI written by coding agents.
//
//   style-vocab compare --url <base> [--steps <json|file>] --ref '<css>' [--ref ...] --new '<css>'
//   style-vocab compare --url <base> --steps ... --ref-json saved-ref.json --new '<css>'
//   style-vocab collect --url <base> [--steps ...] --selector '<css>' [--save ref.json]
//   style-vocab shot    --url <base> [--steps ...]
//   style-vocab sweep   --url <base> --plan plan.json --out <dir> [--against <earlier sweep dir>]
//
// Flags: --viewport 1280x800  --out <dir>  --headed  --config style-vocab.config.json
//        --login <json|file>  steps run once before everything else (sign in)
// Exit code: 0 = match, 1 = values off the reference or a defect, 2 = usage or runtime error.
//
// Steps (JSON array, run in order). Strings may use ${env:NAME} to read environment variables:
//   {"goto": "/settings"}  {"click": "<css>"}  {"clickText": "<text>"}  {"clickAt": [x, y]}
//   {"hover": "<css>"}  {"fill": ["<css>", "value"]}  {"press": "Escape"}  {"wait": 1500 | "<css>"}
//   {"resize": "1024x700"}  {"eval": "<js expression>"}  (a non-undefined result is printed)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeSrc = fs.readFileSync(path.join(here, "../src/probe.js"), "utf8");
const DEFECTS = ["unreachable", "rawKey", "overlap", "rowMismatch"];

const USAGE = `usage: style-vocab compare|collect|shot|sweep --url <base> [options]

  compare  --ref <css> [--ref ...] | --ref-json <file>   --new <css>
  collect  --selector <css> [--save <file>]
  shot
  sweep    --plan <file> --out <dir> [--against <dir>]

  --steps <json|file>   steps to reach the screen      --login <json|file>  sign-in steps
  --viewport WxH        default 1280x800                --config <file>      probe options
  --out <dir>           where screenshots go            --headed             show the browser`;

function parseArgs(argv) {
    const [cmd, ...rest] = argv;
    const opts = { ref: [], refJson: [] };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
        const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        if (key === "headed" || key === "help") {
            opts[key] = true;
            continue;
        }
        const val = rest[++i];
        if (val === undefined) throw new Error(`missing value for ${a}`);
        if (key === "ref") opts.ref.push(val);
        else if (key === "refJson") opts.refJson.push(val);
        else opts[key] = val;
    }
    return { cmd, opts };
}

const fromEnv = (v) =>
    typeof v === "string"
        ? v.replace(/\$\{env:([A-Z0-9_]+)\}/g, (_, n) => {
              if (process.env[n] === undefined) throw new Error(`environment variable ${n} is not set`);
              return process.env[n];
          })
        : Array.isArray(v)
          ? v.map(fromEnv)
          : v;

function loadJson(spec, what) {
    if (!spec) return null;
    const text = fs.existsSync(spec) ? fs.readFileSync(spec, "utf8") : spec;
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${what} is not valid JSON (or not a file): ${e.message}`);
    }
}

function loadSteps(spec, what = "--steps") {
    const steps = loadJson(spec, what) || [];
    if (!Array.isArray(steps)) throw new Error(`${what} must be a JSON array`);
    return steps;
}

// "networkidle" never settles on pages with sockets or polling, so it is bounded, then a short pause.
async function settle(page, ms = 500) {
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(ms);
}

const join = (base, p) => (/^[a-z]+:/i.test(p) ? p : base.replace(/\/$/, "") + (p.startsWith("/") ? p : "/" + p));

async function runStep(page, base, step) {
    const [kind, raw] = Object.entries(step)[0];
    const arg = fromEnv(raw);
    switch (kind) {
        case "goto":
            await page.goto(join(base, arg), { waitUntil: "load" });
            await settle(page);
            break;
        case "click":
            await page.locator(arg).first().click();
            break;
        case "clickText":
            await page.getByText(arg, { exact: true }).first().click();
            break;
        case "clickAt":
            await page.mouse.click(arg[0], arg[1]);
            break;
        case "hover":
            await page.locator(arg).first().hover();
            break;
        case "fill":
            await page.locator(arg[0]).first().fill(arg[1]);
            break;
        case "press":
            await page.keyboard.press(arg);
            break;
        case "wait":
            if (typeof arg === "number") await page.waitForTimeout(arg);
            else await page.locator(arg).first().waitFor({ state: "attached", timeout: 30000 });
            break;
        case "resize": {
            const [w, h] = arg.split("x").map(Number);
            await page.setViewportSize({ width: w, height: h });
            await page.waitForTimeout(300);
            break;
        }
        case "eval": {
            const value = await page.evaluate(arg);
            if (value !== undefined) console.log(`eval: ${JSON.stringify(value, null, 1)}`);
            break;
        }
        default:
            throw new Error(`unknown step: ${kind}`);
    }
    await page.waitForTimeout(150);
}

async function shotOf(page, selector, file) {
    const loc = page.locator(selector).first();
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    await loc.screenshot({ path: file });
}

// Typography fingerprint of a screen. Two sweeps with equal fingerprints render text the same.
function fingerprint(v) {
    const counts = (b) => Object.fromEntries(Object.entries(v[b] || {}).map(([k, e]) => [k, e.count]));
    return { text: counts("text"), lineHeight: counts("lineHeight"), controlHeight: counts("controlHeight"), padding: counts("padding"), gap: counts("gap") };
}

function diffCounts(a, b) {
    const out = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] || 0) !== (b[k] || 0)) out.push(`${k}: ${a[k] || 0} → ${b[k] || 0}`);
    return out;
}

async function install(page, config) {
    await page.evaluate(`(${probeSrc})(${JSON.stringify(config)})`);
}

async function sweep(page, base, opts, out, config) {
    if (!opts.plan) throw new Error("sweep needs --plan <file>");
    const plan = loadJson(opts.plan, "--plan");
    let failures = 0, differing = 0;
    for (const screen of plan) {
        try {
            for (const step of screen.steps || []) await runStep(page, base, step);
            await install(page, config);
            const vocab = await page.evaluate((s) => window.__styleVocab.collect(s), screen.selector || "body");
            fs.writeFileSync(path.join(out, `${screen.name}.json`), JSON.stringify(vocab, null, 1));
            await page.screenshot({ path: path.join(out, `${screen.name}.png`) });
            const defects = DEFECTS.filter((b) => Object.keys(vocab[b] || {}).length);
            let line = `ok    ${screen.name}${defects.length ? `  (defects: ${defects.join(", ")})` : ""}`;
            if (opts.against) {
                const prevFile = path.join(opts.against, `${screen.name}.json`);
                if (!fs.existsSync(prevFile)) line += "  [no baseline]";
                else {
                    const a = fingerprint(JSON.parse(fs.readFileSync(prevFile, "utf8"))), b = fingerprint(vocab);
                    const diffs = Object.keys(a).flatMap((k) => diffCounts(a[k], b[k]).map((d) => `${k} ${d}`));
                    if (diffs.length) {
                        differing++;
                        line = `DIFF  ${screen.name}\n        ` + diffs.slice(0, 12).join("\n        ") + (diffs.length > 12 ? `\n        … ${diffs.length - 12} more` : "");
                    } else line += "  = baseline";
                }
            }
            console.log(line);
        } catch (e) {
            failures++;
            console.log(`FAIL  ${screen.name}: ${e.message.split("\n")[0]}`);
        }
    }
    console.log(`\n${plan.length} screens, ${failures} failed${opts.against ? `, ${differing} differ from ${opts.against}` : ""}. Output in ${out}`);
    return failures || differing ? 1 : 0;
}

function printCompare(result) {
    const e = result.env;
    console.log(`env: root ${e.rootPx}px, body ${e.bodyPx}px, viewport ${e.viewport.width}x${e.viewport.height}`);
    console.log("reference vocabulary:");
    for (const [k, v] of Object.entries(result.referenceVocabulary)) console.log(`  ${k.padEnd(14)} ${v.join(", ")}`);
    console.log(`\n${result.summary}`);
    for (const [bucket, entries] of Object.entries(result.offVocabulary)) {
        for (const [key, info] of Object.entries(entries)) {
            console.log(`  ✗ ${bucket} ${key} ×${info.count}`);
            for (const s of info.samples) console.log(`      at ${s}`);
        }
    }
}

async function main() {
    const { cmd, opts } = parseArgs(process.argv.slice(2));
    if (opts.help || !["compare", "collect", "shot", "sweep"].includes(cmd) || !opts.url) {
        console.error(USAGE);
        return opts.help ? 0 : 2;
    }
    let chromium;
    try {
        ({ chromium } = await import("playwright"));
    } catch {
        throw new Error("Playwright is not installed: run `npm install` and `npx playwright install chromium`");
    }
    const config = loadJson(opts.config, "--config") || (fs.existsSync("style-vocab.config.json") ? loadJson("style-vocab.config.json", "config") : {});
    const base = opts.url;
    const [vw, vh] = (opts.viewport || "1280x800").split("x").map(Number);
    const out = opts.out || path.join(os.tmpdir(), "style-vocab", new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(out, { recursive: true });

    const browser = await chromium.launch({ headless: !opts.headed });
    try {
        const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
        const page = await ctx.newPage();
        await page.goto(base, { waitUntil: "load" });
        await settle(page);
        for (const step of loadSteps(opts.login, "--login")) await runStep(page, base, step);

        if (cmd === "sweep") return await sweep(page, base, opts, out, config);

        for (const step of loadSteps(opts.steps)) await runStep(page, base, step);
        await install(page, config);
        await page.screenshot({ path: path.join(out, "page.png") });

        if (cmd === "shot") {
            console.log(`screenshot: ${path.join(out, "page.png")}`);
            return 0;
        }
        if (cmd === "collect") {
            if (!opts.selector) throw new Error("collect needs --selector");
            const vocab = await page.evaluate((s) => window.__styleVocab.collect(s), opts.selector);
            const file = opts.save || path.join(out, "vocab.json");
            fs.writeFileSync(file, JSON.stringify(vocab, null, 2));
            await shotOf(page, opts.selector, path.join(out, "region.png"));
            for (const b of ["fontSize", "fontWeight", "color", "gap", "padding", "radius", "controlHeight", "iconSize", "inset", ...DEFECTS]) {
                const entries = Object.entries(vocab[b]);
                if (entries.length || !DEFECTS.includes(b)) console.log(`  ${b.padEnd(14)} ${entries.map(([k, v]) => `${k}×${v.count}`).join(", ")}`);
            }
            console.log(`\nvocabulary: ${file}\nscreenshots: ${out}/{page,region}.png`);
            return DEFECTS.some((b) => Object.keys(vocab[b]).length) ? 1 : 0;
        }

        if (!opts.new || (opts.ref.length === 0 && opts.refJson.length === 0)) {
            throw new Error("compare needs --new and at least one --ref or --ref-json");
        }
        const saved = opts.refJson.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
        const result = await page.evaluate(
            ({ refSels, saved, newSel }) => {
                const P = window.__styleVocab;
                const refs = [...saved, ...refSels.map((s) => P.collect(s, newSel))];
                return P.compareVocab(refs, P.collect(newSel, null, P.enclosing(refSels, newSel)));
            },
            { refSels: opts.ref, saved, newSel: opts.new },
        );
        for (const [i, sel] of opts.ref.entries()) await shotOf(page, sel, path.join(out, `ref-${i}.png`));
        await shotOf(page, opts.new, path.join(out, "new.png"));
        fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(result, null, 2));
        printCompare(result);
        console.log(`\nreport: ${path.join(out, "report.json")}\nscreenshots: ${out}/{page,ref-*,new}.png (look at them side by side)`);
        return result.match ? 0 : 1;
    } finally {
        await browser.close();
    }
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`style-vocab: ${err.message}`);
        process.exit(2);
    },
);
