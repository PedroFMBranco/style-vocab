// Runs the CLI against the demo page: the agent's version must fail on exactly the three planted
// defects, and the fixed version must match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const page = "file://" + path.join(root, "demo/form.html");

function run(url) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "style-vocab-test-"));
    const r = spawnSync("node", ["bin/style-vocab.mjs", "compare", "--url", url, "--ref", "#reference", "--new", "#agent", "--out", out], { cwd: root, encoding: "utf8" });
    const report = fs.existsSync(path.join(out, "report.json")) ? JSON.parse(fs.readFileSync(path.join(out, "report.json"), "utf8")) : null;
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, report, out };
}

test("agent's version: title inset, label size and row height are off the reference", () => {
    const { code, report, stderr } = run(page);
    assert.equal(code, 1, stderr);
    const off = report.offVocabulary;
    assert.deepEqual(Object.keys(off).sort(), ["controlHeight", "fontSize", "inset", "rowMismatch"]);
    assert.deepEqual(Object.keys(off.fontSize), ["12"]);
    assert.equal(off.fontSize["12"].count, 2);
    assert.deepEqual(Object.keys(off.controlHeight), ["44"]);
    assert.match(Object.keys(off.inset)[0], /^title /);
    assert.deepEqual(Object.keys(off.rowMismatch), ["36px vs 44px"]);
});

test("fixed version matches and writes screenshots", () => {
    const { code, report, out, stderr } = run(page + "#fixed");
    assert.equal(code, 0, stderr);
    assert.equal(report.match, true);
    assert.deepEqual(report.offVocabulary, {});
    for (const f of ["page.png", "ref-0.png", "new.png"]) assert.ok(fs.existsSync(path.join(out, f)), f);
});
