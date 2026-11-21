-- Category presentation is independent of transaction identity and auditing.
ALTER TABLE categories ADD COLUMN icon TEXT NOT NULL DEFAULT 'other'
  CHECK(icon IN ('home','food','bag','train','ticket','health','learning','salary','wallet','other','cup','plane','car','bike','gift','pet','dumbbell','game','music','camera','tree','tools','smartphone','laptop','shirt','baby','beauty','pizza','savings','charity'));
ALTER TABLE categories ADD COLUMN color TEXT NOT NULL DEFAULT 'slate'
  CHECK(color IN ('sage','amber','sand','olive','green','clay','slate'));
ALTER TABLE categories ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE categories ADD COLUMN name_key TEXT;
UPDATE categories SET icon=CASE id
  WHEN 'food' THEN 'food' WHEN 'shopping' THEN 'bag' WHEN 'transport' THEN 'train'
  WHEN 'housing' THEN 'home' WHEN 'health' THEN 'health' WHEN 'leisure' THEN 'ticket'
  WHEN 'learning' THEN 'learning' WHEN 'salary' THEN 'salary' WHEN 'other-income' THEN 'wallet' ELSE 'other' END,
  color=CASE id WHEN 'food' THEN 'amber' WHEN 'shopping' THEN 'sand' WHEN 'transport' THEN 'sage'
  WHEN 'housing' THEN 'olive' WHEN 'health' THEN 'green' WHEN 'leisure' THEN 'clay'
  WHEN 'learning' THEN 'sand' WHEN 'salary' THEN 'green' WHEN 'other-income' THEN 'green' ELSE 'slate' END,
  name_key=lower(trim(name));
CREATE UNIQUE INDEX categories_name_key ON categories(name_key) WHERE name_key IS NOT NULL;

CREATE TRIGGER categories_kind_guard BEFORE UPDATE OF kind ON categories
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM transactions WHERE category_id=OLD.id
    AND NEW.kind!='both' AND NEW.kind!=CASE WHEN kind='refund' THEN 'expense' ELSE kind END)
    OR EXISTS(SELECT 1 FROM category_rules WHERE category_id=OLD.id AND NEW.kind!='both' AND kind!=NEW.kind)
    THEN RAISE(ABORT,'category_kind_reference_conflict') END;
END;

CREATE TRIGGER transactions_category_insert_guard BEFORE INSERT ON transactions
BEGIN
  SELECT CASE WHEN NEW.category_id IS NOT NULL AND EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id
    AND kind!='both' AND kind!=CASE WHEN NEW.kind='refund' THEN 'expense' ELSE NEW.kind END)
    THEN RAISE(ABORT,'transaction_category_kind_conflict') END;
END;

CREATE TRIGGER transactions_category_update_guard BEFORE UPDATE OF kind,category_id ON transactions
BEGIN
  SELECT CASE WHEN NEW.category_id IS NOT NULL AND EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id
    AND kind!='both' AND kind!=CASE WHEN NEW.kind='refund' THEN 'expense' ELSE NEW.kind END)
    THEN RAISE(ABORT,'transaction_category_kind_conflict') END;
END;

CREATE TRIGGER category_rules_category_insert_guard BEFORE INSERT ON category_rules
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id AND kind!='both' AND kind!=NEW.kind)
    THEN RAISE(ABORT,'rule_category_kind_conflict') END;
END;

CREATE TRIGGER category_rules_category_update_guard BEFORE UPDATE OF kind,category_id ON category_rules
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM categories WHERE id=NEW.category_id AND kind!='both' AND kind!=NEW.kind)
    THEN RAISE(ABORT,'rule_category_kind_conflict') END;
END;
