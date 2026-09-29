# job-apply-bot

Fills out job applications for you, using your resume. It opens the posting in a real
Chrome window, reads every form field, asks Claude to answer each one from your resume
and profile (tailoring free-text answers to that job's description), fills them in, and
highlights anything you should look at. **You review and click Submit yourself** — the
bot never submits.

## Setup

```bash
cd job-apply-bot
npm install
npx playwright install chromium        # one-time browser download
export ANTHROPIC_API_KEY=sk-ant-...
cp profile/profile.example.json profile/profile.json
cp ~/path/to/resume.pdf profile/resume.pdf   # .pdf, .docx, .txt or .md
```

Edit `profile/profile.json`: contact info, work authorization, salary, start date,
EEO answers, and any stock answers (`customAnswers`) you want reused verbatim.
Everything in `profile/` except the example is git-ignored.

## Use

```bash
npm run apply -- "https://boards.greenhouse.io/acme/jobs/123"
```

1. The page opens and the first page of the form is filled automatically.
2. The terminal lists each field: `✓` filled, `=` already had a value (kept), `·` left blank, `⚑` check it.
   In the browser, **blue outline** = filled but worth reading (tailored text, borderline answers),
   **amber outline** = needs your input.
3. Multi-page forms (Workday, iCIMS, …): click Next in the browser, then press Enter in the terminal to fill the new page.
   Log in by hand when a site needs an account; the browser profile in `.browser-profile/` keeps you logged in next time.
4. Review, fix, submit. Press `q` to quit.

Options:

| Flag | |
|---|---|
| `--dry-run` | Print the answers without typing them into the page |
| `--overwrite` | Replace values the site already filled in (by default they're kept) |
| `--profile <path>` | Use a different profile (e.g. one per resume variant) |

Every run writes the questions and answers to `runs/` so you have a record of what you sent.

Environment: `JAB_MODEL` overrides the model (default `claude-opus-5-5`); `JAB_CHROME` points at a specific Chrome binary.

## What it will and won't do

- Facts (employers, dates, degrees, skills, years of experience) only come from your resume or profile. If something isn't there, the field is left blank and flagged rather than guessed.
- Demographic/EEO questions come only from your profile; if a value is empty it picks "decline to answer".
- Checkboxes that certify/attest/agree to terms are never ticked for you.
- Resume file inputs get your resume; cover-letter uploads get `coverLetterFile` if you set one.
- CAPTCHAs, account creation, and email verification are left to you.
- Some sites' terms prohibit automated tools — you're submitting under your own name, so stay in the loop.

## Test

`npm test` runs an offline check of field detection and filling against `test/fixture.html` (no API calls).
