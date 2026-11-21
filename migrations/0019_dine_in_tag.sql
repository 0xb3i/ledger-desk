-- 餐饮 > 堂食：微信、支付宝等直接付给商户（到店出示付款码或扫收款码）的餐饮账单，团购券也算堂食。
-- 堂食排在餐饮各标签最后：水果、商超、便利店、饮品、外卖先按平台和品类认领，剩下的直接付款才归为堂食；
-- 「美团App团购」这类更具体的关键词会压过外卖的「美团App」（匹配器里更具体的关键词优先）。
INSERT INTO tags(id,name,category_id,icon,position) SELECT 'food:dine-in','堂食','food','utensils',(SELECT COALESCE(MAX(position),0)+1 FROM tags WHERE category_id='food') WHERE EXISTS (SELECT 1 FROM categories WHERE id='food') ON CONFLICT DO NOTHING;
-- 团购并入堂食：关键词与手动指定一起迁过去，再删除团购标签
UPDATE tag_rules SET tag_id='food:dine-in' WHERE tag_id='food:groupbuy' AND EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in');
UPDATE transaction_tags SET tag_id='food:dine-in' WHERE tag_id='food:groupbuy' AND EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in');
DELETE FROM tags WHERE id='food:groupbuy' AND EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in');
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:dine-in:1','food:dine-in','微信支付' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:dine-in:2','food:dine-in','支付宝' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:dine-in:3','food:dine-in','扫二维码' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:dine-in:4','food:dine-in','云闪付' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:dine-in:5','food:dine-in','抖音' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:dine-in') ON CONFLICT DO NOTHING;
-- 平台兜底：经微信或银联付给美团的订单归外卖；乐乐茶的公司名是「乐茶实业」
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:takeout:meituan','food:takeout','美团' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:drinks:lecha','food:drinks','乐茶' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:drinks') ON CONFLICT DO NOTHING;
