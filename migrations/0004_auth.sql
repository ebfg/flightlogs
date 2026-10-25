-- Passkey (WebAuthn) login for the web UI. Single user; sessions are stored hashed.
CREATE TABLE credentials (
  id           TEXT PRIMARY KEY,            -- base64url credential id
  public_key   BLOB NOT NULL,               -- COSE public key
  counter      INTEGER NOT NULL DEFAULT 0,
  transports   TEXT,                        -- JSON array
  name         TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,             -- hex SHA-256 of the cookie value
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE auth_challenges (
  challenge   TEXT PRIMARY KEY,             -- base64url, single use
  kind        TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at  TEXT NOT NULL
);
CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);
