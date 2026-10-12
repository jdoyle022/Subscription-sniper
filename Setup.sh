#!/bin/bash
# Installs Subscription Sniper from this repository into $APP_DIR
# (default /opt/subscription-sniper). Safe to re-run: an existing .env is kept.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/subscription-sniper}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null || { echo "Node.js 20+ is required." >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node.js 20+ is required (found $(node -v))." >&2; exit 1; }

mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp -r "$SRC_DIR"/package.json "$SRC_DIR"/src "$SRC_DIR"/.env.example "$APP_DIR"/
  [ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$APP_DIR"/
fi
echo "✓ files copied to $APP_DIR"

if [ -f "$APP_DIR/.env" ]; then
  echo "✓ keeping existing .env"
else
  rand() { node -e "console.log(require('crypto').randomBytes($1).toString('hex'))"; }
  ADMIN_PASSWORD=$(rand 16)
  umask 077
  cat > "$APP_DIR/.env" << ENVEOF
PORT=3000
NODE_ENV=production
JWT_SECRET=$(rand 64)
JWT_EXPIRES_IN=12h
ADMIN_PASSWORD=$ADMIN_PASSWORD
ENCRYPTION_KEY=$(rand 32)
REDIS_URL=redis://localhost:6379
CORS_ORIGIN=
TRUST_PROXY=
ENVEOF
  echo "✓ .env created (permissions 600)"
  echo ""
  echo "  Admin password: $ADMIN_PASSWORD"
  echo "  Save it now — it is only shown once (it is also in $APP_DIR/.env)."
  echo ""
fi

cd "$APP_DIR"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
echo "✓ dependencies installed"

# --with-deps installs Chromium's system libraries and needs root.
if [ "$(id -u)" -eq 0 ]; then npx playwright install --with-deps chromium; else npx playwright install chromium; fi
echo "✓ Chromium installed"

echo ""
echo "✅ Setup complete. Make sure Redis is running, then start both processes:"
echo "   cd $APP_DIR && npm start        # API server"
echo "   cd $APP_DIR && npm run worker   # cancellation worker"
