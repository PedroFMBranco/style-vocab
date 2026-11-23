---
name: reference-first-ui
description: Use for ANY change that adds or alters visible UI in <your app> (panels, dialogs, forms, tables, toolbars, pages), including subagent work. Makes the result match the existing style by building from a chosen reference, linting the diff and measuring the rendered result against the reference. Load before writing any template or class.
---

# UI that matches the existing style

A template. Replace every `<...>` with your app's facts, and delete what doesn't apply. Keep it
short: the rules here should be the ones agents actually break, each learned from a real defect.

## Why agents get this wrong (read once)

1. **Your app's defaults are not the framework's defaults.** <e.g. the root font size is not 16 px,
   so "text-sm for labels" renders too small. Write down the real numbers.>
2. **Size comes from inheritance.** <Which shells set the font size, so children carry no size class.>
3. **The codebase has drifted.** "Copy an existing implementation" copies whichever drift the agent
   opens first. Only copy the files in [Reference files](#reference-files).
4. **Nobody looked at the result.** Every UI change ends with a measured comparison and screenshots.

## Workflow (all steps are mandatory)

1. **Classify the surface:** <your archetypes: form, dialog, popover, toolbar, list + editor, full page>.
   If you change an existing screen, the reference is that screen's unchanged siblings. Write down the
   reference file(s) and the style-vocab steps that open the reference in the running app.
2. **Build from the reference.** Read it completely (template and the components it wraps). Copy its
   outer shell and its section/row/footer structure verbatim. Use the components it uses.
3. **Follow the hard rules below.**
4. **Lint the added lines:** `<your lint command>` (see `examples/diff-lint.mjs` for a minimal one).
   0 errors. Fix every warning or justify it in one line.
5. **Measure in the running app:**
   ```bash
   npx style-vocab compare --url <app url> --login <login steps file> \
     --steps '<steps that open the screen>' --ref '<reference selector>' --new '<new region selector>'
   ```
   It must print MATCH, or you justify each value it lists ("new element type the reference has no
   equivalent of: status chip"). Then open `ref-0.png` and `new.png` and compare them side by side:
   title and body alignment, section rhythm, control heights. The numbers don't catch everything.
6. **Report** in your final message: reference used, lint summary, compare summary, screenshot paths,
   justifications. No report, not done.

## Hard rules

- **No text size on labels, values or fields.** Let them inherit. Set a size only where the reference
  sets one for the same role (title, section header, caption).
- **Spacing from the reference, on the scale.** <The steps your panels use: edges, sections, rows.>
- **Colours are tokens only:** <your tokens>. No hex, no stock palette.
- **One button size for labelled actions:** <yours>. Controls in one row share a height.
- **One padding owner per edge.** If the shell pads, children don't pad again. Double padding is the
  "title indented past its body" defect.
- **Use the component library's props, not `!important` overrides.**
- **Strings always carry a default** <if you use a translation service>.
- **Everything you add is visible or reachable by scrolling** at <your test viewport>.
- **Don't restyle what you didn't touch.**

## Reference files

| Archetype | Copy from | style-vocab steps that open it |
|---|---|---|
| <form> | `<path>` | `[{"goto": "<path>"}]` |
| <dialog> | `<path>` | `[{"goto": "..."}, {"click": "..."}]` |

**Don't copy these** (known drift): <paths or patterns, and what is wrong with each>.
