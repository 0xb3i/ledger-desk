-- Local QQ Mail IMAP sync message checkpoints (read-only INBOX sync).
CREATE TABLE local_mail_messages (
  source_id TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id TEXT,
  mail_date TEXT,
  subject TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('imported', 'skipped_existing', 'ignored', 'invalid')),
  transaction_id TEXT,
  error_message TEXT,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, uid_validity, uid)
);

CREATE INDEX local_mail_messages_status_idx ON local_mail_messages (source_id, status, processed_at DESC);
CREATE INDEX local_mail_messages_msgid_idx ON local_mail_messages (source_id, message_id) WHERE message_id IS NOT NULL;
