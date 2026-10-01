# Subscription Sniper

An API that cancels online subscriptions by driving a headless browser through each service's cancel flow. Requests go into a Redis-backed queue (BullMQ), and a separate worker process runs them with Playwright.

## Supported services

Adobe, Canva, Disney+, Dropbox, Duolingo, Grammarly, Hulu, Netflix, NordVPN, Notion, Spotify.

These sites change their pages often and use 2FA, captchas, emailed login codes and retention offers, so a script can stop partway through. Each script checks for confirmation text at the end. If it can't find any, the job returns `needsReview: true` rather than claiming success, and screenshots of each step are saved in `screenshots/`. Subscriptions billed through Apple or Google Play can't be cancelled here.

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
| `POST` | `/api/cancel` | `{ service, userId, credentials: { email, password }, billingSource? }` → `{ jobId }`. Unsupported services and `billingSource: "apple"`/`"google"` get `422 manual_required`. |
| `GET` | `/api/status/:jobId` | Job state and result. |
| `GET` | `/api/admin/jobs` | Recent jobs (admin token). |
| `GET` | `/health` | Liveness check. |

## Security notes

- Service passwords are encrypted with AES-256-GCM before they are queued, and deleted from Redis once a job finishes for good.
- Job history is kept for 7 days.
- Cross-origin browser requests are blocked unless the origin is listed in `CORS_ORIGIN`.
- Behind a reverse proxy, set `TRUST_PROXY=1` so rate limiting sees real client IPs.

## Development

```bash
npm install
npm test                                    # unit + API tests, plus one real-browser test
SKIP_BROWSER_TESTS=1 npm test               # without Chromium
CHROMIUM_PATH=/path/to/chromium npm test    # use a system Chromium
```

To add a service, create `src/scripts/services/<name>.js` exporting `cancel(page, credentials, screenshot)`, using the helpers in `src/scripts/helpers.js`, and register it in `SERVICES` in `src/scripts/index.js`.
