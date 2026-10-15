#!/bin/sh
set -eu

# Wrangler appends its own v3 persistence segment to --persist-to. The runtime
# therefore uses /state/v3/v3/d1 when migrations target the /state/v3 root.
# Passing the already-nested directory would create an unused /v3/v3/v3 DB.
mkdir -p /var/lib/nexus-quant/wrangler/state/v3
npx wrangler d1 migrations apply DB --local --config /app/wrangler.server.jsonc --persist-to /var/lib/nexus-quant/wrangler/state/v3
umask 077
printf 'NQ_RELEASE_ID=%s\nNQ_COOKIE_SECURE=%s\nNQ_CREDENTIAL_MASTER_KEY=%s\nNQ_LIVE_RISK_ALLOWED=%s\nNQ_ALLOW_INSECURE_HTTP_LIVE=%s\nNQ_BINANCE_PROXY_URL=%s\nNQ_INTERNAL_RISK_TOKEN=%s\nNQ_INTERNAL_LIQUIDATION_TOKEN=%s\n' \
  "${NQ_RELEASE_ID:-unknown}" \
  "${NQ_COOKIE_SECURE:-false}" \
  "${NQ_CREDENTIAL_MASTER_KEY:?NQ_CREDENTIAL_MASTER_KEY is required}" \
  "${NQ_LIVE_RISK_ALLOWED:-true}" \
  "${NQ_ALLOW_INSECURE_HTTP_LIVE:-false}" \
  "${NQ_BINANCE_PROXY_URL:-http://binance-proxy:3100}" \
  "${NQ_INTERNAL_RISK_TOKEN:?NQ_INTERNAL_RISK_TOKEN is required}" \
  "${NQ_INTERNAL_LIQUIDATION_TOKEN:-}" > /app/.runtime.env
exec node /app/deploy/app-supervisor.mjs
