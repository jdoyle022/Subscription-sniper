# Quorum runner and console

- `orchestrator.py` runs one Quorum round per `00-RULES-004` §3: seat health check, Pass 1 (blind, parallel), Pass 2 (cross-examination). Stdlib only. Dry run by default; `--live` makes real API calls.
- `console.html` is the source of the Quorum Console artifact (https://claude.ai/artifact/FZMfLsRg8Jd2CARDtoeUpX): decisions waiting on the President, orders to the CoS (which fire the "Quorum CoS" routine), and the live NOW file from Drive.

## Run a round

```sh
export PERPLEXITY_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... MISTRAL_API_KEY=... COHERE_API_KEY=...
python3 orchestrator.py --subject 50 --packet Q-50-PACKET-002.md            # dry run
python3 orchestrator.py --subject 50 --packet Q-50-PACKET-002.md --live     # real round
```

A seat without a key is recorded ABSTAIN. Returns land in `quorum-outbox/<subject>-<date>/` with a `MANIFEST.json`; the CoS files them to the Quorum Drive folder unchanged. Touch `QUORUM_KILL` to stop a round between calls; `--max-calls` caps spend. Override a seat's model with `QUORUM_MODEL_<seat>`. Only run a packet the President has approved.
