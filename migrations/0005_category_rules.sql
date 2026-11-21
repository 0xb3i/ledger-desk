-- Classification provenance is separate from input receipts and Feishu checkpoints.
ALTER TABLE transactions ADD COLUMN category_source TEXT NOT NULL DEFAULT 'unclassified'
  CHECK(category_source IN ('unclassified','manual','rule'));
ALTER TABLE transactions ADD COLUMN category_rule_id TEXT;
ALTER TABLE transactions ADD COLUMN category_rule_keyword TEXT;

DROP TRIGGER transactions_audit_insert;
DROP TRIGGER transactions_audit_update;
-- Old manual entries do not distinguish an omitted category from an explicit clear.
-- Preserve those choices, existing selections, and any previously edited categorization.
UPDATE transactions SET category_source='manual' WHERE category_id IS NOT NULL OR version > 1 OR source='manual';

CREATE TABLE category_rules (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL CHECK(length(keyword) BETWEEN 1 AND 100),
  match_type TEXT NOT NULL CHECK(match_type IN ('contains','exact')),
  kind TEXT NOT NULL CHECK(kind IN ('expense','income')),
  category_id TEXT NOT NULL REFERENCES categories(id),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1)
);
-- One database-backed generation rejects stale previews even across processes.
CREATE TABLE classification_state (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO classification_state VALUES(1,0);

CREATE TRIGGER transactions_audit_insert AFTER INSERT ON transactions
BEGIN
  INSERT INTO transaction_audit (transaction_id, version, action, snapshot, created_at)
  VALUES (NEW.id, NEW.version, 'created', json_object(
    'occurredAt',NEW.occurred_at,'kind',NEW.kind,'amountCents',NEW.amount_cents,
    'currency',NEW.currency,'description',NEW.description,'counterparty',NEW.counterparty,
    'categoryId',NEW.category_id,'accountId',NEW.account_id,'source',NEW.source,
    'fingerprint',NEW.fingerprint,'sourceDetails',json(NEW.source_details),'reviewStatus',NEW.review_status,'note',NEW.note,
    'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at,
    'isFixed',json(CASE WHEN NEW.is_fixed = 1 THEN 'true' ELSE 'false' END),
      'categorySource',NEW.category_source,'categoryRuleId',NEW.category_rule_id,'categoryRuleKeyword',NEW.category_rule_keyword
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
      'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at,
      'isFixed',json(CASE WHEN NEW.is_fixed = 1 THEN 'true' ELSE 'false' END),
      'categorySource',NEW.category_source,'categoryRuleId',NEW.category_rule_id,'categoryRuleKeyword',NEW.category_rule_keyword
    ), NEW.updated_at);
END;

CREATE TRIGGER classification_transactions_insert AFTER INSERT ON transactions
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_transactions_update AFTER UPDATE ON transactions
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_transactions_delete AFTER DELETE ON transactions
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_category_rules_insert AFTER INSERT ON category_rules
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_category_rules_update AFTER UPDATE ON category_rules
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_category_rules_delete AFTER DELETE ON category_rules
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_categories_insert AFTER INSERT ON categories
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_categories_update AFTER UPDATE ON categories
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER classification_categories_delete AFTER DELETE ON categories
BEGIN
  UPDATE classification_state SET revision=revision+1 WHERE id=1;
END;
