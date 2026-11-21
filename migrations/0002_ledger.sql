CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('expense','income','refund','transfer')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND amount_cents <= 999999999999),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  description TEXT NOT NULL,
  counterparty TEXT NOT NULL DEFAULT '',
  category_id TEXT REFERENCES categories(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  source TEXT NOT NULL CHECK (source IN ('manual','shortcut','import')),
  fingerprint TEXT,
  source_details TEXT CHECK (source_details IS NULL OR json_valid(source_details)),
  review_status TEXT NOT NULL DEFAULT 'confirmed' CHECK (review_status IN ('confirmed','pending')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  idempotency_scope TEXT,
  idempotency_key TEXT,
  payload_hash TEXT,
  UNIQUE (idempotency_scope, idempotency_key)
);

CREATE INDEX transactions_month_idx ON transactions (deleted_at, review_status, occurred_at DESC, id DESC);
CREATE INDEX transactions_fingerprint_idx ON transactions (account_id, fingerprint) WHERE fingerprint IS NOT NULL;

CREATE TABLE transaction_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX transaction_audit_transaction_idx ON transaction_audit (transaction_id, version);

CREATE TRIGGER transactions_audit_insert AFTER INSERT ON transactions
BEGIN
  INSERT INTO transaction_audit (transaction_id, version, action, snapshot, created_at)
  VALUES (NEW.id, NEW.version, 'created', json_object(
    'occurredAt',NEW.occurred_at,'kind',NEW.kind,'amountCents',NEW.amount_cents,
    'currency',NEW.currency,'description',NEW.description,'counterparty',NEW.counterparty,
    'categoryId',NEW.category_id,'accountId',NEW.account_id,'source',NEW.source,
    'fingerprint',NEW.fingerprint,'sourceDetails',json(NEW.source_details),'reviewStatus',NEW.review_status,'note',NEW.note,
    'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at
  ), NEW.updated_at);
END;

CREATE TRIGGER transactions_audit_update AFTER UPDATE ON transactions
BEGIN
  INSERT INTO transaction_audit (transaction_id, version, action, snapshot, created_at)
  VALUES (NEW.id, NEW.version,
    CASE
      WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'archived'
      WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN 'restored'
      WHEN OLD.review_status = 'pending' AND NEW.review_status = 'confirmed' THEN 'confirmed'
      ELSE 'updated'
    END,
    json_object(
      'occurredAt',NEW.occurred_at,'kind',NEW.kind,'amountCents',NEW.amount_cents,
      'currency',NEW.currency,'description',NEW.description,'counterparty',NEW.counterparty,
      'categoryId',NEW.category_id,'accountId',NEW.account_id,'source',NEW.source,
      'fingerprint',NEW.fingerprint,'sourceDetails',json(NEW.source_details),'reviewStatus',NEW.review_status,'note',NEW.note,
      'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at
    ), NEW.updated_at);
END;
