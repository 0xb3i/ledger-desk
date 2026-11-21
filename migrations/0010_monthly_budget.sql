-- A single monthly spending budget that applies to every month. amount_cents NULL means no budget.
-- version protects edits against concurrent writers.
CREATE TABLE monthly_budget (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 999999999999)),
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version >= 1),
  updated_at TEXT
);
INSERT INTO monthly_budget(id, amount_cents, version, updated_at) VALUES(1, NULL, 1, NULL);
