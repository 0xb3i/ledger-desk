-- Source baselines are independent of editable local transactions and ingest receipts.
ALTER TABLE local_feishu_records ADD COLUMN source_snapshot TEXT
  CHECK(source_snapshot IS NULL OR json_valid(source_snapshot));
ALTER TABLE local_feishu_records ADD COLUMN pending_snapshot TEXT
  CHECK(pending_snapshot IS NULL OR json_valid(pending_snapshot));
