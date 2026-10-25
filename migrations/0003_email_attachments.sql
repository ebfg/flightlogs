-- PDF attachments (e-tickets, receipts, itineraries), kept so an email can be re-parsed with them.
CREATE TABLE email_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email_id     INTEGER NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT NOT NULL,
  data         BLOB NOT NULL
);
CREATE INDEX idx_email_attachments_email ON email_attachments (email_id);
