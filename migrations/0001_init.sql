-- Flight memory schema (Cloudflare D1 / SQLite). One row per flight you take.
-- Apply with: npm run db:migrate   (wrangler d1 migrations apply flight-memory --remote)
-- Later schema changes go in new numbered files in this folder.

-- Tables from earlier prototype versions, if they were ever applied.
DROP VIEW IF EXISTS flight_log;
DROP TABLE IF EXISTS travellers;
DROP TABLE IF EXISTS email_reservations;
DROP TABLE IF EXISTS passengers;
DROP TABLE IF EXISTS segments;
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS email_flights;
DROP TABLE IF EXISTS flights;
DROP TABLE IF EXISTS emails;

-- Every email that reaches the Worker, parsed or not.
CREATE TABLE emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id    TEXT UNIQUE,
  envelope_from TEXT,
  header_from   TEXT,          -- From of the original confirmation
  subject       TEXT,
  sent_at       TEXT,
  received_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status        TEXT NOT NULL, -- received | parsed | no_flights | needs_review | failed | rejected
  email_type    TEXT,          -- booking | change | cancellation | checkin | upgrade | receipt | other
  parse_method  TEXT,          -- structured | llm | none
  error         TEXT,
  text_body     TEXT,          -- kept so emails can be re-parsed later
  html_body     TEXT
);

CREATE TABLE flights (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Flight
  carrier_code          TEXT NOT NULL DEFAULT '',  -- IATA marketing carrier, e.g. NH ('' if unknown)
  flight_number         TEXT NOT NULL,             -- e.g. 9
  airline               TEXT,
  operating_carrier     TEXT,                      -- if different ("operated by …")
  confirmation_code     TEXT,
  booked_via            TEXT,                      -- agency / OTA, if any
  status                TEXT NOT NULL DEFAULT 'confirmed'
                        CHECK (status IN ('confirmed', 'pending', 'changed', 'cancelled', 'replaced')),

  -- When and where
  dep_airport           TEXT NOT NULL,             -- IATA
  dep_local             TEXT NOT NULL,             -- YYYY-MM-DDTHH:MM, wall clock at the airport
  dep_tz                TEXT,                      -- IANA zone, e.g. America/New_York
  dep_offset            TEXT,                      -- UTC offset on that date, e.g. -04:00
  dep_utc               TEXT,                      -- YYYY-MM-DDTHH:MM:SSZ
  dep_date              TEXT NOT NULL,             -- YYYY-MM-DD local
  arr_airport           TEXT NOT NULL,
  arr_local             TEXT,
  arr_tz                TEXT,
  arr_offset            TEXT,
  arr_utc               TEXT,
  duration_min          INTEGER,                   -- from the UTC times
  distance_mi           INTEGER,                   -- great-circle, statute miles

  -- Aircraft
  aircraft_raw          TEXT,                      -- as printed in the email, e.g. "77W"
  aircraft_family       TEXT,                      -- e.g. Boeing 777
  aircraft_type         TEXT,                      -- e.g. Boeing 777-300ER
  aircraft_registration TEXT,                      -- tail number, e.g. JA791A
  aircraft_name         TEXT,

  -- Seat and class
  seat                  TEXT,                      -- e.g. 23A
  seat_type             TEXT CHECK (seat_type IN ('window', 'middle', 'aisle')),
  purchased_class       TEXT,                      -- Economy | Premium Economy | Business | First
  flown_class           TEXT,                      -- same values; equals purchased_class unless it changed
  upgrade_type          TEXT CHECK (upgrade_type IN (
                          'complimentary_upgrade', -- elite / status upgrade
                          'op_up',                 -- operational upgrade (oversold cabin etc.)
                          'mileage_upgrade',       -- paid with miles/points (+ any co-pay)
                          'cash_upgrade',          -- bought for cash (offer, at check-in, at the gate)
                          'bid_upgrade',           -- won an upgrade auction
                          'certificate_upgrade',   -- upgrade instrument: PlusPoints, GPU, voucher…
                          'op_down',               -- involuntary downgrade
                          'voluntary_downgrade'
                        )),
  upgrade_points_cost   INTEGER,
  upgrade_cash_cost     REAL,
  upgrade_cash_currency TEXT,

  -- Cost of this flight (for you). A booking's total is shared across its flights by distance.
  fare_type             TEXT CHECK (fare_type IN ('cash', 'award')),
  points_cost           INTEGER,
  points_program        TEXT,                      -- e.g. ANA Mileage Club
  cash_cost             REAL,                      -- fare, or taxes & fees on an award
  cash_currency         TEXT,                      -- ISO 4217

  comments              TEXT,

  manual_fields         TEXT NOT NULL DEFAULT '[]', -- fields set by hand; emails never overwrite them
  last_email_id         INTEGER REFERENCES emails(id) ON DELETE SET NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (carrier_code, flight_number, dep_date)
);
CREATE INDEX idx_flights_dep_utc ON flights (dep_utc);
CREATE INDEX idx_flights_confirmation ON flights (confirmation_code);

-- Which emails touched which flights.
CREATE TABLE email_flights (
  email_id  INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  flight_id INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  PRIMARY KEY (email_id, flight_id)
);
