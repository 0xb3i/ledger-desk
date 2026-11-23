-- 截止日期：这天之后不再扣费，推算到的下一期晚于它时自动归入已结束。
ALTER TABLE subscriptions ADD COLUMN end_date TEXT CHECK(end_date IS NULL OR end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
-- 从固定支出账单导入时的来源标识，避免重复导入；手动添加的为 NULL。
ALTER TABLE subscriptions ADD COLUMN source_key TEXT CHECK(source_key IS NULL OR length(source_key) BETWEEN 1 AND 200);
CREATE UNIQUE INDEX subscriptions_source_key ON subscriptions(source_key) WHERE source_key IS NOT NULL;
