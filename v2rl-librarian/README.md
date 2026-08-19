# V2RETROLINK Drive Librarian

A standalone Python CLI that automates Google Drive governance for the
V2RETROLINK engineering project: reorganizing loose/duplicate/stale files
into their canonical folders, uploading a staged bundle of new documents to
the right destinations, and auditing the current state of the Drive tree.

## Setup (3 steps)

1. **Enable the API** — In [Google Cloud Console](https://console.cloud.google.com/),
   create or select a project, go to **APIs & Services → Library**, search
   for **Google Drive API**, and click **Enable**. Then go to
   **APIs & Services → OAuth consent screen** and configure it (Internal if
   you're on a Workspace org, External + add yourself as a test user
   otherwise).
2. **Create OAuth credentials** — Go to **APIs & Services → Credentials →
   Create Credentials → OAuth client ID**, choose **Desktop app**, create it,
   then click **Download JSON**.
3. **Install the file** — Save the downloaded file as `credentials.json` in
   this directory. The first command you run will open a browser window to
   sign in and grant access, then write a `token.json` here so future runs
   are non-interactive.

```bash
pip install -r requirements.txt
```

## Commands

```bash
# Command 3: audit — prints + writes audit_report.md
python v2rl_librarian.py --audit

# Command 1: reorganize — preview first, then run for real
python v2rl_librarian.py --reorganize --dry-run
python v2rl_librarian.py --reorganize --yes

# Command 2: upload-bundle — from a directory or a .zip
python v2rl_librarian.py --upload /path/to/staging_folder --dry-run
python v2rl_librarian.py --upload /path/to/bundle.zip --yes

# Command 4: file-inbox — Drive-to-Drive, no local path needed.
# Scans the 00_INBOX Drive folder and files each item using the same
# routing rules as upload-bundle. This is the one meant to run unattended
# (see "Unattended automation" below).
python v2rl_librarian.py --file-inbox --dry-run
python v2rl_librarian.py --file-inbox --yes
```

Flags: `--dry-run` previews without changing Drive, `--yes` skips the
confirmation prompt on a live run, `--overwrite` lets `--upload` replace an
existing same-named file, `--max-retries N` tunes rate-limit backoff,
`-v`/`--verbose` enables debug logging.

## ID verification (2026-08-19)

`REORGANIZE_PLAN` and `FOLDER_IDS` were originally seeded from truncated
example IDs in the project spec (e.g. `17BFKDQB...`), which can't resolve to
real files or folders. These were then verified and corrected against the
live Drive tree (via a separate connector with read/write Drive access, not
this script) by searching for each named document/folder and cross-checking
the result:

- **Root cause of the truncation**: nearly every spec ID differed from the
  real one by a single `l`/`I` or `0`/`O` character — almost certainly a
  screenshot-transcription artifact (those glyphs are visually identical in
  many fonts). Once corrected, 20 of the 21 `REORGANIZE_PLAN` file IDs and
  all 9 `FOLDER_IDS` folder IDs matched real files/folders exactly or via
  that single-character fix.
- **`ROOT`** resolves to a folder actually named "To ChatGPT" — an unrelated
  name, but confirmed as the real parent of every other canonical folder.
- **Duplicate folders exist** under Root from what looks like multiple
  provisioning runs: two extra `01_BENCH_EVIDENCE`, `00_GOVERNING`,
  `02_PRODUCT_LINE`, and `04_SUPERSEDED` folders sit alongside the ones
  actually in use. `FOLDER_IDS` is hardcoded to the folder that's actually
  in use in each case (for `01_BENCH_EVIDENCE`, confirmed by checking which
  one already contains the `BM-002`–`BM-005` evidence subfolders) — this
  matters because the old name-lookup fallback would otherwise have picked
  arbitrarily between duplicates. These extra empty duplicates aren't
  touched by this tool; clean them up manually if desired.
- **"Partner Update 1" was initially unresolved, then found**: the spec ID
  (`1HK31CCH...`) had a `1`/`t` homoglyph typo — a different pattern than
  the `l`/`I`/`0`/`O` swaps everywhere else, which is why the first pass
  missed it. It resolved to "V2RETROLINK — ChatGPT Handoff Brief | May 22
  2026" (`1HK3tCCHnFd8x4BhNnlogqklDoNnzGW7J8m7DxSA_4tw`), found sitting
  loose at Root. All 21 `REORGANIZE_PLAN` entries are now resolved and were
  executed live on 2026-08-19.
- **Further clutter found at Root during a follow-up audit, left untouched
  on purpose** (out of scope for the original plan — flag for a future,
  separately-approved cleanup pass if wanted):
  - Two more stale duplicate docs sitting loose at Root: another "Master
    Program Binder Claude.docx" (`1eV9NvHVU3F5_ANIJYEM55tNXxr6n7n80`,
    older, distinct from the one already filed in `00_GOVERNING`) and
    another "RevA Library Manifest Claude.docx"
    (`1N5DIeZaJ3Ag-HrpB2jCDmnH__2u8IuOZ`, superseded by the "_Updated_"
    version already in `00_GOVERNING`).
  - A third, entirely different abandoned folder-naming generation under
    Root, using a `10_/20_/30_/40_/50_` numbering scheme
    (`10_BENCH_EVIDENCE`, `20_PRODUCT_LINE`, `30_DRAFTS`,
    `40_REFERENCE`, `50_SUPERSEDED`), all empty, alongside the
    `00_/01_/02_/03_/04_`-numbered duplicate generation already noted
    above. At least three separate provisioning attempts appear to have
    happened over time.

`--audit` and `--upload` don't depend on `REORGANIZE_PLAN` at all, so they
work regardless of the above.

## Folder resolution

Folder IDs with a fixed value in `FOLDER_IDS` are used as-is. `06_DRAWINGS`
has no fixed ID in the spec — it's resolved by searching for a folder with
that name directly under Root, and created there automatically if missing.

`00_INBOX` (`1HIhFeG8AK1-7Nu0PAMjGbIZ-ycltHLCu`) was created 2026-08-19 as
the landing zone `--file-inbox` watches. Point new V2RETROLINK session
outputs there by whatever means (manual drag-and-drop, another tool, another
AI) and either run `--file-inbox` yourself or let the scheduled workflow
pick them up (see "Unattended automation" below).

## Unattended automation

`--file-inbox` is designed to run with no human or AI in the loop at
execution time — it's pure deterministic routing against the rules below.
A GitHub Actions workflow (`.github/workflows/v2rl-librarian-inbox.yml`,
one level up from this directory) runs it on a schedule (every 6 hours by
default; edit the `cron` line to change that) and can also be triggered
manually from the repo's Actions tab.

**One-time setup** (you only do this once, not per-run):

1. Complete the interactive OAuth setup above (steps 1–3) locally, then run
   any command once, e.g. `python v2rl_librarian.py --audit`. Sign in
   through the browser prompt. This produces `credentials.json` and
   `token.json` in this directory.
2. In the GitHub repo, go to **Settings → Secrets and variables → Actions →
   New repository secret** and add two secrets:
   - `V2RL_CREDENTIALS_JSON` — paste the full contents of `credentials.json`
   - `V2RL_TOKEN_JSON` — paste the full contents of `token.json`
3. That's it. The workflow writes both files from the secrets before each
   run and deletes them from the runner afterward — neither file is ever
   committed to the repo. Never commit `credentials.json` or `token.json`
   yourself either (both are in `.gitignore`).

This works because the OAuth token contains a refresh token: Google issues
a new short-lived access token from it automatically on every run, with no
browser interaction needed, for as long as the refresh token stays valid
(until you revoke access or don't use it for an extended period). If it
ever does expire or get revoked, redo step 1 and update the
`V2RL_TOKEN_JSON` secret.

## Upload routing rules

| Filename match | Destination |
|---|---|
| `CDR-013/014/015/016`, `ADJ-001`, `PAM-001`, `BOM-VER-001`, `TX-002`, `Handoff Charter` | `00_GOVERNING` |
| `OA-017/018/019` | `05_Open_Actions` |
| `Kendryte` / `K230` | `05_SANDBOX` |
| `4runner_*.svg`, `*puck*.svg`, `render_*.svg` | `06_DRAWINGS` |
| anything else | left alone, reported as unmatched |

Files are also renamed to satisfy the CDR-013/CDR-016 dual-unit naming
convention as implemented here: if a filename contains a bare `in` or `mm`
measurement token without its converted counterpart, the conversion is
appended (e.g. `Bracket_2.5in.svg` → `Bracket_2.5in_63.5mm.svg`). Adjust
`normalize_dual_unit_name()` if your actual CDR-013/CDR-016 text specifies a
different format.

## Safety notes

- Both `--reorganize` and `--upload` prompt for confirmation before making
  any live change unless `--yes` is passed; `--dry-run` never touches Drive.
- Drive API calls are wrapped with exponential-backoff retry on rate-limit
  and transient server errors (HTTP 429/500/502/503/504, and 403s whose
  reason is a rate-limit variant); permission or not-found errors are not
  retried and are reported immediately.
- `--upload` skips a file whose name already exists in the destination
  folder unless `--overwrite` is passed.
