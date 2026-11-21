-- Transfer direction is ledger metadata. Source details and request receipts stay unchanged.
ALTER TABLE transactions ADD COLUMN transfer_direction TEXT CHECK(transfer_direction IN ('inflow','outflow'));
DROP TRIGGER transactions_audit_insert;
DROP TRIGGER transactions_audit_update;
UPDATE transactions SET transfer_direction=json_extract(source_details,'$.direction')
  WHERE kind='transfer' AND json_extract(source_details,'$.direction') IN ('inflow','outflow');
DROP TRIGGER categories_kind_guard;
DROP TRIGGER transactions_category_insert_guard;
DROP TRIGGER transactions_category_update_guard;

CREATE TRIGGER categories_kind_guard BEFORE UPDATE OF kind ON categories
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM transactions WHERE category_id=OLD.id
    AND NEW.kind!='both' AND NEW.kind!=CASE WHEN kind='refund' THEN 'expense' WHEN kind='transfer' AND transfer_direction='inflow' THEN 'income' WHEN kind='transfer' AND transfer_direction='outflow' THEN 'expense' ELSE kind END)
    OR EXISTS(SELECT 1 FROM category_rules WHERE category_id=OLD.id AND NEW.kind!='both' AND kind!=NEW.kind)
    THEN RAISE(ABORT,'category_kind_reference_conflict') END;
END;

CREATE TRIGGER transactions_category_insert_guard BEFORE INSERT ON transactions
BEGIN
  SELECT CASE WHEN NEW.category_id IS NOT NULL AND EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id
    AND kind!='both' AND kind!=CASE WHEN NEW.kind='refund' THEN 'expense' WHEN NEW.kind='transfer' AND NEW.transfer_direction='inflow' THEN 'income' WHEN NEW.kind='transfer' AND NEW.transfer_direction='outflow' THEN 'expense' ELSE NEW.kind END)
    THEN RAISE(ABORT,'transaction_category_kind_conflict') END;
END;

CREATE TRIGGER transactions_category_update_guard BEFORE UPDATE OF kind,category_id,transfer_direction ON transactions
BEGIN
  SELECT CASE WHEN NEW.category_id IS NOT NULL AND EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id
    AND kind!='both' AND kind!=CASE WHEN NEW.kind='refund' THEN 'expense' WHEN NEW.kind='transfer' AND NEW.transfer_direction='inflow' THEN 'income' WHEN NEW.kind='transfer' AND NEW.transfer_direction='outflow' THEN 'expense' ELSE NEW.kind END)
    THEN RAISE(ABORT,'transaction_category_kind_conflict') END;
END;

CREATE TRIGGER transactions_transfer_insert_guard BEFORE INSERT ON transactions
BEGIN
  SELECT CASE WHEN NEW.kind!='transfer' AND NEW.transfer_direction IS NOT NULL
    THEN RAISE(ABORT,'transaction_transfer_direction_conflict') END;
END;

CREATE TRIGGER transactions_transfer_update_guard BEFORE UPDATE OF kind,transfer_direction ON transactions
BEGIN
  SELECT CASE WHEN NEW.kind!='transfer' AND NEW.transfer_direction IS NOT NULL
    THEN RAISE(ABORT,'transaction_transfer_direction_conflict') END;
END;

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
      'transferDirection',NEW.transfer_direction,'categorySource',NEW.category_source,'categoryRuleId',NEW.category_rule_id,'categoryRuleKeyword',NEW.category_rule_keyword
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
      'transferDirection',NEW.transfer_direction,'categorySource',NEW.category_source,'categoryRuleId',NEW.category_rule_id,'categoryRuleKeyword',NEW.category_rule_keyword
    ), NEW.updated_at);
END;

