-- 单笔账单手动指定二级标签。tag_id 为 NULL 表示手动归入「其他」；category_id 记录指定时的分类，
-- 账单之后换了分类，这条手动指定即不再生效，回到按规则推导。删除标签时一并清除对应的手动指定。
CREATE TABLE transaction_tags (
  transaction_id TEXT PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  tag_id TEXT REFERENCES tags(id) ON DELETE CASCADE
);
