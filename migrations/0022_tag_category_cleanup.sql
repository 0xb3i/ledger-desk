DELETE FROM transaction_tags WHERE NOT EXISTS (
  SELECT 1 FROM categories WHERE categories.id = transaction_tags.category_id
);

CREATE TRIGGER category_tag_overrides_delete AFTER DELETE ON categories
BEGIN
  DELETE FROM transaction_tags WHERE category_id = OLD.id;
END;
