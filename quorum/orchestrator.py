#!/usr/bin/env python3
"""Quorum round orchestrator (00-RULES-004 §3, AUTOMATION.md).

Runs one round for one subject:
  health check -> Pass 1 (blind, parallel) -> Pass 2 (cross-examination, parallel)

Every seat return is written to a local outbox first (fail loudly: nothing is
dropped). The CoS files the outbox to the Quorum Drive folder. Nothing here
decides anything, votes, or trades.

Stdlib only, so it runs on the Pi without installs:
  python3 orchestrator.py --subject 50 --packet Q-50-PACKET-002.md            # dry run
  python3 orchestrator.py --subject 50 --packet Q-50-PACKET-002.md --live     # real API calls

Keys come from environment variables only (never files, never logs):
  PERPLEXITY_API_KEY  OPENAI_API_KEY  GEMINI_API_KEY  MISTRAL_API_KEY  COHERE_API_KEY
A seat with no key is recorded ABSTAIN (§3.4). Seat 1 (Buildpad) has no API and is
always ABSTAIN here unless ferried by hand (§5). Seat 3 (Claude, Steward) never votes.

Locks enforced in code: no Grok/xAI endpoint, no PRC-hosted endpoint, no router.
"""

import argparse
import concurrent.futures
import datetime
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Voting seats with an API. Model names are overridable via env (e.g. QUORUM_MODEL_4).
SEATS = {
    2: {"service": "perplexity", "key": "PERPLEXITY_API_KEY", "model": "sonar-pro",
        "url": "https://api.perplexity.ai/chat/completions", "style": "openai",
        "role": "Research / market intelligence"},
    4: {"service": "chatgpt", "key": "OPENAI_API_KEY", "model": "gpt-5",
        "url": "https://api.openai.com/v1/chat/completions", "style": "openai",
        "role": "Spec/CPO"},
    5: {"service": "gemini", "key": "GEMINI_API_KEY", "model": "gemini-2.5-pro",
        "url": "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        "style": "gemini", "role": "Artifacts, technical drafting"},
    6: {"service": "mistral", "key": "MISTRAL_API_KEY", "model": "mistral-large-latest",
        "url": "https://api.mistral.ai/v1/chat/completions", "style": "openai",
        "role": "Efficiency / alternative approaches + engineering and delivery feasibility"},
    7: {"service": "cohere", "key": "COHERE_API_KEY", "model": "command-a-03-2025",
        "url": "https://api.cohere.com/v2/chat", "style": "cohere",
        "role": "Contrarian / red team (runs the kill test in Pass 1)"},
}

# Permanent locks (00-RULES-004 header, §0.1). Checked before every call.
BANNED_HOST_FRAGMENTS = ["x.ai", "grok", "deepseek", "moonshot", "kimi", "bigmodel", "z.ai",
                         "dashscope", "aliyun", "alibaba", "openrouter"]

RETURN_NAME = re.compile(r"^(\d{2})-([1-7])-(\d{3})-([a-z0-9]+)\.md$")

SYSTEM = """You are seat {seat} ({role}) on John Doyle's Quorum, a multi-AI advisory board.
The President (John Doyle) decides; you advise. Follow the packet exactly:
use its scorecard headings word-for-word, respect its word cap, pick one of its
verdict options, state your confidence, and give 1-3 checkable predictions with a
check date or trigger. Never invent a statistic, source or confidence level; mark
anything unverifiable UNKNOWN and say what would resolve it."""

PASS2 = """PASS 2 — CROSS-EXAMINATION.
Below are every seat's Pass 1 answers to the same packet. For each other seat, say
whether you AGREE, DISAGREE or want to ADD, and why. Then restate your verdict,
confidence and predictions, noting any change from your Pass 1 position and the reason.
Same headings, same word cap.

=== PACKET ===
{packet}

=== PASS 1 ANSWERS ===
{answers}"""


class Abort(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_locks(url):
    host = url.split("/")[2].lower()
    for bad in BANNED_HOST_FRAGMENTS:
        if bad in host:
            raise Abort(f"LOCK VIOLATION: endpoint host {host} is prohibited (00-RULES-004)")


def post(url, headers, body, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def call_seat(seat, system, user):
    cfg = SEATS[seat]
    key = os.environ[cfg["key"]]
    model = os.environ.get(f"QUORUM_MODEL_{seat}", cfg["model"])
    url = cfg["url"].format(model=model)
    check_locks(url)
    if cfg["style"] == "openai":
        data = post(url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    {"model": model, "messages": [{"role": "system", "content": system},
                                                  {"role": "user", "content": user}]})
        return data["choices"][0]["message"]["content"], model
    if cfg["style"] == "gemini":
        data = post(url, {"x-goog-api-key": key, "Content-Type": "application/json"},
                    {"systemInstruction": {"parts": [{"text": system}]},
                     "contents": [{"role": "user", "parts": [{"text": user}]}]})
        return "".join(p.get("text", "") for p in data["candidates"][0]["content"]["parts"]), model
    if cfg["style"] == "cohere":
        data = post(url, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    {"model": model, "messages": [{"role": "system", "content": system},
                                                  {"role": "user", "content": user}]})
        return "".join(c.get("text", "") for c in data["message"]["content"]), model
    raise Abort(f"unknown style for seat {seat}")


class Round:
    def __init__(self, args):
        self.a = args
        self.subject = f"{int(args.subject):02d}"
        self.packet = Path(args.packet).read_text()
        self.outbox = Path(args.outbox) / f"{self.subject}-{datetime.date.today():%Y%m%d}"
        self.outbox.mkdir(parents=True, exist_ok=True)
        self.calls = 0
        self.manifest = {"subject": self.subject, "packet": Path(args.packet).name,
                         "mode": "LIVE" if args.live else "DRY-RUN", "started": now(),
                         "seats": {}, "files": [], "errors": []}

    def guard(self):
        if Path(self.a.kill_file).exists():
            raise Abort(f"kill switch present: {self.a.kill_file}")
        if self.calls >= self.a.max_calls:
            raise Abort(f"call cap reached ({self.a.max_calls})")

    def counter(self, seat):
        # Next legal counter = highest known for this subject/seat + 1 (never reused).
        start = self.a.start_counter.get(seat, 1)
        used = [int(m.group(3)) for f in self.outbox.glob("*.md")
                if (m := RETURN_NAME.match(f.name)) and m.group(1) == self.subject and int(m.group(2)) == seat]
        return max([start - 1] + used) + 1

    def write(self, seat, pass_no, text, model):
        name = f"{self.subject}-{seat}-{self.counter(seat):03d}-{SEATS[seat]['service']}.md"
        if not RETURN_NAME.match(name) or seat == 3:
            raise Abort(f"illegal return file name {name}")
        path = self.outbox / name
        if path.exists():
            raise Abort(f"refusing to overwrite {path}")
        header = (f"# {name}\n\n**Seat:** {seat} ({SEATS[seat]['service']}, model `{model}`)  \n"
                  f"**Subject:** {self.subject} · **Pass:** {pass_no} · **Packet:** {self.manifest['packet']}  \n"
                  f"**Filed:** {now()} by the Quorum orchestrator on the seat's behalf\n\n---\n\n")
        path.write_text(header + text.strip() + "\n")
        self.manifest["files"].append({"file": name, "seat": seat, "pass": pass_no})
        return name

    def health(self):
        live = []
        self.manifest["seats"]["1"] = "ABSTAIN (no API; manual ferry only, 00-RULES-004 §5)"
        for seat, cfg in SEATS.items():
            if seat in self.a.skip:
                self.manifest["seats"][str(seat)] = "ABSTAIN (skipped by operator)"
            elif not os.environ.get(cfg["key"]):
                self.manifest["seats"][str(seat)] = f"ABSTAIN (no {cfg['key']})"
            else:
                self.manifest["seats"][str(seat)] = "AVAILABLE"
                live.append(seat)
        return live

    def run_pass(self, seats, pass_no, user_for):
        results = {}

        def one(seat):
            self.guard()
            self.calls += 1
            system = SYSTEM.format(seat=seat, role=SEATS[seat]["role"])
            if not self.a.live:
                return seat, f"[DRY RUN] Seat {seat} Pass {pass_no} would answer here.", "dry-run"
            text, model = call_seat(seat, system, user_for(seat))
            return seat, text, model

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(seats) or 1) as ex:
            futs = {ex.submit(one, s): s for s in seats}
            for f in concurrent.futures.as_completed(futs):
                seat = futs[f]
                try:
                    _, text, model = f.result()
                    self.write(seat, pass_no, text, model)
                    results[seat] = text
                except Abort:
                    raise
                except (urllib.error.HTTPError, urllib.error.URLError, KeyError, TimeoutError) as e:
                    msg = f"seat {seat} pass {pass_no} FAILED: {type(e).__name__}: {e}"
                    self.manifest["errors"].append(msg)
                    self.manifest["seats"][str(seat)] = f"FAILED in pass {pass_no}"
                    print(msg, file=sys.stderr)
        return results

    def run(self):
        try:
            seats = self.health()
            print(json.dumps(self.manifest["seats"], indent=2))
            if not seats:
                raise Abort("no voting seat is available — nothing to run")
            p1 = self.run_pass(seats, 1, lambda s: self.packet)
            answers = "\n\n".join(f"--- Seat {s} ({SEATS[s]['service']}) ---\n{t}" for s, t in sorted(p1.items()))
            self.run_pass(sorted(p1), 2, lambda s: PASS2.format(packet=self.packet, answers=answers))
        except Abort as e:
            self.manifest["errors"].append(f"ABORTED: {e}")
        finally:
            self.manifest["finished"] = now()
            self.manifest["status"] = "FAILED" if self.manifest["errors"] else "COMPLETE"
            (self.outbox / "MANIFEST.json").write_text(json.dumps(self.manifest, indent=2))
            print(f"\n{self.manifest['status']}: {len(self.manifest['files'])} files in {self.outbox}")
            for e in self.manifest["errors"]:
                print("  " + e, file=sys.stderr)
        return 0 if self.manifest["status"] == "COMPLETE" else 1


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--subject", required=True)
    p.add_argument("--packet", required=True, help="approved packet file (Q-{subject}-PACKET-nnn.md)")
    p.add_argument("--live", action="store_true", help="make real API calls (default: dry run)")
    p.add_argument("--outbox", default="quorum-outbox")
    p.add_argument("--kill-file", default="QUORUM_KILL")
    p.add_argument("--max-calls", type=int, default=12, help="hard cap on API calls per round")
    p.add_argument("--skip", type=int, nargs="*", default=[], help="seats to record ABSTAIN")
    p.add_argument("--start-counter", default="{}",
                   help='JSON map of seat -> next legal counter from Drive, e.g. \'{"2": 1}\'')
    args = p.parse_args()
    args.start_counter = {int(k): v for k, v in json.loads(args.start_counter).items()}
    sys.exit(Round(args).run())


if __name__ == "__main__":
    main()
