-- 订阅建议里被点「不是订阅」的识别结果，之后不再推荐。key 与建议的来源标识一致。
CREATE TABLE subscription_dismissals (
  key TEXT PRIMARY KEY NOT NULL CHECK(length(key) BETWEEN 1 AND 200),
  dismissed_at TEXT NOT NULL
);
