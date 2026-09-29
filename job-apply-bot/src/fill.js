// Types Claude's answers into the page. Never clicks submit.

const { ATTR } = require("./fields");

// Checkboxes that make a legal statement on the candidate's behalf are left for the human.
const ATTESTATION = /certif|attest|acknowledg|agree|consent|terms|privacy|accurate|true and complete|signature/i;
const RESUME_FIELD = /resume|cv|curriculum/i;
const COVER_FIELD = /cover/i;

const norm = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function bestOption(options, wanted) {
  const w = norm(wanted);
  let i = options.findIndex((o) => norm(o) === w);
  if (i < 0) i = options.findIndex((o) => norm(o).startsWith(w) || w.startsWith(norm(o)));
  if (i < 0) i = options.findIndex((o) => norm(o).includes(w) || w.includes(norm(o)));
  return i;
}

async function highlight(loc, color) {
  await loc.evaluate((el, c) => { el.style.outline = `3px solid ${c}`; el.style.outlineOffset = "2px"; }, color).catch(() => {});
}

async function fillOne(field, answer, files) {
  const frame = field.frame;
  const sel = (suffix = "") => frame.locator(`[${ATTR}="${field.id}${suffix}"]`).first();

  if (field.kind === "file") {
    const isCover = COVER_FIELD.test(field.label) && !RESUME_FIELD.test(field.label);
    const file = isCover ? files.coverLetter : files.resume;
    if (!file) return { status: "skipped", why: "no file for this upload" };
    await sel().setInputFiles(file);
    return { status: "filled", value: file };
  }

  if (!answer || (answer.value == null && !answer.selections?.length)) {
    await highlight(sel(field.options ? ":0" : ""), "#f59e0b");
    return { status: "blank", why: answer?.note || "no answer" };
  }

  switch (field.kind) {
    case "select": {
      const loc = sel();
      const opts = await loc.evaluate((el) => [...el.options].map((o) => o.text));
      const i = bestOption(opts, answer.value);
      if (i < 0) return { status: "blank", why: `no option matching "${answer.value}"` };
      await loc.selectOption({ index: i });
      return { status: "filled", value: opts[i] };
    }
    case "radio": {
      const i = bestOption(field.options, answer.value);
      if (i < 0) return { status: "blank", why: `no option matching "${answer.value}"` };
      await sel(`:${i}`).check({ force: true });
      return { status: "filled", value: field.options[i] };
    }
    case "checkbox": {
      const picked = [];
      for (const want of answer.selections) {
        const i = bestOption(field.options, want);
        if (i >= 0) { await sel(`:${i}`).check({ force: true }); picked.push(field.options[i]); }
      }
      return { status: picked.length ? "filled" : "blank", value: picked.join(", ") };
    }
    case "single_checkbox": {
      if (ATTESTATION.test(field.label)) {
        await highlight(sel(":0"), "#f59e0b");
        return { status: "blank", why: "attestation — tick it yourself after reviewing" };
      }
      if (answer.value === "true") await sel(":0").check({ force: true });
      return { status: "filled", value: answer.value };
    }
    case "combobox": {
      // Typeahead widgets (e.g. location pickers): type, then take the first suggestion.
      const loc = sel();
      await loc.fill("");
      await loc.pressSequentially(answer.value, { delay: 30 });
      await frame.waitForTimeout(800);
      await loc.press("ArrowDown").catch(() => {});
      await loc.press("Enter").catch(() => {});
      return { status: "filled", value: answer.value };
    }
    default: {
      await sel().fill(answer.value);
      return { status: "filled", value: answer.value };
    }
  }
}

async function fillFields(fields, answers, files, { overwrite = false } = {}) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const results = [];
  for (const field of fields) {
    const answer = byId.get(field.id);
    let r;
    if (field.currentValue && !overwrite) {
      results.push({ field, answer, status: "kept", value: field.currentValue });
      continue;
    }
    try {
      r = await fillOne(field, answer, files);
    } catch (e) {
      r = { status: "error", why: e.message.split("\n")[0] };
    }
    if (r.status === "filled" && answer?.needs_review) {
      await highlight(field.frame.locator(`[${ATTR}="${field.id}${field.options && field.kind !== "select" ? ":0" : ""}"]`).first(), "#3b82f6");
    }
    results.push({ field, answer, ...r });
  }
  return results;
}

module.exports = { fillFields, bestOption };
