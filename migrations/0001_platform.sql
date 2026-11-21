PRAGMA foreign_keys = ON;
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 60),
  bank TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))
);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('expense','income','both'))
);
INSERT INTO accounts (id,name,bank) VALUES ('cmb-default','招商银行','招商银行');
INSERT INTO categories (id,name,kind) VALUES
 ('food','餐饮','expense'),('shopping','购物','expense'),('transport','交通','expense'),
 ('housing','居住','expense'),('health','健康','expense'),('leisure','休闲','expense'),
 ('learning','学习','expense'),('salary','工资','income'),('other-income','其他收入','income'),('other','其他','both');
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, owner_tag TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE devices (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, account_id TEXT NOT NULL REFERENCES accounts(id),
  token_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
CREATE TABLE restore_guards (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid = 1));
