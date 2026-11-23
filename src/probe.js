(options = {}) => {
    // Installs window.__styleVocab in the page. Self-contained: the CLI evaluates it through Playwright, and
    // you can paste it into any devtools console or an MCP `evaluate_script` call as-is.
    //
    //   __styleVocab.collect(selector)          -> style vocabulary of one region
    //   __styleVocab.compare(refSel, newSel)    -> values the new region uses that the reference never does
    //   __styleVocab.compareVocab([refVocab], newVocab) -> same, for vocabularies collected earlier
    //   __styleVocab.env()                      -> root/body font size and viewport (check before comparing)
    //
    // "Vocabulary" = the set of computed font sizes, weights, colours, text-transforms, gaps, paddings,
    // radii, border colours, control heights and icon sizes rendered inside a region, plus where its
    // title and body start. It compares computed values, not class names: identical classes can render
    // differently (inherited font sizes) and different classes can render the same.
    //
    // options (all optional):
    //   controlSelector  elements measured as controls (height, row alignment)
    //   ownedSelector    component roots whose internal box styling belongs to a component library;
    //                    gaps/paddings/radii/borders inside them are not compared (font size and control
    //                    height still are, so overrides still show up)
    //   rowTolerance     px difference allowed between controls in one row (default 2.5)
    //   numericTolerance px tolerance for font size, gap, padding, radius (default 0.51)
    //   heightTolerance  px tolerance for control heights (default 1.5)

    const TOL = options.numericTolerance ?? 0.51;
    const HTOL = options.heightTolerance ?? 1.5;
    const ROW_TOL = options.rowTolerance ?? 2.5;
    const CONTROL =
        options.controlSelector ||
        "button, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea, [role=combobox], [role=button]";
    const OWNED = options.ownedSelector || null;
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);
    const ALWAYS_DEFECTS = ["unreachable", "rawKey", "overlap", "rowMismatch"];

    const px = (v) => {
        const n = parseFloat(v);
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    };

    const visible = (el, cs) => {
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    const directText = (el) => {
        let t = "";
        for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
        return t.replace(/\s+/g, " ").trim();
    };

    const describe = (el) => {
        if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
        const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
        const short = cls.split(/\s+/).filter(Boolean).slice(0, 4).join(".");
        return el.tagName.toLowerCase() + (short ? "." + short : "");
    };

    const resolve = (sel) => {
        const el = typeof sel === "string" ? document.querySelector(sel) : sel;
        if (!el) throw new Error("style-vocab: selector matched nothing: " + sel);
        return el;
    };

    const isControl = (el) => el.matches(CONTROL);

    // A component-library root or anything inside it: box styling is the library's.
    const owned = (el, root) => {
        if (!OWNED) return false;
        const o = el.closest(OWNED);
        return !!o && o !== root && root.contains(o);
    };

    // Content the user cannot see or scroll to: cut off by an overflow:hidden/clip ancestor, or outside
    // the viewport with no scrollable ancestor. A scroll container clipping is fine: the user can scroll.
    const unreachable = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        let scrollable = false;
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            const cs = getComputedStyle(a);
            const ox = cs.overflowX, oy = cs.overflowY;
            if (/(auto|scroll)/.test(ox + oy)) {
                scrollable = true;
                continue;
            }
            if (/(hidden|clip)/.test(ox + oy)) {
                const ar = a.getBoundingClientRect();
                const cutY = /(hidden|clip)/.test(oy) && (r.bottom > ar.bottom + 1 || r.top < ar.top - 1);
                const cutX = /(hidden|clip)/.test(ox) && (r.right > ar.right + 1 || r.left < ar.left - 1);
                if ((cutY || cutX) && !scrollable) return true;
            }
        }
        const off = r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || r.top < -1 || r.left < -1;
        return off && !scrollable;
    };

    // The part of an element actually on screen: its box clipped by every overflow-clipping ancestor,
    // so content scrolled out of view doesn't count as overlapping.
    const visibleRect = (el) => {
        const b = el.getBoundingClientRect();
        let { left, top, right, bottom } = b;
        for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
            const cs = getComputedStyle(a);
            if (cs.overflowX + cs.overflowY === "visiblevisible") continue;
            const ar = a.getBoundingClientRect();
            if (cs.overflowX !== "visible") (left = Math.max(left, ar.left)), (right = Math.min(right, ar.right));
            if (cs.overflowY !== "visible") (top = Math.max(top, ar.top)), (bottom = Math.min(bottom, ar.bottom));
        }
        return { left, top, right, bottom, width: Math.max(0, right - left), height: b.height };
    };

    // A dotted lower-case key rendered as text = a translation lookup with no default:
    // "settings.profile.title", "forms.placeholder_email". File names are not keys.
    const FILE_EXT = /\.(json|csv|xlsx?|zip|pdf|png|jpe?g|gif|svg|webp|txt|md|html?)$/i;
    const isRawKey = (t) =>
        /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(t) && !FILE_EXT.test(t) && (t.split(".").length > 2 || t.includes("_"));

    // exclude: selector whose subtree is skipped (the new region, when it sits inside the reference).
    // insetOrigin: element to measure text insets from (default: the region). compare() passes the
    // enclosing reference when the new region sits inside it, so a new section is measured like its siblings.
    function collect(sel, exclude, insetOrigin) {
        const root = resolve(sel);
        const buckets = {
            text: new Map(), // "14px 700 uppercase rgb(..)" -> samples (reported, not compared)
            fontSize: new Map(),
            fontWeight: new Map(),
            lineHeight: new Map(), // "fontSize/lineHeight" pairs (used by sweep, not compared)
            color: new Map(),
            gap: new Map(),
            padding: new Map(),
            radius: new Map(),
            borderColor: new Map(),
            controlHeight: new Map(),
            iconSize: new Map(),
            inset: new Map(), // "title 24" / "content 24" (px from the region's left edge)
            unreachable: new Map(), // always a defect
            rawKey: new Map(), // always a defect
            overlap: new Map(), // always a defect
            rowMismatch: new Map(), // always a defect
        };
        const add = (bucket, key, el, sample) => {
            const m = buckets[bucket];
            if (!m.has(key)) m.set(key, { count: 0, samples: [] });
            const e = m.get(key);
            e.count++;
            if (e.samples.length < 3) e.samples.push((sample ? `"${sample.slice(0, 40)}" ` : "") + describe(el));
        };

        const boxes = []; // text-bearing elements and controls, for the overlap and row checks
        const walk = (el) => {
            if (SKIP.has(el.tagName)) return;
            if (exclude && el !== root && el.matches(exclude)) return;
            const cs = getComputedStyle(el);
            if (!visible(el, cs)) return;

            if (el instanceof SVGSVGElement) {
                const r = el.getBoundingClientRect();
                add("iconSize", `${Math.round(r.width)}x${Math.round(r.height)}`, el);
                return; // do not descend into icon internals
            }

            const text = directText(el);
            if (text && isRawKey(text)) add("rawKey", text, el, text);
            for (const attr of ["placeholder", "title", "aria-label"]) {
                const v = el.getAttribute && el.getAttribute(attr);
                if (v && isRawKey(v.trim())) add("rawKey", `${attr}: ${v.trim()}`, el, v.trim());
            }
            if (text) {
                const fs = px(cs.fontSize);
                const tt = cs.textTransform === "none" ? "" : " " + cs.textTransform;
                add("text", `${fs}px ${cs.fontWeight}${tt} ${cs.color}`, el, text);
                add("fontSize", String(fs), el, text);
                add("lineHeight", `${fs}/${cs.lineHeight}`, el, text);
                add("fontWeight", cs.fontWeight + tt, el, text);
                add("color", cs.color, el, text);
            }

            const lib = owned(el, root);
            if (/(flex|grid)/.test(cs.display) && !lib) {
                for (const g of new Set([cs.rowGap, cs.columnGap])) {
                    const v = px(g);
                    if (v > 0) add("gap", String(v), el);
                }
            }
            for (const v of new Set(["Top", "Right", "Bottom", "Left"].map((s) => px(cs["padding" + s])))) {
                if (v > 0 && !lib) add("padding", String(v), el);
            }
            const rad = px(cs.borderTopLeftRadius);
            if (rad > 0 && rad < 9000 && !lib) add("radius", String(rad), el);
            for (const side of lib ? [] : ["Top", "Right", "Bottom", "Left"]) {
                if (px(cs["border" + side + "Width"]) > 0 && cs["border" + side + "Style"] !== "none") {
                    add("borderColor", cs["border" + side + "Color"], el);
                    break;
                }
            }
            const control = isControl(el);
            if (control) add("controlHeight", String(Math.round(el.getBoundingClientRect().height)), el, text);
            if ((text || control) && unreachable(el)) add("unreachable", "cut off, not scrollable", el, text);
            if (text || control) boxes.push({ el, r: visibleRect(el), text, control });

            for (const c of el.children) walk(c);
        };
        walk(root);

        // Overlap: two text/control boxes that intersect while neither contains the other
        // (typically a field spilling out of its column over a neighbour).
        const inter = (a, b) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
        const seen = new Set();
        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const A = boxes[i], B = boxes[j];
                if (A.el.contains(B.el) || B.el.contains(A.el) || !inter(A.r, B.r)) continue;
                if (OWNED) {
                    const ca = A.el.closest(OWNED), cb = B.el.closest(OWNED);
                    if (ca && ca === cb) continue; // parts of one library component
                }
                const key = describe(A.el) + " × " + describe(B.el);
                if (seen.has(key)) continue;
                seen.add(key);
                add("overlap", key, A.el, (A.text || "") + " / " + (B.text || ""));
            }
        }

        // Alignment: where the first text (the title) and the rest of the content start, measured from
        // the region's left edge. Catches double padding (title indented past its body), which the value
        // buckets cannot see because every individual padding is "legal".
        const rootLeft = (insetOrigin || root).getBoundingClientRect().left;
        const texts = [];
        const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (tw.nextNode()) {
            const n = tw.currentNode;
            if (!n.textContent.trim() || !n.parentElement) continue;
            if (exclude && n.parentElement.closest(exclude) && !root.matches(exclude)) continue;
            if (!visible(n.parentElement, getComputedStyle(n.parentElement))) continue;
            const range = document.createRange();
            range.selectNodeContents(n);
            const r = range.getBoundingClientRect();
            if (r.width > 0) {
                texts.push({ left: Math.round((r.left - rootLeft) * 4) / 4, top: r.top, bottom: r.bottom, el: n.parentElement, text: n.textContent.trim() });
            }
        }
        if (texts.length) {
            add("inset", `title ${texts[0].left}`, texts[0].el, texts[0].text);
            // Body = text on lines below the title; items beside it on the same line don't count.
            const rest = texts.slice(1).filter((t) => t.top >= texts[0].bottom - 1);
            if (rest.length) {
                const min = rest.reduce((a, b) => (b.left < a.left ? b : a));
                add("inset", `content ${min.left}`, min.el, min.text);
            }
        }

        // Row mismatch: controls side by side in one flex row with visibly different heights.
        const controls = boxes.filter((b) => b.control && !boxes.some((o) => o !== b && o.control && o.el.contains(b.el)));
        const commonAncestor = (a, b) => {
            for (let x = a.parentElement; x; x = x.parentElement) if (x.contains(b)) return x;
            return null;
        };
        const seenRows = new Set();
        for (let i = 0; i < controls.length; i++) {
            for (let j = i + 1; j < controls.length; j++) {
                const A = controls[i], B = controls[j];
                const cy = (r) => (r.top + r.bottom) / 2;
                if (Math.abs(cy(A.r) - cy(B.r)) > 12 || Math.abs(A.r.height - B.r.height) <= ROW_TOL) continue;
                const anc = commonAncestor(A.el, B.el);
                const acs = anc && getComputedStyle(anc);
                if (!acs || !/flex/.test(acs.display) || !/^row/.test(acs.flexDirection)) continue;
                const key = `${Math.round(A.r.height)}px vs ${Math.round(B.r.height)}px`;
                if (seenRows.has(key + describe(anc))) continue;
                seenRows.add(key + describe(anc));
                add("rowMismatch", key, anc, `${A.text || describe(A.el)} / ${B.text || describe(B.el)}`);
            }
        }

        const out = {};
        for (const [k, m] of Object.entries(buckets)) {
            out[k] = Object.fromEntries([...m.entries()].sort((a, b) => b[1].count - a[1].count));
        }
        return out;
    }

    const numericBuckets = new Set(["fontSize", "gap", "padding", "radius", "controlHeight"]);

    function inVocab(bucket, key, refKeys) {
        if (ALWAYS_DEFECTS.includes(bucket)) return false;
        if (refKeys.includes(key)) return true;
        if (numericBuckets.has(bucket)) {
            const v = parseFloat(key);
            const tol = bucket === "controlHeight" ? HTOL : TOL;
            return refKeys.some((k) => Math.abs(parseFloat(k) - v) <= tol);
        }
        if (bucket === "inset") {
            const [role, v] = key.split(" ");
            return refKeys.some((k) => k.startsWith(role + " ") && Math.abs(parseFloat(k.split(" ")[1]) - parseFloat(v)) <= 1);
        }
        if (bucket === "iconSize") {
            const [w, h] = key.split("x").map(Number);
            return refKeys.some((k) => {
                const [rw, rh] = k.split("x").map(Number);
                return Math.abs(rw - w) <= 1 && Math.abs(rh - h) <= 1;
            });
        }
        return false;
    }

    // refSels may be one selector or an array (union of several reference regions).
    // The new region is excluded from the references, so the surrounding surface can be the reference.
    function compare(refSels, newSel) {
        const refs = Array.isArray(refSels) ? refSels : [refSels];
        return compareVocab(refs.map((r) => collect(r, newSel)), collect(newSel, null, enclosing(refs, newSel)));
    }

    function enclosing(refSels, newSel) {
        const n = resolve(newSel);
        return refSels.map((r) => document.querySelector(r)).find((r) => r && r !== n && r.contains(n)) || null;
    }

    function compareVocab(refs, neu) {
        const offVocabulary = {};
        let total = 0;
        for (const bucket of Object.keys(neu)) {
            if (bucket === "text" || bucket === "lineHeight") continue; // reported, not compared
            const refKeys = refs.flatMap((r) => Object.keys(r[bucket] || {}));
            for (const [key, info] of Object.entries(neu[bucket])) {
                if (!inVocab(bucket, key, refKeys)) {
                    (offVocabulary[bucket] ||= {})[key] = info;
                    total++;
                }
            }
        }
        const keys = (b) => [...new Set(refs.flatMap((r) => Object.keys(r[b] || {})))];
        return {
            env: env(),
            match: total === 0,
            summary:
                total === 0
                    ? "MATCH: every value in the new region exists in the reference"
                    : `${total} value(s) the reference never uses: fix them or justify each one`,
            offVocabulary,
            referenceVocabulary: {
                fontSize: keys("fontSize"),
                fontWeight: keys("fontWeight"),
                color: keys("color"),
                gap: keys("gap"),
                padding: keys("padding"),
                radius: keys("radius"),
                controlHeight: keys("controlHeight"),
                inset: keys("inset"),
            },
            newText: neu.text,
        };
    }

    function env() {
        return {
            url: location.href,
            rootPx: px(getComputedStyle(document.documentElement).fontSize),
            bodyPx: px(getComputedStyle(document.body).fontSize),
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
        };
    }

    window.__styleVocab = { collect, compare, compareVocab, enclosing, env };
    return "style-vocab installed: " + JSON.stringify(env());
}
