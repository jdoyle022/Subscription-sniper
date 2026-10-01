# Subscription Sniper

An API that cancels online subscriptions by driving a headless browser through each service's cancel flow. Requests go into a Redis-backed queue (BullMQ), and a separate worker process runs them with Playwright.

## Cancellation availability

**All eleven services are manual-only until individually validated.** The API
returns `422 manual_required` before encrypting or queuing credentials. Calling
any service module's exported `cancel()` also returns a manual-only result.
There is no environment-variable override for this gate.

Adobe, Canva, Disney+, Dropbox, Duolingo, Grammarly, Hulu, Netflix, NordVPN,
Notion and Spotify are recognized service names, not validated automations.
The previous guessed-selector flows remain private drafts in their files and
are unreachable through the exported entrypoints or worker.

## Cancellation safeguards

- Cancellation jobs have one attempt. A durable Redis claim blocks a second
  browser execution after a crash, stall, retry, or job-history removal.
- An atomic reservation binds `Idempotency-Key` to the requested account and
  target. One account/service can have only one reserved operation. Disney
  aliases share an identity. Account fences and request bindings do not expire
  with job history; only a reviewed reconciliation may clear them.
- Future enabled requests must identify `targetId` and supply `Idempotency-Key`.
  Retry uncertain enqueue responses with the same key. A changed target or
  another request on a reserved account returns `409`.
- Credential payloads are encrypted in a separate Redis key with a 15-minute
  TTL, consumed atomically before browser work, and excluded from job history.
  Expired credentials cannot start a cancellation.
- The guarded runner verifies account, target, direct billing, known terms,
  and zero cancellation fee before submission. It persists `submitting` before
  mutation, then requires a fresh target-specific billing-state verification.
  An already-cancelled target needs no submission.
- Outcomes are `confirmed`, `manual_required`, `failed_before_submission`, or
  `needs_review`. BullMQ `completed` means the processor returned; it does not
  mean a subscription was cancelled. Only `confirmed` has `success: true`.
- Browser-close, optional screenshots, and progress reporting cannot replay or
  overwrite a verified result. Raw browser errors are not returned or logged.
- Optional future screenshots mask inputs, use private directories/files
  (700/600), carry job-associated opaque references, and are purged after 24h
  while the worker runs. They can still contain account information; do not
  publish the screenshots directory. Missing images are never cited as evidence.

## Install

You need Node.js 20+ and a running Redis.

```bash
sudo ./Setup.sh                 # installs to /opt/subscription-sniper
APP_DIR=~/sniper ./Setup.sh     # or anywhere else
```

`Setup.sh` copies the app, generates a `.env` with random secrets (permissions 600), installs dependencies and Chromium, and prints the admin password once. Re-running it keeps an existing `.env`. See `.env.example` for every setting.

Run both processes:

```bash
npm start        # API server
npm run worker   # cancellation worker
```

The server and worker refuse to start if a secret is missing, too short, or a default.

## API

All endpoints except `/health` and `/api/auth/token` need `Authorization: Bearer <token>`.

| Method | Path | Body / notes |
| --- | --- | --- |
| `POST` | `/api/auth/token` | `{ "password": "<ADMIN_PASSWORD>" }` → `{ token }`. Rate-limited to 10 tries per 15 minutes. Tokens last `JWT_EXPIRES_IN` (default 12h). |
| `POST` | `/api/cancel` | Currently returns `422 manual_required` for every recognized service; no credentials are queued. Future enabled adapters also require `targetId` and an `Idempotency-Key` header. |
| `GET` | `/api/status/:jobId` | Job state and result. |
| `GET` | `/api/admin/jobs` | Recent jobs (admin token). |
| `GET` | `/health` | Liveness check. |

## Security notes

- Credentials for future validated jobs use an AES-256-GCM encrypted, expiring vault outside the job record.
- Terminal job history uses BullMQ age-based cleanup (not a guaranteed seven-day TTL). Operation fences are independent and persist.
- Cross-origin browser requests are blocked unless the origin is listed in `CORS_ORIGIN`.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limiting sees real client IPs.

## Development

```bash
npm install
npm test                                    # unit + API tests, plus one real-browser test
SKIP_BROWSER_TESTS=1 npm test               # without Chromium
CHROMIUM_PATH=/path/to/chromium npm test    # use a system Chromium
```

## Upgrade and service validation

Stop every old API and worker process before installing this version. Do not run
old workers alongside it: they can still execute the previous unsafe scripts.
Start the new worker to scrub legacy inline credentials across queued, active,
delayed, completed, and failed jobs; cleanup repeats every minute and reports
incomplete passes. Legacy jobs are drained to manual-only results without
logging in. This is best-effort recovery for old records; new vault credentials
have an enforced TTL. Redis persistence/backup retention remains an operator
responsibility.

Do not rotate the identity secret (`JWT_SECRET`) or clear `sniper:v2:*` reservation
keys to retry an uncertain operation. Doing so can invalidate duplicate protection.
Reconcile the provider account and stop workers before any deliberate rearm.

To promote a service, replace its guessed-selector draft with an audited adapter
implementing `inspect(page, credentials, targetId)`,
`submitCancellation(page, target)`, and `verify(page, targetId)`, and register it
in `VALIDATED_ADAPTERS` through a reviewed code change. Inspect/verify must identify
the account and exact subscription, read renewal status and cancellation state,
and verify must reload billing settings. Submit must scope unique controls to the
selected subscription, verify each flow state, and stop on unfamiliar offers,
fees, terms, or ambiguous controls. Broad page text is never confirmation.

For each service, manually validate normal and failed login, 2FA/CAPTCHA/SSO,
third-party billing, already-cancelled accounts, multiple plans/workspaces,
retention offers, slow transitions, fees, and post-submission disconnects. Record
the validation date, plan/billing variants, redacted evidence, and limitations.
Independently confirm renewal is off, the effective cancellation date, and any
provider confirmation email. No live service validation has been performed for
this change.

## Verification

`node --test test/safety.test.js test/crypto.test.js` runs dependency-free safety
and crypto checks. The safety tests use mocks; they do not validate provider
selectors. `REDIS_TEST_URL=redis://localhost:6379 npm test` also exercises the
actual Redis reservation/vault and queue integration. The GitHub Actions workflow
installs Chromium and Redis and runs the full suite without visiting live services.
