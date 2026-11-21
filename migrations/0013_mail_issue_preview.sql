-- Cache cleaned email body excerpt only while a CMB mail issue is awaiting review.
ALTER TABLE local_mail_messages ADD COLUMN body_preview TEXT;
