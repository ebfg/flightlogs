-- One row per FlightAware AeroAPI lookup (src/flightaware.ts), so results can be reviewed.
-- applied = 1 when the registration/type were written to the flight (0 in dry-run, no match, error, or hand-set fields).
CREATE TABLE aircraft_lookups (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id      INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  looked_up_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  status         TEXT NOT NULL CHECK (status IN ('matched', 'no_match', 'error')),
  registration   TEXT,
  aircraft_type  TEXT,                      -- as AeroAPI returns it, usually an ICAO code like B77W
  fa_flight_id   TEXT,
  applied        INTEGER NOT NULL DEFAULT 0,
  error          TEXT
);
CREATE INDEX idx_aircraft_lookups_flight ON aircraft_lookups (flight_id);
