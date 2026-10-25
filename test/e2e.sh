#!/usr/bin/env bash
# End-to-end test against a local D1 database: starts `wrangler dev`, posts every sample
# email to the local email handler, then prints what landed in the tables.
set -euo pipefail
cd "$(dirname "$0")/.."
FROM="${FROM:-you@example.com}"        # must be in ALLOWED_SENDERS
TO="flights@example.com"
PORT=8799
RP_ID=localhost
ORIGIN="http://localhost:$PORT"

rm -rf .wrangler/state; mkdir -p .wrangler
# The config's [build] would run the UI build; the API tests don't need it, so use a copy without it and without the custom-domain route (dev would rewrite Host/Origin).
# (It must sit next to wrangler.toml so relative paths resolve.)
CFG=wrangler.e2e.toml
BASE=wrangler.toml; [ -f "$BASE" ] || BASE=wrangler.example.toml
grep -v '^\[build\]\|^command = "npm run build:ui"\|^routes = ' "$BASE" > "$CFG"
npx wrangler d1 migrations apply flight-memory --local --config "$CFG" >/dev/null
[ -d public ] || { mkdir -p public; echo '<!doctype html><title>placeholder</title>' > public/index.html; }
node --import tsx test/auth-unit.ts
node --import tsx test/flightaware-unit.ts
node --import tsx test/seat-prompt-unit.ts
SETSID=(setsid)
command -v setsid >/dev/null || SETSID=(perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' --)
"${SETSID[@]}" npx wrangler dev --config "$CFG" --port "$PORT" --var RP_ID:"$RP_ID" --var ORIGIN:"$ORIGIN" --var API_TOKEN:test-token --var ALLOWED_SENDERS:"$FROM" --var MY_NAME:"John Smith" --var PROMPT_FROM:"$TO" --var SEAT_PROMPT_TO:you@example.com >.wrangler/dev.log 2>&1 &
DEV=$!
cleanup() { rm -f "$CFG"; mkdir -p .wrangler/replies; cp .wrangler/tmp/email/*/reply/*.eml .wrangler/replies/ 2>/dev/null || true; kill -- -"$DEV" 2>/dev/null || true; pkill -x workerd 2>/dev/null || true; }
trap cleanup EXIT
for _ in $(seq 1 60); do curl -s "localhost:$PORT" >/dev/null 2>&1 && break; sleep 1; done

for f in test/samples/*.eml; do
  from="$FROM"; [[ "$f" == *unknown-sender* ]] && from="mallory@evil.example"
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "localhost:$PORT/cdn-cgi/handler/email?from=$from&to=$TO" \
    -H 'Content-Type: message/rfc822' --data-binary @"$f")
  echo "posted $(basename "$f") -> HTTP $code"
done

q() { npx wrangler d1 execute flight-memory --local --config "$CFG" --json --command "$1" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.table(JSON.parse(s)[0].results))'; }
echo; echo "== emails";       q "SELECT id, status, email_type, parse_method, substr(subject,1,45) AS subject FROM emails"
echo "== flights"
q "SELECT id, carrier_code||flight_number AS flt, dep_airport||'-'||arr_airport AS route, dep_local, dep_offset AS off, duration_min AS min, distance_mi AS mi, aircraft_type, seat, seat_type, purchased_class AS bought, flown_class AS flown, upgrade_type, cash_cost, cash_currency AS cur, status FROM flights"

echo; echo "== edit API checks"
API="localhost:$PORT" RP_ID="$RP_ID" ORIGIN="$ORIGIN" TOKEN=test-token FROM="$FROM" TO="$TO" node test/e2e-api.mjs
echo "(reply emails the Worker would have sent are copied to .wrangler/replies/)"
