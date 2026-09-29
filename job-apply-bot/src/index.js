#!/usr/bin/env node
// Usage: node src/index.js <job-application-url> [--profile profile/profile.json] [--dry-run] [--overwrite]
//
// Opens the application in a real browser window, fills every field it can from
// your resume + profile, highlights what you should check, and waits. You review
// and click Submit yourself. For multi-page applications, click "Next" in the
// browser and press Enter here to fill the next page.

const fs = require("fs");
const path = require("path");
const readline = require("readline/promises");
const { chromium } = require("playwright");
const { loadProfile, ROOT } = require("./profile");
const { scanPage, pageText } = require("./fields");
const { answerFields } = require("./answer");
const { fillFields } = require("./fill");

function parseArgs(argv) {
  const args = { profile: "profile/profile.json", dryRun: false, overwrite: false, headless: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") args.profile = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--overwrite") args.overwrite = true;
    else if (a === "--headless") args.headless = true;
    else if (!a.startsWith("--")) args.url = a;
  }
  return args;
}

const ICON = { filled: "✓", kept: "=", blank: "·", skipped: "-", error: "✗" };
const short = (s, n = 70) => { s = String(s ?? "").replace(/\s+/g, " "); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

function report(results) {
  const review = [];
  for (const r of results) {
    const flag = r.answer?.needs_review || r.status === "blank" || r.status === "error";
    console.log(`${ICON[r.status] || "?"} ${flag ? "⚑" : " "} ${short(r.field.label, 55).padEnd(55)}  ${short(r.value ?? r.why, 60)}`);
    if (flag) review.push(r);
  }
  console.log(`\n${results.filter((r) => r.status === "filled").length} filled, ${review.length} flagged for review (⚑; blue outline = check wording, amber = needs your input).`);
}

async function fillCurrentPage(page, ctx, args, log) {
  const fields = await scanPage(page);
  if (!fields.length) { console.log("No form fields found on this page."); return; }
  console.log(`Found ${fields.length} fields. Asking Claude…`);
  const answers = await answerFields({ fields, jobText: await pageText(page), url: page.url(), profile: ctx.profile, resumeText: ctx.resumeText });

  if (args.dryRun) {
    for (const a of answers) {
      const f = fields.find((x) => x.id === a.id);
      console.log(`${a.needs_review ? "⚑" : " "} ${short(f.label, 55).padEnd(55)}  ${short(a.value ?? a.selections.join(", "), 60)}`);
    }
    log.pages.push({ url: page.url(), fields, answers });
    return;
  }
  const results = await fillFields(fields, answers, { resume: ctx.resumeFile, coverLetter: ctx.coverLetterFile }, { overwrite: args.overwrite });
  report(results);
  log.pages.push({ url: page.url(), results: results.map(({ field, answer, status, value, why }) => ({ field, answer, status, value, why })) });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error("Usage: node src/index.js <job-application-url> [--profile path] [--dry-run] [--overwrite]");
    process.exit(1);
  }
  const ctx = await loadProfile(args.profile);

  // A persistent profile keeps you logged in to Workday/iCIMS/etc. between runs.
  const browser = await chromium.launchPersistentContext(path.join(ROOT, ".browser-profile"), {
    headless: args.headless,
    viewport: null,
    executablePath: process.env.JAB_CHROME || undefined,
  });
  const page = browser.pages()[0] || (await browser.newPage());
  await page.goto(args.url, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const log = { url: args.url, startedAt: new Date().toISOString(), pages: [] };
  const logFile = path.join(ROOT, "runs", `${log.startedAt.replace(/[:.]/g, "-")}-${new URL(args.url).hostname}.json`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = "\n[Enter] fill this page (after clicking Next / Apply / logging in)   [q] quit  > ";
  let first = true;
  try {
    while (true) {
      const cmd = first ? "" : (await rl.question(prompt)).trim().toLowerCase();
      first = false;
      if (cmd === "q") break;
      try {
        await fillCurrentPage(page, ctx, args, log);
      } catch (e) {
        console.error(`Error: ${e.message}`);
      }
      fs.writeFileSync(logFile, JSON.stringify(log, null, 2));
      if (args.headless) break;
      console.log("\nReview the highlighted fields in the browser, then submit it yourself. The bot never clicks Submit.");
    }
  } finally {
    rl.close();
    console.log(`Log saved to ${path.relative(process.cwd(), logFile)}`);
    await browser.close();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
