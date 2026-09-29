// Offline check of field scanning + filling against test/fixture.html (no API calls).
const path = require("path");
const assert = require("assert");
const { chromium } = require("playwright");
const { scanPage } = require("../src/fields");
const { fillFields } = require("../src/fill");

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.JAB_CHROME || undefined });
  const page = await browser.newPage();
  await page.goto("file://" + path.join(__dirname, "fixture.html"));
  const fields = await scanPage(page);
  console.log(JSON.stringify(fields, null, 1));
  const find = (re) => fields.find((f) => re.test(f.label));
  const a = (f, value, selections = []) => ({ id: f.id, value, selections, source: "resume", needs_review: false, note: "" });
  const answers = [
    a(find(/First Name/), "Jane"),
    a(find(/Email/), "jane@example.com"),
    a(find(/Phone/), "+1 555 123 4567"),
    a(find(/Years/), "6-10"),
    a(find(/sponsorship/), "No"),
    a(find(/production/), null, ["Node.js", "PostgreSQL"]),
    { ...a(find(/Why do you want/), "Because billing is fun."), needs_review: true },
    a(find(/certify/), "true"),
  ];
  const results = await fillFields(fields, answers, { resume: path.join(__dirname, "fixture.html"), coverLetter: null });
  for (const r of results) console.log(r.status.padEnd(8), r.field.kind.padEnd(15), r.field.label.slice(0, 50), "=>", r.value ?? r.why);

  const v = await page.evaluate(() => {
    const f = document.forms[0];
    return {
      fn: f.first_name.value, email: f.email.value, phone: f.phone.value, exp: f.exp.value, spon: f.spon.value,
      tech: [...f.querySelectorAll("[name=tech]:checked")].map((e) => e.value), why: f.why.value,
      certify: f.certify.checked, resume: f.resume.files.length,
    };
  });
  assert.deepStrictEqual(v, { fn: "Jane", email: "jane@example.com", phone: "+1 555 123 4567", exp: "6-10", spon: "n", tech: ["node", "pg"], why: "Because billing is fun.", certify: false, resume: 1 });
  assert.ok(!fields.some((f) => f.name === "csrf"), "hidden fields must be ignored");
  console.log("\nsmoke test passed");
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
