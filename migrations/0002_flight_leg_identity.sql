-- A flight is identified by carrier, number, local date AND departure airport, so through-flights
-- (same number, same day, several legs: DAL-HOU-MSY) keep one row per leg.
-- SQLite can't alter a UNIQUE constraint, so rebuild the table. Dropping flights would cascade into
-- email_flights, so stash those links first and put them back after.
CREATE TABLE email_flights_bak AS SELECT email_id, flight_id FROM email_flights;

CREATE TABLE flights_new (
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
  UNIQUE (carrier_code, flight_number, dep_date, dep_airport)
);

INSERT INTO flights_new SELECT * FROM flights;
DROP TABLE flights;
ALTER TABLE flights_new RENAME TO flights;
CREATE INDEX idx_flights_dep_utc ON flights (dep_utc);
CREATE INDEX idx_flights_confirmation ON flights (confirmation_code);

INSERT OR IGNORE INTO email_flights (email_id, flight_id) SELECT email_id, flight_id FROM email_flights_bak;
DROP TABLE email_flights_bak;
