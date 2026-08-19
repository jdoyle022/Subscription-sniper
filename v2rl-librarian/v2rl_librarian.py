#!/usr/bin/env python3
"""
v2rl_librarian.py — Google Drive Librarian Bot for the V2RETROLINK engineering project.

Automates repository governance for a Google Drive tree: moving loose/duplicate
files into their canonical folders, uploading a staged bundle of new documents
to the right destination folders, and auditing the current state of the tree.

--------------------------------------------------------------------------
SETUP (3 steps)
--------------------------------------------------------------------------
1. Enable the API:
   - Go to https://console.cloud.google.com/, create or select a project.
   - Navigate to "APIs & Services" -> "Library", search for "Google Drive API",
     and click Enable.
   - Navigate to "APIs & Services" -> "OAuth consent screen" and configure it
     (Internal if using a Workspace org, External + add yourself as a test
     user otherwise).

2. Create OAuth credentials:
   - Navigate to "APIs & Services" -> "Credentials" -> "Create Credentials"
     -> "OAuth client ID".
   - Application type: "Desktop app". Create it, then click "Download JSON".

3. Install the file:
   - Save the downloaded file as `credentials.json` in the same directory as
     this script.
   - Run any command (e.g. `python v2rl_librarian.py --audit`). A browser
     window will open for you to sign in and grant access; a `token.json`
     will be written next to the script so future runs are non-interactive.

--------------------------------------------------------------------------
USAGE
--------------------------------------------------------------------------
    python v2rl_librarian.py --audit
    python v2rl_librarian.py --reorganize --dry-run
    python v2rl_librarian.py --reorganize --yes
    python v2rl_librarian.py --upload /path/to/staging_folder --dry-run
    python v2rl_librarian.py --upload /path/to/bundle.zip --yes

See `--help` for the full flag list.
"""

from __future__ import annotations

import argparse
import fnmatch
import io
import logging
import os
import random
import re
import sys
import tempfile
import time
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Optional

try:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload
except ImportError:
    print(
        "Missing dependencies. Install them first:\n"
        "    pip install -r requirements.txt",
        file=sys.stderr,
    )
    sys.exit(1)


# ==========================================================================
# Configuration
# ==========================================================================

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CREDENTIALS_FILE = os.path.join(SCRIPT_DIR, "credentials.json")
TOKEN_FILE = os.path.join(SCRIPT_DIR, "token.json")
SCOPES = ["https://www.googleapis.com/auth/drive"]

FOLDER_MIME = "application/vnd.google-apps.folder"

# Canonical folder IDs, verified 2026-08-19 against the live Drive tree via
# the Google_Drive connector (see README.md "ID verification" section for
# the full audit trail). The IDs originally supplied in the project spec
# had systematic l/I and 0/O homoglyph typos (almost certainly from a
# screenshot transcription); every entry below is the corrected, confirmed
# real ID unless noted otherwise. ROOT itself is a folder literally named
# "To ChatGPT" — an unrelated name, but confirmed as the true parent of
# every other canonical folder below.
#
# Entries set to None are resolved at runtime by name lookup (searched by
# name directly under ROOT), because no folder existed to give a fixed ID
# for (06_DRAWINGS doesn't exist yet, per the reorganize spec).
FOLDER_IDS = {
    "ROOT": "1ckNuazhDn4zk6zfBGgEDaLlEtskyDX0o",  # was ...DaLIEtskyDX00 (typo)
    # Landing zone for new V2RETROLINK session outputs, watched by
    # `--file-inbox`. Created 2026-08-19; nothing else writes here.
    "00_INBOX": "1HIhFeG8AK1-7Nu0PAMjGbIZ-ycltHLCu",
    "00_GOVERNING": "1yaeIeXk0sQv-Pd4767le85fdV6mFizoC",  # was 1yaele... (typo)
    # Two duplicate 01_BENCH_EVIDENCE folders exist under ROOT from prior
    # provisioning runs; this is the one actually in use (already contains
    # BM-002..BM-005 subfolders). The other is empty. Hardcoded rather than
    # left to name-lookup because name-lookup can't disambiguate duplicates.
    "01_BENCH_EVIDENCE": "1Q0zAVt97KQ4-Z0ipFE3Y2Sw2EAKcWEkC",
    "02_PRODUCT_LINE": "1Q7D88g15_7ey05g0KVx7M1poKv57mte2",  # matched spec exactly
    "04_SUPERSEDED": "1OeKPySzzLKztuM1-J9Mb-6lv8vJZHDwi",  # was 10eKPy... (typo)
    "05_Open_Actions": "1gxPfGXkvBhM-X0E0U12G_L0Ag0GIiL6P",  # was ...G0GliL6P (typo)
    "05_SANDBOX": "14YB3Uq-ARVmtp-kK3D3HmSEkP9yOrjPp",  # matched spec exactly
    "06_DRAWINGS": "1VNawdbwFgKnEcDR5BDRA1SrFAf_JIBo2",  # created 2026-08-19 under ROOT
    "PARTNER_ROOT": "1TGm8cPS5nVE8tuGIMldNtXfxieqbi_xF",  # was ...GIMIdNt... (typo)
    "AI_REVIEW": "15K-HNfZpp1s1v1oG92Rz0vn3E2M5btRE",  # unique match, hardcoded
}

# Folders that are resolved by name (rather than a fixed ID) and the name to
# search/create under ROOT. Only 06_DRAWINGS needs this now — the others
# were resolved to a fixed ID above (see comments on FOLDER_IDS).
NAME_RESOLVED_FOLDERS = {
    "06_DRAWINGS": "06_DRAWINGS",
}


@dataclass
class MoveOp:
    file_id: str
    description: str
    dest_key: str
    expected_source_key: Optional[str] = None  # documentation only; not enforced


# File IDs verified 2026-08-19 against the live Drive tree via the
# Google_Drive connector, by searching each title/keyword from the spec
# under the relevant parent folder and cross-checking the result against
# the (typo-corrected) ID the spec supplied. Every entry below is a
# confirmed real file except "Partner Update 2": no file matching that
# description or ID could be found anywhere in the Drive tree (see
# README.md "ID verification" section) — it's left as an unresolved
# placeholder on purpose so validate_registry() skips it and reports it,
# rather than silently guessing.
REORGANIZE_PLAN: list[MoveOp] = [
    # --- Loose governance docs: ROOT -> 00_GOVERNING ---
    MoveOp("17BFKDQBHDVcU_fD6RV2kug0z4HgFzGiQ", "SPADR (Sensor Payload Allocation Decision Record)", "00_GOVERNING", "ROOT"),
    MoveOp("1g8UYcqzBoq31502CoKhV2kOAX9L1Ps69", "Pin Matrix & Open Actions", "00_GOVERNING", "ROOT"),
    MoveOp("112GHqllMqvblWEgqgpIYD0eiOi-qhLiy", "Requirements Matrix (System Requirements & Acceptance Matrix)", "00_GOVERNING", "ROOT"),
    MoveOp("1IKm8qJDRotXX45oZkf0mOr8QplqW5eX1", "Appendix G Decision Record", "00_GOVERNING", "ROOT"),
    MoveOp("1QJg24E2PYqb2Gb7D547q2nBwwUpNvD8C", "Engineering Pack OA005 Propagation Update", "00_GOVERNING", "ROOT"),
    MoveOp("14_ZbFFaEsAw9AmCuGquMZPf75zpIFhUI", "EPP Issue 2 (Evidence & Propagation Package, Corrected Issue 2)", "00_GOVERNING", "ROOT"),
    MoveOp("1c_mbPwKEdbrIvjjMjd2vyw6-ZYHgCcjO", "CDR Bundle (Controlled Decision Record Bundle)", "00_GOVERNING", "ROOT"),
    # --- Root duplicates: ROOT -> 04_SUPERSEDED ---
    # Earlier-created copy of the same Requirements Matrix doc kept at ROOT.
    MoveOp("1WEHzZIn1Wf2gcogbgE-fy324auZXxj_r", "Duplicate Requirements Matrix", "04_SUPERSEDED", "ROOT"),
    # Earlier-created copy of the same EPP Issue 2 doc kept at ROOT.
    MoveOp("195IkJb6KWsYSu63RLrU0lJ9IrnZOPKY7", "Duplicate EPP Issue 2", "04_SUPERSEDED", "ROOT"),
    # --- Stale OA / binder docs: 00_GOVERNING -> 04_SUPERSEDED ---
    MoveOp("1fLbdvAP7Z1lI-I5Yhi9lKsacmxNoNs4t", "OA-012 (IP67 Enclosure Design)", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("1nkGGolfMkmga3koi96MMaEwiN0IYAKB_", "OA-013 (Power Architecture: Solar Surplus Design Intent)", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("1wbONDsguS1ED6Tpp5JgA0jMK38vJjfMq", "OA-008 (LiDAR Trade Study Rev3)", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("1_jA7p8mjgnF1r8f1njfnVkN1blnKPmn7", "OA-010 (Node Handoff Protocol)", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("1cwc6oIdCq_il8VO3lf3VIrxZ3wPyWfGR", "OA-011 (LR-FHSS Radio Architecture Rev2)", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("19JGJaRIejN8m69Ui-LIeQT0xxATKp4TZ", "Master Program Binder 20260403", "04_SUPERSEDED", "00_GOVERNING"),
    MoveOp("13NiHIEWMa2A4hpAw0hdTQ2snVQumIdvz", "Drive Folder Plan", "04_SUPERSEDED", "00_GOVERNING"),
    # --- Partner continuity report -> Partner Root ---
    MoveOp("1cBokW4XHBtWYudvMo1c5koDXiZ3vmTRZ", "Partner_Continuity_Report_20260429", "PARTNER_ROOT", "00_GOVERNING"),
    # --- Closed CTO memos: 05_Open_Actions -> 01_BENCH_EVIDENCE ---
    MoveOp("1tYYImVJhChyfiTeT6VImg6_JkppO-Rs_", "CTO Memo BM-004 (LD2410C Serial Validation) - CLOSED", "01_BENCH_EVIDENCE", "05_Open_Actions"),
    MoveOp("1cKOdu3DKpVn1qAIfDq1cIW9gWXE0QEHp", "CTO Memo BM-005 (ESP32-C3 Sensor-Packet Translation) - CLOSED", "01_BENCH_EVIDENCE", "05_Open_Actions"),
    # --- Partner updates -> AI_REVIEW ---
    # Found 2026-08-19 in a follow-up audit sweep: the spec ID (1HK31CCH...)
    # had a 1/t homoglyph typo, not the usual l/I or 0/O pattern, which is
    # why the initial verification pass missed it.
    MoveOp("1HK3tCCHnFd8x4BhNnlogqklDoNnzGW7J8m7DxSA_4tw", "Partner Update 1 (ChatGPT Handoff Brief, May 22 2026)", "AI_REVIEW", "ROOT"),
    MoveOp("1BxA3qasBL8_FRiysGVgTFQhoEykOluIJ", "Partner Update 2 (All-Partner Update 20260506)", "AI_REVIEW", "ROOT"),
]

# --------------------------------------------------------------------------
# upload-bundle routing rules
# --------------------------------------------------------------------------

# Substring match (case-insensitive) against the filename -> destination key.
UPLOAD_KEYWORD_ROUTES: list[tuple[list[str], str]] = [
    (
        ["cdr-013", "cdr-014", "cdr-015", "cdr-016", "adj-001", "pam-001",
         "bom-ver-001", "tx-002", "handoff charter", "handoff_charter"],
        "00_GOVERNING",
    ),
    (["oa-017", "oa-018", "oa-019"], "05_Open_Actions"),
    (["kendryte", "k230"], "05_SANDBOX"),
]

# Glob patterns (case-insensitive) against the filename -> destination key.
UPLOAD_GLOB_ROUTES: list[tuple[list[str], str]] = [
    (["4runner_*.svg", "*puck*.svg", "render_*.svg"], "06_DRAWINGS"),
]

# --------------------------------------------------------------------------
# Retry / rate-limit handling
# --------------------------------------------------------------------------

RETRYABLE_STATUS_CODES = {403, 429, 500, 502, 503, 504}
RETRYABLE_403_REASONS = {"rateLimitExceeded", "userRateLimitExceeded", "backendError"}

# Mutable at runtime by main() from the --max-retries CLI flag; read at call
# time (not decoration time) so a single flag controls every retried call.
RETRY_CONFIG = {"max_retries": 5, "base_delay": 1.0}


def with_retry():
    """Decorator: retry a Drive API call on rate-limit / transient errors
    with exponential backoff + jitter. Non-retryable errors (e.g. a plain
    404 or a permission-denied 403) are raised immediately."""

    def decorator(func: Callable):
        def wrapper(*args, **kwargs):
            attempt = 0
            while True:
                try:
                    return func(*args, **kwargs)
                except HttpError as e:
                    status = getattr(e.resp, "status", None)
                    reason = ""
                    try:
                        reason = e.error_details[0].get("reason", "") if e.error_details else ""
                    except Exception:
                        reason = ""
                    retryable = status in RETRYABLE_STATUS_CODES and (
                        status != 403 or reason in RETRYABLE_403_REASONS or not reason
                    )
                    max_retries = RETRY_CONFIG["max_retries"]
                    base_delay = RETRY_CONFIG["base_delay"]
                    attempt += 1
                    if not retryable or attempt > max_retries:
                        raise
                    delay = base_delay * (2 ** (attempt - 1)) + random.uniform(0, 0.5)
                    logging.warning(
                        "Drive API transient error (status=%s, attempt %d/%d). "
                        "Retrying in %.1fs...",
                        status, attempt, max_retries, delay,
                    )
                    time.sleep(delay)

        return wrapper

    return decorator


# ==========================================================================
# Auth
# ==========================================================================

def get_credentials() -> Credentials:
    if not os.path.exists(CREDENTIALS_FILE):
        logging.error(
            "credentials.json not found at %s.\nSee the setup instructions "
            "at the top of this script (or README.md).", CREDENTIALS_FILE,
        )
        sys.exit(1)

    creds: Optional[Credentials] = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
            except Exception as e:
                logging.warning("Token refresh failed (%s); re-running auth flow.", e)
                creds = None
        if not creds or not creds.valid:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, "w") as f:
            f.write(creds.to_json())

    return creds


def get_service():
    creds = get_credentials()
    return build("drive", "v3", credentials=creds, cache_discovery=False)


# ==========================================================================
# Drive helpers
# ==========================================================================

@with_retry()
def _files_get(service, file_id, fields):
    return service.files().get(fileId=file_id, fields=fields, supportsAllDrives=True).execute()


@with_retry()
def _files_list(service, **kwargs):
    return service.files().list(supportsAllDrives=True, includeItemsFromAllDrives=True, **kwargs).execute()


@with_retry()
def _files_update(service, file_id, **kwargs):
    return service.files().update(fileId=file_id, supportsAllDrives=True, **kwargs).execute()


@with_retry()
def _files_create(service, **kwargs):
    return service.files().create(supportsAllDrives=True, **kwargs).execute()


def find_child_folder(service, parent_id: str, name: str) -> Optional[str]:
    query = (
        f"'{parent_id}' in parents and name = '{name}' "
        f"and mimeType = '{FOLDER_MIME}' and trashed = false"
    )
    result = _files_list(service, q=query, fields="files(id, name)", pageSize=10)
    files = result.get("files", [])
    if not files:
        return None
    if len(files) > 1:
        logging.warning(
            "Multiple folders named '%s' found under parent %s; using the first (%s).",
            name, parent_id, files[0]["id"],
        )
    return files[0]["id"]


def ensure_folder(service, parent_id: str, name: str, dry_run: bool = False) -> Optional[str]:
    existing = find_child_folder(service, parent_id, name)
    if existing:
        return existing
    if dry_run:
        logging.info("[DRY RUN] Would create folder '%s' under %s", name, parent_id)
        return None
    created = _files_create(
        service,
        body={"name": name, "mimeType": FOLDER_MIME, "parents": [parent_id]},
        fields="id",
    )
    logging.info("Created folder '%s' (%s) under %s", name, created["id"], parent_id)
    return created["id"]


def resolve_folder_ids(service, dry_run: bool = False) -> dict[str, str]:
    """Fill in FOLDER_IDS entries that are None via name lookup/creation."""
    resolved = dict(FOLDER_IDS)
    root = resolved["ROOT"]
    for key, name in NAME_RESOLVED_FOLDERS.items():
        if resolved.get(key):
            continue
        folder_id = ensure_folder(service, root, name, dry_run=dry_run)
        resolved[key] = folder_id
        if folder_id:
            logging.info("Resolved '%s' -> %s", key, folder_id)
        elif not dry_run:
            logging.error("Could not resolve or create folder '%s' under ROOT.", key)
    return resolved


def move_file(service, file_id: str, dest_folder_id: str, dry_run: bool = False,
              new_name: Optional[str] = None) -> tuple[bool, str]:
    """Move a file to dest_folder_id, replacing all of its current parents.
    If new_name is given, also renames the file in the same call (used by
    --file-inbox to apply dual-unit naming while filing)."""
    try:
        meta = _files_get(service, file_id, fields="id, name, parents, trashed")
    except HttpError as e:
        return False, f"could not fetch metadata ({e})"

    if meta.get("trashed"):
        return False, "file is trashed; skipped"

    current_parents = meta.get("parents", [])
    already_placed = current_parents == [dest_folder_id]
    if already_placed and not new_name:
        return True, "already in destination; no-op"

    display_name = new_name or meta.get("name")
    if dry_run:
        action = "rename + move" if new_name else "move"
        return True, f"[DRY RUN] would {action} '{meta.get('name')}' -> '{display_name}' in {dest_folder_id}"

    update_kwargs = {"fields": "id, parents, name"}
    if not already_placed:
        update_kwargs["addParents"] = dest_folder_id
        update_kwargs["removeParents"] = ",".join(current_parents) if current_parents else None
    if new_name:
        update_kwargs["body"] = {"name": new_name}

    try:
        _files_update(service, file_id, **update_kwargs)
    except HttpError as e:
        return False, f"move failed ({e})"

    verb = "renamed and moved" if new_name else "moved"
    return True, f"{verb} '{meta.get('name')}' -> '{display_name}' in {dest_folder_id}"


def is_placeholder_id(file_id: str) -> bool:
    """Heuristic check for a truncated/placeholder Drive ID."""
    return "..." in file_id or len(file_id) < 20


# ==========================================================================
# Command: reorganize
# ==========================================================================

def validate_registry(plan: list[MoveOp]) -> list[MoveOp]:
    bad = [op for op in plan if is_placeholder_id(op.file_id)]
    if bad:
        print(
            f"\n[!] {len(bad)} of {len(plan)} entries in REORGANIZE_PLAN still have "
            "placeholder/truncated file IDs and will be skipped:\n"
        )
        for op in bad:
            print(f"    - {op.description!r} (dest={op.dest_key}): {op.file_id}")
        print(
            "\nReplace these with the full file ID from each file's Drive share "
            "link before re-running. Continuing with the remaining valid entries.\n"
        )
    return [op for op in plan if not is_placeholder_id(op.file_id)]


def cmd_reorganize(service, dry_run: bool, assume_yes: bool) -> int:
    valid_ops = validate_registry(REORGANIZE_PLAN)
    if not valid_ops:
        logging.error("No valid move operations to run. Nothing to do.")
        return 1

    folders = resolve_folder_ids(service, dry_run=dry_run)

    print(f"\nPlanned moves ({len(valid_ops)}):")
    for op in valid_ops:
        dest_id = folders.get(op.dest_key) or "<unresolved>"
        print(f"  - {op.description} ({op.file_id}) -> {op.dest_key} [{dest_id}]")

    if not dry_run and not assume_yes:
        confirm = input(f"\nProceed with {len(valid_ops)} live moves on Google Drive? [y/N] ")
        if confirm.strip().lower() != "y":
            print("Aborted.")
            return 1

    ok_count, fail_count = 0, 0
    print()
    for op in valid_ops:
        dest_id = folders.get(op.dest_key)
        if not dest_id:
            print(f"[SKIP] {op.description}: destination '{op.dest_key}' not resolved")
            fail_count += 1
            continue
        success, message = move_file(service, op.file_id, dest_id, dry_run=dry_run)
        status = "OK" if success else "FAIL"
        print(f"[{status}] {op.description}: {message}")
        ok_count += 1 if success else 0
        fail_count += 0 if success else 1

    # 06_DRAWINGS is guaranteed by resolve_folder_ids(); confirm and report.
    print(f"\nSummary: {ok_count} succeeded, {fail_count} failed "
          f"({len(REORGANIZE_PLAN) - len(valid_ops)} skipped as placeholders).")
    return 0 if fail_count == 0 else 2


# ==========================================================================
# Command: upload-bundle
# ==========================================================================

# Note: a trailing \b is *not* enough here — filenames commonly delimit
# tokens with '_' (e.g. "2.5in_bracket.svg"), and '_' counts as a \w
# character, so "in" immediately followed by "_" would not be a \b boundary.
# Use an explicit negative lookahead instead so the unit isn't glued to a
# following letter/digit.
UNIT_TOKEN_RE = re.compile(r"(?P<value>\d+(?:\.\d+)?)\s?(?P<unit>in|mm)(?![a-zA-Z0-9])", re.IGNORECASE)


def normalize_dual_unit_name(filename: str) -> str:
    """Apply the CDR-013 / CDR-016 dual-unit naming convention: any bare
    imperial or metric measurement token in a filename gets the converted
    equivalent appended in brackets, e.g. '2.5in' -> '2.5in_63.5mm', so a
    dimension is never checked in without both units. If the filename
    already carries both an 'in' and an 'mm' token, it's left untouched."""
    stem, ext = os.path.splitext(filename)
    tokens = list(UNIT_TOKEN_RE.finditer(stem))
    units_present = {m.group("unit").lower() for m in tokens}
    if not tokens or {"in", "mm"} <= units_present:
        return filename

    m = tokens[0]
    value = float(m.group("value"))
    unit = m.group("unit").lower()
    if unit == "in":
        converted = f"{value * 25.4:.1f}mm"
    else:
        converted = f"{value / 25.4:.3f}in"

    insert_at = m.end()
    new_stem = f"{stem[:insert_at]}_{converted}{stem[insert_at:]}"
    return f"{new_stem}{ext}"


def route_upload_file(filename: str) -> Optional[str]:
    lower = filename.lower()
    for keywords, dest_key in UPLOAD_KEYWORD_ROUTES:
        if any(kw in lower for kw in keywords):
            return dest_key
    for patterns, dest_key in UPLOAD_GLOB_ROUTES:
        if any(fnmatch.fnmatch(lower, pat.lower()) for pat in patterns):
            return dest_key
    return None


def iter_bundle_files(path: str):
    if os.path.isdir(path):
        for root, _dirs, files in os.walk(path):
            for name in files:
                if name.startswith("."):
                    continue
                yield os.path.join(root, name)
    elif zipfile.is_zipfile(path):
        tmp_dir = tempfile.mkdtemp(prefix="v2rl_bundle_")
        with zipfile.ZipFile(path) as zf:
            zf.extractall(tmp_dir)
        for root, _dirs, files in os.walk(tmp_dir):
            for name in files:
                if name.startswith("."):
                    continue
                yield os.path.join(root, name)
    else:
        raise ValueError(f"'{path}' is neither a directory nor a zip archive.")


def find_existing_file(service, parent_id: str, name: str) -> Optional[str]:
    escaped = name.replace("'", "\\'")
    query = f"'{parent_id}' in parents and name = '{escaped}' and trashed = false"
    result = _files_list(service, q=query, fields="files(id, name)", pageSize=5)
    files = result.get("files", [])
    return files[0]["id"] if files else None


def upload_file(service, local_path: str, drive_name: str, dest_folder_id: str,
                 overwrite: bool, dry_run: bool) -> tuple[bool, str]:
    if dry_run:
        return True, f"[DRY RUN] would upload '{drive_name}' -> {dest_folder_id}"

    existing_id = find_existing_file(service, dest_folder_id, drive_name)
    media = MediaFileUpload(local_path, resumable=True)

    try:
        if existing_id:
            if not overwrite:
                return False, f"'{drive_name}' already exists in destination (use --overwrite to replace); skipped"
            _files_update(service, existing_id, media_body=media, fields="id")
            return True, f"updated existing '{drive_name}' ({existing_id})"
        else:
            created = _files_create(
                service,
                body={"name": drive_name, "parents": [dest_folder_id]},
                media_body=media,
                fields="id",
            )
            return True, f"uploaded '{drive_name}' ({created['id']})"
    except HttpError as e:
        return False, f"upload failed ({e})"


def cmd_upload_bundle(service, path: str, dry_run: bool, assume_yes: bool, overwrite: bool) -> int:
    if not os.path.exists(path):
        logging.error("Path does not exist: %s", path)
        return 1

    try:
        candidates = list(iter_bundle_files(path))
    except ValueError as e:
        logging.error(str(e))
        return 1

    routed = []
    unmatched = []
    for local_path in candidates:
        base_name = os.path.basename(local_path)
        dest_key = route_upload_file(base_name)
        if not dest_key:
            unmatched.append(local_path)
            continue
        drive_name = normalize_dual_unit_name(base_name)
        routed.append((local_path, drive_name, dest_key))

    print(f"\nFound {len(candidates)} file(s): {len(routed)} routed, {len(unmatched)} unmatched.\n")
    for local_path, drive_name, dest_key in routed:
        rename_note = f" (renamed from '{os.path.basename(local_path)}')" if drive_name != os.path.basename(local_path) else ""
        print(f"  - {os.path.basename(local_path)} -> {dest_key} as '{drive_name}'{rename_note}")
    if unmatched:
        print("\nUnmatched (no routing rule; will NOT be uploaded):")
        for local_path in unmatched:
            print(f"  - {local_path}")

    if not routed:
        print("\nNothing to upload.")
        return 0

    if not dry_run and not assume_yes:
        confirm = input(f"\nProceed with uploading {len(routed)} file(s) to Google Drive? [y/N] ")
        if confirm.strip().lower() != "y":
            print("Aborted.")
            return 1

    folders = resolve_folder_ids(service, dry_run=dry_run)

    ok_count, fail_count = 0, 0
    print()
    for local_path, drive_name, dest_key in routed:
        dest_id = folders.get(dest_key)
        if not dest_id:
            print(f"[SKIP] {drive_name}: destination '{dest_key}' not resolved")
            fail_count += 1
            continue
        success, message = upload_file(service, local_path, drive_name, dest_id, overwrite, dry_run)
        status = "OK" if success else "FAIL"
        print(f"[{status}] {message}")
        ok_count += 1 if success else 0
        fail_count += 0 if success else 1

    print(f"\nSummary: {ok_count} succeeded, {fail_count} failed, {len(unmatched)} unmatched/skipped.")
    return 0 if fail_count == 0 else 2


# ==========================================================================
# Command: file-inbox
# ==========================================================================
# Drive-to-Drive filer: scans 00_INBOX and moves each file straight to its
# canonical destination using the exact same routing rules as upload-bundle
# (UPLOAD_KEYWORD_ROUTES / UPLOAD_GLOB_ROUTES / normalize_dual_unit_name).
# This is the operation meant to run unattended (e.g. a scheduled CI job)
# with --yes: point new V2RETROLINK session outputs at 00_INBOX by any
# means (manual upload, another tool, another AI) and this sorts them.
# Purely deterministic — no AI judgment involved at run time.

def cmd_file_inbox(service, dry_run: bool, assume_yes: bool) -> int:
    folders = resolve_folder_ids(service, dry_run=dry_run)
    inbox_id = folders.get("00_INBOX")
    if not inbox_id:
        logging.error("00_INBOX folder not resolved.")
        return 1

    try:
        result = _files_list(
            service,
            q=f"'{inbox_id}' in parents and trashed = false",
            fields="files(id, name, mimeType)",
            pageSize=200,
        )
    except HttpError as e:
        logging.error("Could not list 00_INBOX contents: %s", e)
        return 1

    entries = [f for f in result.get("files", []) if f.get("mimeType") != FOLDER_MIME]
    routed = []
    unmatched = []
    for f in entries:
        dest_key = route_upload_file(f["name"])
        if not dest_key:
            unmatched.append(f)
            continue
        new_name = normalize_dual_unit_name(f["name"])
        routed.append((f, new_name, dest_key))

    print(f"\n00_INBOX: {len(entries)} file(s) found, {len(routed)} routed, {len(unmatched)} unmatched.\n")
    for f, new_name, dest_key in routed:
        rename_note = f" (renaming to '{new_name}')" if new_name != f["name"] else ""
        print(f"  - {f['name']} -> {dest_key}{rename_note}")
    if unmatched:
        print("\nUnmatched (left in place in 00_INBOX, no routing rule matched):")
        for f in unmatched:
            print(f"  - {f['name']}")

    if not routed:
        print("\nNothing to file.")
        return 0

    if not dry_run and not assume_yes:
        confirm = input(f"\nProceed with filing {len(routed)} file(s) out of 00_INBOX? [y/N] ")
        if confirm.strip().lower() != "y":
            print("Aborted.")
            return 1

    ok_count, fail_count = 0, 0
    print()
    for f, new_name, dest_key in routed:
        dest_id = folders.get(dest_key)
        if not dest_id:
            print(f"[SKIP] {f['name']}: destination '{dest_key}' not resolved")
            fail_count += 1
            continue
        rename_arg = new_name if new_name != f["name"] else None
        success, message = move_file(service, f["id"], dest_id, dry_run=dry_run, new_name=rename_arg)
        status = "OK" if success else "FAIL"
        print(f"[{status}] {message}")
        ok_count += 1 if success else 0
        fail_count += 0 if success else 1

    print(f"\nSummary: {ok_count} filed, {fail_count} failed, {len(unmatched)} left unmatched in 00_INBOX.")
    return 0 if fail_count == 0 else 2


# ==========================================================================
# Command: audit
# ==========================================================================

def list_all_files(service, folder_id: str) -> list[dict]:
    files = []
    page_token = None
    query = f"'{folder_id}' in parents and trashed = false"
    while True:
        result = _files_list(
            service,
            q=query,
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime)",
            pageSize=200,
            pageToken=page_token,
        )
        files.extend(result.get("files", []))
        page_token = result.get("nextPageToken")
        if not page_token:
            break
    return files


def cmd_audit(service) -> int:
    folders = resolve_folder_ids(service, dry_run=False)

    rows = []
    had_error = False
    for key in FOLDER_IDS.keys():
        folder_id = folders.get(key)
        if not folder_id:
            rows.append((key, "UNRESOLVED", 0, 0, "ERROR: could not resolve folder"))
            had_error = True
            continue
        try:
            meta = _files_get(service, folder_id, fields="id, name, trashed")
            if meta.get("trashed"):
                rows.append((key, folder_id, 0, 0, "ERROR: folder is trashed"))
                had_error = True
                continue
            files = list_all_files(service, folder_id)
            total_bytes = sum(int(f.get("size", 0) or 0) for f in files)
            rows.append((key, folder_id, len(files), total_bytes, "OK"))
        except HttpError as e:
            status = getattr(e.resp, "status", "?")
            rows.append((key, folder_id, 0, 0, f"ERROR: HTTP {status}"))
            had_error = True

    def human_size(n: int) -> str:
        size = float(n)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                return f"{size:.1f}{unit}"
            size /= 1024
        return f"{size:.1f}GB"

    header = ("Folder", "Folder ID", "Files", "Size", "Status")
    widths = [max(len(header[i]), max((len(str(r[i])) for r in rows), default=0)) for i in range(5)]

    def fmt_row(r):
        return "  ".join(str(r[i]).ljust(widths[i]) for i in range(5))

    print("\n" + fmt_row(header))
    print("  ".join("-" * w for w in widths))
    for key, folder_id, count, total_bytes, status in rows:
        print(fmt_row((key, folder_id, count, human_size(total_bytes), status)))

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    report_path = os.path.join(SCRIPT_DIR, "audit_report.md")
    with open(report_path, "w") as f:
        f.write(f"# V2RETROLINK Drive Audit — {timestamp}\n\n")
        f.write("| Folder | Folder ID | Files | Size | Status |\n")
        f.write("|---|---|---|---|---|\n")
        for key, folder_id, count, total_bytes, status in rows:
            f.write(f"| {key} | {folder_id} | {count} | {human_size(total_bytes)} | {status} |\n")

    print(f"\nWrote {report_path}")
    return 1 if had_error else 0


# ==========================================================================
# CLI
# ==========================================================================

def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="V2RETROLINK Google Drive Librarian Bot",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--reorganize", action="store_true",
                         help="Run Command 1: move loose/duplicate/stale files into canonical folders.")
    action.add_argument("--audit", action="store_true",
                         help="Run Command 3: audit canonical folders and print a state table.")
    action.add_argument("--upload", metavar="PATH", dest="upload_path",
                         help="Run Command 2: upload a staging directory or .zip bundle to canonical folders.")
    action.add_argument("--file-inbox", action="store_true",
                         help="Scan the 00_INBOX Drive folder and move each file to its canonical "
                              "destination using the same routing rules as --upload. No local path "
                              "needed -- designed to run unattended (pair with --yes).")

    parser.add_argument("--dry-run", action="store_true",
                         help="Preview actions without changing anything on Drive.")
    parser.add_argument("--yes", action="store_true",
                         help="Skip the interactive confirmation prompt for live (non-dry-run) runs.")
    parser.add_argument("--overwrite", action="store_true",
                         help="(upload only) Replace a file's content if a same-named file already exists in the destination folder.")
    parser.add_argument("--max-retries", type=int, default=5,
                         help="Max retries for rate-limited/transient Drive API errors (default: 5).")
    parser.add_argument("-v", "--verbose", action="store_true", help="Enable debug logging.")
    return parser


def main(argv=None) -> int:
    args = build_arg_parser().parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    RETRY_CONFIG["max_retries"] = args.max_retries

    service = get_service()

    if args.audit:
        return cmd_audit(service)
    if args.reorganize:
        return cmd_reorganize(service, dry_run=args.dry_run, assume_yes=args.yes)
    if args.upload_path:
        return cmd_upload_bundle(service, args.upload_path, dry_run=args.dry_run,
                                  assume_yes=args.yes, overwrite=args.overwrite)
    if args.file_inbox:
        return cmd_file_inbox(service, dry_run=args.dry_run, assume_yes=args.yes)

    return 1


if __name__ == "__main__":
    sys.exit(main())
