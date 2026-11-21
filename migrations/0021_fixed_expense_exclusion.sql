ALTER TABLE transactions ADD COLUMN fixed_auto_excluded INTEGER NOT NULL DEFAULT 0
  CHECK (fixed_auto_excluded IN (0, 1) AND (fixed_auto_excluded = 0 OR is_fixed = 0));
