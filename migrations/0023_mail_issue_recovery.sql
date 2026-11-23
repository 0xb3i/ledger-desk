-- Only complete bodies can be used by the parser. Older previews may be truncated.
ALTER TABLE local_mail_messages ADD COLUMN body_complete INTEGER CHECK (body_complete IN (0,1));
ALTER TABLE local_mail_messages ADD COLUMN dismissed_by_user INTEGER NOT NULL DEFAULT 0 CHECK (dismissed_by_user IN (0,1));
ALTER TABLE local_mail_messages ADD COLUMN unmatched_template TEXT;
