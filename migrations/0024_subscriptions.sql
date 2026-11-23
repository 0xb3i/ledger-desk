-- 订阅与固定开销：房租、会员、软件订阅等周期性花费。独立于账本，不计入收支。
-- next_due_date 是锚定日；auto_renew=1 时按周期自动推到下一期，=0 时到期后保持过期直到手动续费。
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('housing','software','membership','utility','insurance','other')),
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents)='integer' AND amount_cents BETWEEN 1 AND 999999999999),
  cycle TEXT NOT NULL CHECK(cycle IN ('weekly','monthly','quarterly','semiannual','yearly')),
  next_due_date TEXT NOT NULL CHECK(next_due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  auto_renew INTEGER NOT NULL DEFAULT 1 CHECK(auto_renew IN (0,1)),
  remind_days INTEGER NOT NULL DEFAULT 7 CHECK(typeof(remind_days)='integer' AND remind_days BETWEEN 0 AND 60),
  note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=500),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 9007199254740991),
  create_payload_hash TEXT CHECK(create_payload_hash IS NULL OR length(create_payload_hash)=64)
);
CREATE INDEX subscriptions_active ON subscriptions(next_due_date,id) WHERE ended_at IS NULL;
CREATE INDEX subscriptions_ended ON subscriptions(ended_at DESC,id DESC) WHERE ended_at IS NOT NULL;
