// Scans every frame of a page for fillable form fields and tags each one with a
// stable data-jab-id so the filler can find it again later.

const ATTR = "data-jab-id";

// Runs inside the browser. Must be self-contained (no closures over Node scope).
function scanFrame({ attr, prefix }) {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && (r.width > 0 || r.height > 0);
  };

  const labelFor = (el) => {
    const parts = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) parts.push(l.innerText);
    }
    const wrap = el.closest("label");
    if (wrap) parts.push(wrap.innerText);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) parts.push(n.innerText); });
    if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
    if (!parts.length) {
      // Fall back to the nearest preceding text inside the field's container.
      let node = el.parentElement;
      for (let i = 0; i < 4 && node && !parts.length; i++, node = node.parentElement) {
        const t = clean(node.innerText);
        if (t && t.length < 300) parts.push(t);
      }
    }
    if (el.placeholder) parts.push(`(placeholder: ${el.placeholder})`);
    return clean([...new Set(parts.map(clean))].join(" "));
  };

  const groupQuestion = (el) => {
    const fs = el.closest("fieldset");
    if (fs) {
      const lg = fs.querySelector("legend");
      if (lg) return clean(lg.innerText);
    }
    const rg = el.closest('[role="radiogroup"], [role="group"]');
    if (rg) {
      const lb = rg.getAttribute("aria-labelledby");
      if (lb && document.getElementById(lb)) return clean(document.getElementById(lb).innerText);
      if (rg.getAttribute("aria-label")) return clean(rg.getAttribute("aria-label"));
    }
    // Walk up until the container holds more text than just this option's label.
    let node = el.parentElement;
    const own = labelFor(el);
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      // Stop before the container swallows other questions' fields.
      const others = [...node.querySelectorAll("input, textarea, select")].some((o) => o.type !== "hidden" && (o.name || o.id) !== (el.name || el.id) && o.type !== el.type);
      if (others) break;
      const t = clean(node.innerText);
      if (t.length > own.length + 3 && t.length < 600) return t;
    }
    return own;
  };

  const fields = [];
  const groups = new Map();
  let n = 0;
  const els = document.querySelectorAll("input, textarea, select");
  for (const el of els) {
    const type = (el.getAttribute("type") || (el.tagName === "INPUT" ? "text" : el.tagName)).toLowerCase();
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
    if (el.disabled || el.readOnly) continue;
    if (type !== "file" && !visible(el)) continue;

    if (type === "radio" || type === "checkbox") {
      const key = `${type}:${el.name || groupQuestion(el)}`;
      const option = labelFor(el) || el.value;
      let g = groups.get(key);
      if (!g) {
        g = { id: `${prefix}${n++}`, kind: type === "radio" ? "radio" : "checkbox", name: el.name, label: groupQuestion(el), options: [], required: false };
        groups.set(key, g);
        fields.push(g);
      }
      el.setAttribute(attr, `${g.id}:${g.options.length}`);
      g.options.push(option);
      g.required = g.required || el.required || el.getAttribute("aria-required") === "true";
      continue;
    }

    const id = `${prefix}${n++}`;
    el.setAttribute(attr, id);
    const f = {
      id,
      kind: el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("role") === "combobox" ? "combobox" : type,
      name: el.name || el.id || "",
      label: labelFor(el),
      required: el.required || el.getAttribute("aria-required") === "true",
      currentValue: type === "file" ? "" : el.value || "",
    };
    if (el.tagName === "SELECT") {
      const o = el.selectedOptions[0];
      // Treat an unselected placeholder ("Select...", empty value) as empty.
      if (!o || !o.value || /^(select|choose|please|--)/i.test(clean(o.text))) f.currentValue = "";
      else f.currentValue = clean(o.text);
      f.options = [...el.options].map((o) => clean(o.text)).filter((t) => t && !/^(select|choose|--)/i.test(t));
    }
    if (el.maxLength > 0) f.maxLength = el.maxLength;
    fields.push(f);
  }
  // A lone checkbox ("I agree", "Yes, I'm authorized") is a yes/no question, not a pick-list.
  for (const f of fields) {
    if (f.kind === "checkbox" && f.options.length === 1) {
      f.kind = "single_checkbox";
      if (f.label.length > f.options[0].length * 3) f.label = f.options[0];
    }
  }
  return fields;
}

async function scanPage(page) {
  const all = [];
  const frames = page.frames();
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    try {
      const fields = await frame.evaluate(scanFrame, { attr: ATTR, prefix: `f${i}_` });
      for (const f of fields) {
        // Keep the frame handle for the filler, but out of JSON logs and prompts.
        Object.defineProperty(f, "frame", { value: frame, enumerable: false });
        all.push(f);
      }
    } catch {
      // Cross-origin or detached frames we can't evaluate in; skip them.
    }
  }
  return all;
}

// Job description context: the visible text of every frame, main frame first.
async function pageText(page) {
  const chunks = [];
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() => document.body?.innerText || "");
      if (t.trim()) chunks.push(t.trim());
    } catch {}
  }
  return chunks.join("\n\n---\n\n");
}

module.exports = { scanPage, pageText, ATTR };
