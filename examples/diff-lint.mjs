#!/usr/bin/env node
// A small static lint for UI diffs: checks only the lines added since a base branch, so an agent is
// held to the rules on what it wrote, not on the codebase's existing drift.
//
//   node examples/diff-lint.mjs [base]        (default base: origin/main)
//
// Edit RULES for your design system. Exit 1 if any ERROR is found. Each WARN is fixed or justified.
// For class-level rules on Tailwind projects (per-component contracts, unknown classes), use a real
// linter such as @shadcn/lint. This file is the minimum: it reads code and never sees the page.

import { execFileSync } from "node:child_process";

const RULES = [
    ["ERROR", "px-font", /text-\[\d+(\.\d+)?px\]|font-size\s*:\s*\d+(\.\d+)?px/, "Font size in px. Use the type scale, or let the text inherit."],
    ["ERROR", "hex-color", /(?:text|bg|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]|color\s*:\s*#[0-9a-fA-F]{3,8}\b/, "Hex colour. Use a colour token."],
    ["ERROR", "native-dialog", /\bwindow\.(confirm|alert)\(/, "Native dialog. Use the app's dialog component."],
    ["WARN", "stock-palette", /(?:text|bg|border)-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/, "Stock palette colour. Use a token unless the reference uses it."],
    ["WARN", "px-arbitrary", /-\[-?\d+(\.\d+)?px\]/, "Arbitrary px value. Use the spacing scale the reference uses."],
    ["WARN", "important", /(?<![\w-])!(?:text-|p[xytblr]?-|m[xytblr]?-|h-|w-)/, "!important override. Use the component's props instead."],
    ["WARN", "inline-style", /style="[^"]*\b(?:padding|margin|width|height|font-size)\s*:\s*\d+px/, "Inline px style."],
];

const base = process.argv[2] || "origin/main";
const diff = execFileSync("git", ["diff", "--unified=0", "--no-color", `${base}...HEAD`, "--", "*.vue", "*.tsx", "*.jsx", "*.svelte", "*.html", "*.css"], { encoding: "utf8" });

let file = "", line = 0, errors = 0, warns = 0;
for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.slice(6);
    else if (l.startsWith("@@")) line = Number(/\+(\d+)/.exec(l)[1]);
    else if (l.startsWith("+")) {
        for (const [sev, id, rx, msg] of RULES) {
            if (!rx.test(l)) continue;
            console.log(`${sev.padEnd(5)} ${file}:${line} ${id}: ${msg}\n      ${l.slice(1).trim().slice(0, 120)}`);
            sev === "ERROR" ? errors++ : warns++;
        }
        line++;
    }
}
console.log(`\n${errors} error(s), ${warns} warning(s) on lines added since ${base}`);
process.exit(errors ? 1 : 0);
