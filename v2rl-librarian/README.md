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
```

Flags: `--dry-run` previews without changing Drive, `--yes` skips the
confirmation prompt on a live run, `--overwrite` lets `--upload` replace an
existing same-named file, `--max-retries N` tunes rate-limit backoff,
`-v`/`--verbose` enables debug logging.

## Important: fill in real file IDs before running `--reorganize`

The move plan in `REORGANIZE_PLAN` (top of `v2rl_librarian.py`) was seeded
from truncated example IDs (e.g. `17BFKDQB...`). Google Drive file IDs are
fixed-length opaque strings, so a truncated one can't resolve to a real
file. Before running `--reorganize` for real:

1. Open each source file in Drive, copy the ID out of its share link
   (`drive.google.com/file/d/<FULL_ID>/view`).
2. Replace the corresponding placeholder in `REORGANIZE_PLAN`.

The script won't silently fail on this — `validate_registry()` scans the
plan up front, prints exactly which entries still look like placeholders,
skips only those, and runs the rest. `--audit` and `--upload` don't depend
on this list at all, so they work out of the box.

## Folder resolution

Folder IDs with a fixed value in `FOLDER_IDS` are used as-is. Three folders
(`01_BENCH_EVIDENCE`, `06_DRAWINGS`, `AI_REVIEW`) have no fixed ID in the
spec — they're resolved by searching for a folder with that name directly
under Root, and created there automatically if missing (matching the
`reorganize` requirement that `06_DRAWINGS` exists under Root).

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
