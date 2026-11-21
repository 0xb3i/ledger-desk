-- 外卖平台补充：京东（秒送等，账单形如「京东商城-袁记云饺」）与淘宝闪购（饿了么新入口）。
-- 京东到家买菜、超市类订单会先被排在前面的「买菜商超」认领。
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:takeout:jd','food:takeout','京东' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout') ON CONFLICT DO NOTHING;
INSERT INTO tag_rules(id,tag_id,keyword) SELECT 'food:takeout:taobao-flash','food:takeout','淘宝闪购' WHERE EXISTS (SELECT 1 FROM tags WHERE id='food:takeout') ON CONFLICT DO NOTHING;
