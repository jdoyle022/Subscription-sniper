# Alpaca Trader

A self-hosted trading desk for an [Alpaca](https://alpaca.markets) brokerage account. It has a web
interface for trading by hand, and AI "seats" (Claude, ChatGPT, Grok, or any other bot) that read
your account and market data and **propose** trades. You approve or reject each proposal.

```
 You (web desk) ──────────────┐
                              ▼
 Claude / ChatGPT / Grok ─► proposal queue ─► you approve ─► risk guard ─► Alpaca
 (in-app or external)         (read + propose only)            (every order)
```

## What it does

**Trading (you)**
- Account summary: equity, day P/L, cash, buying power, day-trade count.
- Positions with live P/L. Close one position, or flatten everything.
- Orders: open, closed or all, including bracket legs. Cancel one or cancel all.
- Trades everything Alpaca's Trading API offers: **stocks and ETFs, crypto, and US options**.
  The symbol box searches tradable assets as you type.
- Stock/crypto ticket: market, limit, stop, stop-limit, trailing stop; sized by quantity or
  dollars; day/GTC/IOC/FOK/OPG/CLS; extended hours; bracket, OCO and OTO orders.
- **Options tab**: pick an underlying and expiration to see the chain (bid, ask, last, IV,
  delta). Click an ask to add a buy leg or a bid to add a sell leg. One leg sends a normal
  option order; 2 to 4 legs send one multi-leg (`mleg`) order. That covers verticals,
  straddles, strangles, iron condors, butterflies, calendars, and collars or covered calls
  with a stock leg. "Use mid" fills the net price (positive = debit, negative = credit).
- Option positions get an **Exercise** button.
- "Preview risk" before you send. Every submission asks you to confirm, and the confirm dialog
  is red when you are in live mode.
- A kill switch that blocks every new order. Cancels and closes still work.

**AI seats**
- Claude (Anthropic), ChatGPT (OpenAI) and Grok (xAI) built in. Ask one seat, or ask the
  **Council** to put the same question to every configured seat at once.
- Seats use tools to read the account, positions, orders, quotes, bars, the market clock, asset
  details and the risk limits. The one action they have is `propose_order`.
- Proposals land in a queue with the seat's rationale, its confidence and a risk preview. You
  approve or reject each one. Proposals expire after `PROPOSAL_TTL_MINUTES`.
- External bots connect with their own tokens through **MCP** (Claude Desktop, Claude Code, and
  other MCP clients) or **HTTP/OpenAPI** (ChatGPT Custom GPT Actions, Grok bots, your scripts).

**Safety**
- Paper trading is the default. Live mode will not start unless you set the exact
  confirmation phrase.
- A risk guard checks every order right before submission, including approved proposals. It
  checks the kill switch, allow and deny lists, the daily order cap, the maximum dollars per
  order, the maximum position size as a % of equity, and blocks shorting unless you allow it.
- Options are sized by what they can lose. A long option is sized by premium × 100. A short
  put is sized by strike × 100. A strategy is sized by its net debit, plus the strike width
  of any credit spread. Short options must be covered: a call by 100 shares per contract, a
  put by cash, or either by a long leg of the same type. Anything else is a naked short and is
  blocked unless `ALLOW_SHORT_OPTIONS=true`. Allow and deny lists match an option's underlying
  (`SPY` covers SPY options).
- A proposal executes at most once. Its Alpaca `client_order_id` is derived from the proposal
  id, so Alpaca itself rejects a duplicate.
- AI seats cannot place, cancel or change orders. The only exception is the
  `AI_PAPER_AUTO_EXECUTE` flag, which works in paper mode only and is ignored in live mode.
- Every order, block, cancel, proposal, decision and AI run is written to `data/audit.jsonl`.
  You can read it in the Audit log tab.
- The server binds to `127.0.0.1` by default. Admin and agent tokens are separate, and
  agent tokens cannot reach admin routes. Failed logins are rate-limited. The UI uses a
  strict CSP and renders all AI text as plain text.

## Setup

You need Node.js 22 or newer and an Alpaca account. Paper trading is free.

```bash
cd alpaca-trader
npm install
cp .env.example .env
```

Edit `.env`:

1. `ADMIN_TOKEN`: generate one with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   This is your login for the web desk.
2. `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`: from the Alpaca dashboard. Use **Paper Trading →
   API Keys** for paper. Live keys are different keys.
3. Any AI keys you want: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`. A seat without
   a key stays empty.
4. Review the risk limits (`MAX_ORDER_NOTIONAL`, `MAX_POSITION_PCT`, …).

```bash
npm start
# open http://127.0.0.1:8787 and paste your ADMIN_TOKEN
```

### Sign in with Alpaca instead of API keys (Alpaca Connect)

Alpaca Connect is Alpaca's OAuth 2.0 login. Use it instead of pasting API keys:

1. Register an OAuth app in the Alpaca dashboard. Set its redirect URI to
   `http://127.0.0.1:8787/oauth/callback`, or to `PUBLIC_URL` + `/oauth/callback`.
2. Put the client id and secret in `ALPACA_OAUTH_CLIENT_ID` and `ALPACA_OAUTH_CLIENT_SECRET`.
3. Restart, then click **Connect with Alpaca** in the header and approve the app on Alpaca.

The token is stored in `data/oauth.json` (mode 600). It is tied to the mode it was granted for:
a paper token is never used in live mode. **Disconnect Alpaca** deletes it. When connected,
the OAuth token is used instead of any API keys.

### Options

Your Alpaca account needs an options approval level. The Options stat on the desk shows it.
Level 1 covers covered calls and cash-secured puts, level 2 adds long calls and puts, and
level 3 adds spreads and straddles. Free accounts get the `indicative` options feed; set
`ALPACA_OPTIONS_FEED=opra` if you pay for real-time OPRA data. Option orders are whole
contracts, day or GTC, with no extended hours.

### Going live

Set both of these, then restart:

```
TRADING_MODE=live
LIVE_TRADING_CONFIRM=I accept live trading risk
```

Use your live API keys. The header badge turns red and every confirm dialog warns that real
money is involved. Run on paper first.

## Hooking up AI

### In-app seats (simplest)

Add the API key to `.env` and restart. The seat appears in the **AI seats** tab. You can change
the model with `CLAUDE_MODEL`, `OPENAI_MODEL` or `XAI_MODEL`.

- Claude uses the official Anthropic SDK with adaptive thinking (`CLAUDE_EFFORT` sets the
  depth), and server-side refusal fallbacks are turned on (`fallbacks: "default"`).
- ChatGPT and Grok use the official OpenAI SDK. Grok points it at `https://api.x.ai/v1`.

### External bots: give each one a token

```
AGENT_TOKENS=claude-desktop:<token1>,custom-gpt:<token2>,grok-bot:<token3>
```

Each token can read data and propose orders. Its proposals are labelled with its name.

### Claude Desktop / Claude Code (MCP)

Keep the app running, then add an MCP server. For Claude Desktop, put this in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "alpaca-trader": {
      "command": "node",
      "args": ["/absolute/path/to/alpaca-trader/src/mcp.js"],
      "env": {
        "TRADER_URL": "http://127.0.0.1:8787",
        "TRADER_AGENT_TOKEN": "<token1>"
      }
    }
  }
}
```

For Claude Code:
`claude mcp add alpaca-trader --env TRADER_URL=http://127.0.0.1:8787 --env TRADER_AGENT_TOKEN=<token1> -- node /absolute/path/to/alpaca-trader/src/mcp.js`

Any other MCP-capable assistant can use the same command.

### ChatGPT (Custom GPT Actions)

ChatGPT needs a public HTTPS URL. Put the app behind a reverse proxy with TLS, or use a
tunnel (Cloudflare Tunnel, ngrok, Tailscale Funnel). Set `PUBLIC_URL=https://your-host`, then
in the GPT editor:

1. **Actions → Import from URL** → `https://your-host/openapi.json`
2. **Authentication → API Key → Bearer** → `<token2>`

Exposing the app publicly also exposes the web desk login. Use a long `ADMIN_TOKEN`. If your
proxy allows it, publish only `/api/agent/*` and `/openapi.json`.

### Grok bots, scripts, anything else (HTTP)

```bash
# list tools
curl -H "Authorization: Bearer <token3>" http://127.0.0.1:8787/api/agent/tools

# read data
curl -X POST -H "Authorization: Bearer <token3>" http://127.0.0.1:8787/api/agent/tools/get_positions

# propose a trade (goes to your queue)
curl -X POST -H "Authorization: Bearer <token3>" -H "Content-Type: application/json" \
  -d '{"symbol":"MSFT","side":"buy","qty":2,"type":"limit","limit_price":395,"rationale":"..."}' \
  http://127.0.0.1:8787/api/agent/tools/propose_order

# check what happened to it
curl -H "Authorization: Bearer <token3>" http://127.0.0.1:8787/api/agent/proposals/<id>
```

## Tools available to every seat

| Tool | What it does |
|---|---|
| `get_account` | Equity, cash, buying power, mode, PDT status |
| `get_positions` | Open positions with P/L |
| `get_orders` | Open, closed or all orders |
| `get_quote` | Snapshot: latest quote, last trade, daily bar |
| `get_bars` | Historical OHLCV bars (1Min … 1Week) |
| `get_clock` | Market open/close times |
| `get_asset` | Tradable, fractionable and shortable flags |
| `search_assets` | Find stocks/ETFs or crypto by symbol or name |
| `get_option_contracts` | Option contracts for an underlying: expirations, strikes, open interest |
| `get_option_chain` | Chain with quotes, IV and greeks, filtered by expiration and strike range |
| `get_risk_limits` | The desk's limits and kill-switch state |
| `propose_order` | Queue a proposal for your approval. Does not trade. Stocks, crypto, single options, or 2–4 leg `mleg` strategies |

## Admin HTTP API

Every route needs `Authorization: Bearer <ADMIN_TOKEN>`.

| Method | Path | |
|---|---|---|
| GET | `/api/status` | Mode, kill switch, seats, limits |
| GET | `/api/account`, `/api/clock`, `/api/positions` | |
| GET | `/api/orders?status=open\|closed\|all` | |
| GET | `/api/quote/:symbol`, `/api/bars/:symbol`, `/api/asset/:symbol` | URL-encode crypto pairs (`BTC%2FUSD`) |
| GET | `/api/portfolio-history?period=1M&timeframe=1D`, `/api/activities` | |
| GET | `/api/assets?asset_class=us_equity\|crypto&q=` | Asset search |
| GET | `/api/options/expirations/:underlying` | Listed expiration dates |
| GET | `/api/options/chain/:underlying?expiration_date=&strike_price_gte=&strike_price_lte=&type=` | Chain with greeks |
| GET | `/api/options/contracts?underlying=&type=&expiration_date=` | Contract list |
| POST | `/api/positions/:symbol/exercise` | Exercise an option position |
| GET / POST | `/api/oauth/start`, `/api/oauth/disconnect` | Alpaca Connect |
| POST | `/api/orders/preview` | Validate and risk-check without sending |
| POST | `/api/orders` | Place an order |
| PATCH / DELETE | `/api/orders/:id` | Replace or cancel |
| DELETE | `/api/orders` | Cancel all |
| DELETE | `/api/positions/:symbol?qty=&percentage=` | Close a position |
| DELETE | `/api/positions` | Flatten all |
| POST | `/api/killswitch` `{ "on": true }` | |
| GET | `/api/proposals?status=pending` | |
| POST | `/api/proposals/:id/approve`, `/api/proposals/:id/reject` | |
| POST | `/api/ai/chat` `{ provider, message, history }` | provider: `claude`, `chatgpt`, `grok` or `council` |
| GET | `/api/audit?limit=200` | |

## Tests

```bash
npm test
```

The tests use a fake Alpaca backend and stub AI clients, so they need no keys or network.

## Limits and notes

- Alpaca's Trading API covers stocks/ETFs, crypto and options, and all three are wired in.
  Bonds and treasuries are offered through Alpaca's Broker API, not the Trading API, so they
  are not included.
- Covered-call coverage counts the shares you hold, but not shares already covering other
  short calls. Watch for that if you write several covered calls on the same stock.
- Market data defaults to the free IEX feed. Set `ALPACA_DATA_FEED=sip` if you pay for SIP.
- State is a JSON file in `data/`. This is a single-user desk, not a multi-tenant service.
- If the process dies while a proposal is executing, the proposal stays `executing`. Check
  Alpaca for an order with `client_order_id = prop-<id>` before acting on it again.
- Nothing here is investment advice, and AI proposals can be wrong. The risk limits are a
  safety net, not a strategy.
