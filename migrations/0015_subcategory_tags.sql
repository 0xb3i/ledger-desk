-- Second-level tags under a category (e.g. 餐饮 > 外卖). A transaction's tag is derived at read time
-- from these keyword rules and its current category, so rule edits apply to history immediately.
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 30),
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(category_id, name)
);
CREATE TABLE tag_rules (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL CHECK(length(keyword) BETWEEN 1 AND 100),
  match_type TEXT NOT NULL DEFAULT 'contains' CHECK(match_type IN ('contains','exact')),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX tag_rules_tag ON tag_rules(tag_id);

-- Default: 餐饮 > 外卖 via the delivery platforms. 美团 also carries rides and group-buy, so only its
-- delivery-order prefixes are listed, and its group-buy entry goes to a separate, longer-keyword tag.
INSERT INTO tags(id,name,category_id) SELECT 'food:takeout','外卖','food' WHERE EXISTS (SELECT 1 FROM categories WHERE id='food');
INSERT INTO tags(id,name,category_id) SELECT 'food:groupbuy','团购','food' WHERE EXISTS (SELECT 1 FROM categories WHERE id='food');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:eleme','food:takeout','饿了么' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:rajax','food:takeout','拉扎斯' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:meituan-app','food:takeout','美团App' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:meituan-merchant','food:takeout','美团平台商户' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:meituan-unionpay','food:takeout','（特约）美团' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'takeout:pizza-delivery','food:takeout','宅急送' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'groupbuy:meituan','food:groupbuy','美团App团购' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:groupbuy');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'groupbuy:generic','food:groupbuy','团购' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:groupbuy');
