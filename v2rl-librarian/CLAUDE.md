# V2RETROLINK Drive filing — instructions for Claude

This directory holds the Drive Librarian tooling for the V2RETROLINK
engineering project. If you (Claude, in any session) produce a new,
finished V2RETROLINK engineering document — a CDR, OA, transmittal,
drawing, memo, or similar — during a session, follow this pipeline rather
than only leaving the document in chat or in local files:

1. **Upload it to the staging folder, not the inbox root.** Use whatever
   Drive access this session has (an MCP Drive connector, or by asking the
   user to run the script) to create the file under:

   `00_INBOX/_PENDING_REVIEW` — folder ID `1sBmr0ngEb0EuilP6gMY-hS5YfeSyMDbl`

   Do **not** upload directly to `00_INBOX` (ID `1HIhFeG8AK1-7Nu0PAMjGbIZ-ycltHLCu`)
   itself — that folder is scanned by the scheduled `--file-inbox` automation
   and anything landing there gets filed into canonical folders on the next
   run. `_PENDING_REVIEW` is a subfolder, so it's invisible to that scan
   (`--file-inbox` only lists 00_INBOX's direct children) — this is the
   review gate, not an accident to work around.

2. **Say so explicitly to the user** — name the file and note it's staged
   for ChatGPT peer review, not yet filed. ChatGPT has its own Drive write
   access and promotes approved files to `00_INBOX` itself (see README.md's
   "ChatGPT peer-review gate" section) — don't promote a file to `00_INBOX`
   yourself; that's the reviewer's action, not yours.

2a. **Check for a `<filename>_REVIEW_NOTES.md` file** next to anything you
   staged earlier, before assuming it's still pending. If one exists,
   ChatGPT sent that draft back for revision — read the notes, fix the
   document, re-upload the revised version to `_PENDING_REVIEW` in place
   of the old draft (don't leave both versions sitting there), and delete
   the now-addressed `_REVIEW_NOTES.md` file.

3. **Never write directly into a canonical folder** (`00_GOVERNING`,
   `04_SUPERSEDED`, etc.) for a newly-generated document. Filing into those
   is the automation's job, gated by review — bypassing that defeats the
   point of the pipeline.

If the review mechanism described in README.md changes (e.g. promotion
becomes automatic, or ChatGPT gets direct Drive write access), update this
file and README.md's "ChatGPT peer-review gate" section together so they
don't drift out of sync.
