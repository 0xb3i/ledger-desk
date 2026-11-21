-- Existing transactions remain ordinary expenses unless the owner marks them fixed.
ALTER TABLE transactions ADD COLUMN is_fixed INTEGER NOT NULL DEFAULT 0
  CHECK (is_fixed IN (0,1) AND (is_fixed = 0 OR kind = 'expense'));

DROP TRIGGER transactions_audit_insert;
DROP TRIGGER transactions_audit_update;

CREATE TRIGGER transactions_audit_insert AFTER INSERT ON transactions
BEGIN
  INSERT INTO transaction_audit (transaction_id, version, action, snapshot, created_at)
  VALUES (NEW.id, NEW.version, 'created', json_object(
    'occurredAt',NEW.occurred_at,'kind',NEW.kind,'amountCents',NEW.amount_cents,
    'currency',NEW.currency,'description',NEW.description,'counterparty',NEW.counterparty,
    'categoryId',NEW.category_id,'accountId',NEW.account_id,'source',NEW.source,
    'fingerprint',NEW.fingerprint,'sourceDetails',json(NEW.source_details),'reviewStatus',NEW.review_status,'note',NEW.note,
    'createdAt',NEW.created_at,'updatedAt',NEW.updated_at,'deletedAt',NEW.deleted_at,
    'isFixed',json(CASE WHEN NEW.is_fixed = 1 THEN 'true' ELSE 'false' END)
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
      'isFixed',json(CASE WHEN NEW.is_fixed = 1 THEN 'true' ELSE 'false' END)
    ), NEW.updated_at);
END;
