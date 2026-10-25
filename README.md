# Flight Memory: your flight log, fed by email

Forward flight confirmation emails to an address on your own domain. A Cloudflare Worker parses them, enriches each flight with time zones, duration, distance and aircraft details, and saves **one row per flight you take** to a D1 database (Cloudflare's hosted SQLite). It replies with what it saved. A passkey-protected web UI and a small JSON API let you fill in what an email can't tell you.

Everything runs on your own Cloudflare account. There is no hosted service.

## How it works

```
Gmail ──forward──▶ Email Routing ──▶ Worker ─┬─ 1. embedded schema.org flight data (free, exact)
                                             ├─ 2. else Claude API extraction (optional)
                                             ├─ your seat / class / share of the cost (via MY_NAME)
                                             ├─ enrich: time zones · UTC · duration · miles · aircraft family · seat type
                                             └─ upsert → D1 `flights` (hand edits are never overwritten)
```

- **Intake:** Cloudflare Email Routing hands each message to the Worker's email handler. Only senders in `ALLOWED_SENDERS` are parsed; others are logged as `rejected`.
- **Parsing:** most airline emails embed schema.org JSON-LD flight data, which is parsed exactly and for free. Without it, the Worker falls back to Claude if `ANTHROPIC_API_KEY` is set.
- **Web UI:** a static single-page app (source in `ui/`) served as Worker assets: sortable flight table, edit form, yearly stats. Login is passkey-only (WebAuthn).
- **Crons:** a daily job (09:17 UTC) can look up tail numbers via FlightAware, and a job every 30 minutes can email you a "what seat were you in?" prompt after landing.

## What's on each row

| Field(s) | Automatic | Notes |
|---|---|---|
| `dep_local`, `dep_tz`, `dep_offset`, `dep_utc` (and `arr_*`) | ✅ | Local time from the email. The zone and UTC offset come from the airport, DST-aware. A missing "+1" on an arrival is fixed. |
| `duration_min`, `distance_mi` | ✅ | Duration from the UTC times; distance is great-circle in statute miles. |
| `carrier_code`, `flight_number`, `airline`, `confirmation_code` | ✅ | |
| `aircraft_family`, `aircraft_type` | ✅ when the email names the aircraft | `77W`, `B789` and `Airbus A321neo` are all recognised (`src/aircraft.ts`). |
| `aircraft_registration`, `aircraft_name` | by hand | Not in confirmation emails. |
| `seat` | ✅ | Your seat, picked out by `MY_NAME`. |
| `seat_type` | partly | `A` is always window. Economy on A320/737/757/A220 maps A/F window, C/D aisle, B/E middle. Otherwise set it by hand. |
| `purchased_class`, `flown_class` | ✅ | Economy · Premium Economy · Business · First. See below. |
| `upgrade_type` | ✅ if the email says why, else by hand | `complimentary_upgrade` · `op_up` · `mileage_upgrade` · `cash_upgrade` · `bid_upgrade` · `certificate_upgrade` · `op_down` · `voluntary_downgrade` |
| `upgrade_points_cost`, `upgrade_cash_cost`, `upgrade_cash_currency` | ✅ if stated | What the upgrade cost on this flight. |
| `fare_type` (cash/award), `points_cost`, `points_program`, `cash_cost`, `cash_currency` | ✅ from receipts | Your share for this flight; see below. |
| `comments` | by hand | |

### Purchased vs flown class

1. The first class an email shows for a flight is recorded as `purchased_class`. A *change* email (a rebooking) can update it.
2. If a later email shows you in a different cabin, it's recorded as `flown_class` and `purchased_class` stays as booked. A boarding pass in Business on an Economy booking is an example.
3. If the email says why (an upgrade confirmation, a downgrade notice), `upgrade_type` is filled in too. Otherwise you set the reason:
   ```bash
   curl -X PATCH -H "$AUTH" $API/api/flights/12 -d '{"upgrade_type":"op_up"}'
   ```
4. Until something changes, `flown_class` simply follows `purchased_class`.

`GET /flights?upgraded=1` lists every flight where the two differ.

### Cost per flight

Receipts show a booking total, so the Worker turns it into a per-flight cost:
1. **It works out your share.** If the receipt itemises per passenger, it takes your amount. Otherwise it divides the total by the number of passengers.
2. **It splits your share across the booking's flights by distance.** That gives a sensible number for cents-per-mile and similar comparisons.

Edit any flight's cost by hand if the airline priced it differently.

### Manual edits stick

Anything you set through the API is recorded in the row's `manual_fields`, and later emails won't overwrite it.
- To let emails and auto-fill take over a field again, send `{"unlock": ["field"]}`.
- If you re-forward an older email, it only fills empty fields, so it can't roll back a newer seat or schedule. Cost is the exception: re-forwarding a receipt reapplies it.

## Setup

### Prerequisites

- A Cloudflare account
- A domain whose DNS is on Cloudflare (Email Routing only works for such domains). If you registered it elsewhere, add it under **Add a domain**, switch the nameservers at your registrar, wait for it to show **Active**, and delete any imported **MX** records Cloudflare DNS holds for it, since Email Routing needs to own them.
- Node 20+

### 1. Install and configure

```bash
git clone https://github.com/ebfg/flightlogs.git && cd flightlogs
npm install
npx wrangler login
cp wrangler.example.toml wrangler.toml     # gitignored; holds your real values
```

Edit `wrangler.toml`. Replace `example.com`, `you@example.com` and the database id:

| Setting | Meaning | Required |
|---|---|---|
| `routes` pattern | Domain the web UI is served on (custom domain; DNS record is created on deploy) | yes |
| `database_id` | Id of your D1 database (next step) | yes |
| `send_email` `destination_address` | Address the seat prompts are sent to | only for seat prompts |
| `RP_ID` | Passkey relying party: the UI's domain | yes |
| `ORIGIN` | Exact origin of the UI, e.g. `https://example.com` | yes |
| `ALLOWED_SENDERS` | Comma-separated addresses allowed to forward emails in | yes |
| `MY_NAME` | Your name as printed on tickets (comma-separate variants); used to pick your seat and cost share out of multi-passenger bookings | yes |
| `CLAUDE_MODEL` | Model for the Claude fallback parser | no |
| `REPLY_ENABLED` | `"false"` stops the Worker replying with a summary | no |
| `FLIGHTAWARE_DRY_RUN` | Only the string `"true"` means dry run | no |
| `PROMPT_FROM` | Sender of seat prompts, an address on your domain | only for seat prompts |
| `SEAT_PROMPT_TO` | Recipient of seat prompts; must equal the `send_email` `destination_address` and be a verified Email Routing destination | only for seat prompts |
| `SEAT_PROMPTS` | `"false"` turns seat prompts off | no |

### 2. Database

```bash
npx wrangler d1 create flight-memory      # copy the printed database_id into wrangler.toml
npm run db:migrate                        # creates the tables; rerun after pulling new migrations
```

### 3. Secrets

```bash
npx wrangler secret put API_TOKEN            # required: any long random string; protects the API
npx wrangler secret put ANTHROPIC_API_KEY    # optional: Claude fallback parser
npx wrangler secret put FLIGHTAWARE_API_KEY  # optional: daily aircraft lookup
```

### 4. Deploy

```bash
npm run deploy                            # builds the web UI (npm run build:ui), then deploys
```

### 5. Route your address to the Worker

1. In the Cloudflare dashboard, open **Email Routing** for your domain (under **Compute → Email Service**, or **your domain → Email** on older dashboards).
2. Select **Onboard Domain** (or **Enable**) and accept the DNS records it proposes: MX records, an SPF TXT record and a DKIM TXT record.
3. Open **Routing rules → Create routing rule**: pattern `flights` @ `example.com`, action **Send to a Worker** → `flight-memory`. You don't need to verify a destination address for this, since nothing is forwarded to a mailbox.

(`$API` and `$AUTH` are defined in the [API](#api) section.)

**Test it:** forward any airline confirmation from an address in `ALLOWED_SENDERS` to `flights@example.com`. Expect a reply within a few seconds. If there is none, check the Worker's logs, `curl -H "$AUTH" $API/api/emails`, and your spam folder.

### 6. Automatic forwarding from Gmail

1. In Gmail, go to **Settings → Forwarding and POP/IMAP** and add `flights@example.com`.
2. Gmail sends a verification email, which the Worker rejects (its sender isn't in `ALLOWED_SENDERS`) but still stores. `curl -H "$AUTH" $API/api/emails` shows it with status `rejected`; read the code with:
   ```bash
   npx wrangler d1 execute flight-memory --remote --command "SELECT text_body FROM emails WHERE status='rejected' ORDER BY id DESC LIMIT 1"
   ```
3. Add a Gmail filter that forwards airline bookings, receipts, check-ins, boarding passes and upgrade emails. Boarding passes are what catch op-ups.

"Forward as attachment" keeps the embedded data, so the parse is free and exact.

### 7. First sign-in

Open your domain. With no passkeys registered yet, the UI asks for a **setup token**: enter your `API_TOKEN` and a name for the passkey, then confirm with Touch ID, your phone, or a security key. After that, "Sign in with passkey" is all you need. See [Web UI and passkeys](#web-ui-and-passkeys).

## Optional features

### Claude fallback parser

Set the `ANTHROPIC_API_KEY` secret. Emails with no embedded flight data are then extracted by the model named in `CLAUDE_MODEL`. Without the key, such emails are stored and the reply says so.

### FlightAware aircraft lookup

Set the `FLIGHTAWARE_API_KEY` secret (a [FlightAware AeroAPI](https://www.flightaware.com/aeroapi/) key). A cron runs daily at 09:17 UTC and looks up the tail number and aircraft type of flights that departed within the last few days (AeroAPI only reaches back about 10 days). The personal tier has a monthly free allowance.

`FLIGHTAWARE_DRY_RUN` ships as `"true"`: results are only logged to the `aircraft_lookups` table and flights are untouched. Review them, then set it to anything else (e.g. `"false"`) to apply them. Only the exact string `"true"` means dry run.

### Post-landing seat prompts

Every 30 minutes the Worker emails you "what seat were you in?" for flights that landed in the last 90 minutes. Reply with a seat like `23A`, or `ok` to confirm the seat on file; the reply sets the seat.

- Needs the `SEAT_EMAIL` `send_email` binding, `PROMPT_FROM` and `SEAT_PROMPT_TO`. If any is missing, the job logs a warning and does nothing.
- `SEAT_PROMPT_TO` must be a **verified destination address** in Email Routing (add it under **Destination addresses**) and equal the binding's `destination_address`.
- `src/index.ts` picks the job by the exact cron string `"*/30 * * * *"`, so keep that string in `[triggers]`.
- Set `SEAT_PROMPTS = "false"` to turn it off.

## API

All routes live under `/api`. Every request needs either the header `Authorization: Bearer $API_TOKEN` or a web-UI session cookie; without one, every `/api` route returns 404. (Cookie-authenticated POST/PATCH/DELETE requests must also carry an `Origin` header equal to `ORIGIN`; bearer requests don't.)

```bash
API=https://example.com; AUTH="Authorization: Bearer $API_TOKEN"

curl -H "$AUTH" "$API/api/flights"                      # filters: upcoming=1 past=1 from=YYYY-MM-DD to=… confirmation=XQ7K2M upgraded=1
curl -H "$AUTH" "$API/api/flights/12"                   # one flight (+ a one-line summary)
curl -H "$AUTH" "$API/api/emails"                       # intake log, with warnings

curl -X PATCH -H "$AUTH" "$API/api/flights/12" -d '{
  "aircraft_registration":"JA791A", "aircraft_name":"Star Wars Jet", "seat_type":"window",
  "flown_class":"Business", "upgrade_type":"mileage_upgrade", "upgrade_points_cost":25000,
  "comments":"Great crew"}'
curl -X PATCH -H "$AUTH" "$API/api/flights/12" -d '{"unlock":["cash_cost"]}'

# Back-fill a past flight (only dep_airport, dep_local, arr_airport are required; flight_number may be blank)
curl -X POST -H "$AUTH" "$API/api/flights" -d '{
  "carrier_code":"B6", "flight_number":"1001", "dep_airport":"JFK", "dep_local":"2025-08-01T07:05",
  "arr_airport":"PIT", "arr_local":"2025-08-01T08:52", "aircraft_type":"Airbus A320", "seat":"12B",
  "purchased_class":"Economy", "fare_type":"cash", "cash_cost":189, "cash_currency":"USD"}'

curl -H "$AUTH" "$API/api/flights?page=1&per_page=25&sort=distance&dir=desc&q=jfk&year=2026"
#   with `page`, the reply is { flights, total, page, per_page } (per_page max 200); without it, a plain array.
#   sort: dep | flight | route | airline | aircraft | seat | class | distance | duration   dir: asc | desc
#   q: case-insensitive search over flight number, airports, airline, confirmation code, aircraft
curl -H "$AUTH" "$API/api/stats?year=2026"          # totals, top routes/airlines/aircraft, seat and cabin mix (omit year for all time)

curl -X DELETE -H "$AUTH" "$API/api/flights/12"
curl -X POST -H "$AUTH" "$API/api/emails/5/reparse"     # re-run parsing on a stored email
```

Times are local wall-clock time, `YYYY-MM-DDTHH:MM`; the time zone comes from the airport. Classes accept common airline names ("Polaris", "Main Cabin") and are stored as one of the four standard classes. Invalid values get a 400 response that says what was expected.

## Web UI and passkeys

The UI lives at your domain (`ORIGIN`). Its source is in `ui/`, bundled by `npm run build:ui` into the gitignored `public/` and served as Worker static assets. It shows a paginated, sortable flight table, a per-flight edit form and yearly stats.

Login is passkey-only (WebAuthn, discoverable credentials). First-time setup:

1. Deploy, then open your domain. With no passkeys yet, it asks for a **setup token**: enter your `API_TOKEN` and a name for the passkey, then confirm with Touch ID, your phone, or a security key.
2. After that, "Sign in with passkey" is all you need. Sessions last 30 days (`fm_session`, HttpOnly, SameSite=Strict, stored hashed in D1).
3. To add another device, sign in and choose "Add another passkey". If you lose every passkey, the `API_TOKEN` still works as a setup token.

Auth endpoints (JSON): `POST /auth/register/options` and `/auth/register/verify` (need a session or `setup_token` in the body), `POST /auth/login/options` and `/auth/login/verify`, `POST /auth/logout`, `GET /auth/me` returning `{ authenticated, has_passkeys }`.

## Development

```bash
npm run build:ui && node ui/dev-mock.mjs   # UI with fake data at http://localhost:8788 (no Cloudflare needed)
npm run test:e2e                           # local D1 + wrangler dev: unit tests, then replays test/samples and runs test/e2e-api.mjs
npm run parse -- path/to/email.eml         # preview a parse without Cloudflare
MY_NAME="Your Name" ANTHROPIC_API_KEY=sk-... npm run parse -- path/to/email.eml
npm run typecheck
npm run build:airports                     # refresh the airport data
```

`test:e2e` uses `wrangler.toml` if present, else `wrangler.example.toml`, and needs `setsid` or `perl` (it uses whichever is available). The reply emails the Worker would have sent are copied to `.wrangler/replies/` afterwards.

## Data

`src/data/airports.json` holds about 9,000 airports, built from [OurAirports](https://ourairports.com/data/) (public domain). Time zones are derived from each airport's coordinates. Refresh it with `npm run build:airports`, then redeploy.

## Known limits

- **USD is the reporting currency.** Stats sum `cash_cost_usd`. For a cost in another currency, fill `cash_cost_usd` (and `upgrade_cash_cost_usd`) by hand through the API or the edit form.
- **Seat type is mostly manual on widebodies**, because cabin layouts vary too much.
- **The cost split is an estimate.** Airlines price legs differently, so edit a flight's cost if you know the actual fare.
- **Name matching is forgiving but not psychic.** It tolerates middle names and JON vs JONATHAN, and the reply warns you when no passenger matched `MY_NAME`. Add other spellings to `MY_NAME`.
- **A rebooking to another date with a different flight number** leaves the old flight in place unless the change email lists the whole itinerary. Delete the old one with `DELETE /api/flights/:id`.
- **Sender checks can be spoofed.** The allowlist checks sender addresses, which can be faked. The worst case is junk rows; the API itself needs the token.

## License

MIT. See [LICENSE](LICENSE).
