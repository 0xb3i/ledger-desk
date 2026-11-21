-- Local Feishu import checkpoints. The historical cloud deployment is not migrated.
CREATE TABLE local_integration_state (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE local_feishu_records (
  source_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  PRIMARY KEY (source_id, record_id)
);
