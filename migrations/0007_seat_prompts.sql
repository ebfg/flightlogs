-- One row per post-landing "what seat were you in?" email (src/seat-prompt.ts), so each flight is asked once
-- and the reply (matched by its In-Reply-To / References against message_id) can be tied back to the flight.
-- error is set when the send failed (the row is kept so it isn't retried every 30 minutes).
CREATE TABLE seat_prompts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  flight_id    INTEGER NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  message_id   TEXT UNIQUE,
  sent_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at  TEXT,
  answer       TEXT,
  error        TEXT
);
CREATE INDEX idx_seat_prompts_flight ON seat_prompts (flight_id);
