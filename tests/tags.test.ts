import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { Bootstrap, CurrentBackup, Summary, Tag, TagList, TagRule, Transaction, TransactionPage } from '../src/shared/contracts';
import { matchTag } from '../src/shared/tags';

let db: LocalDatabase, directory: string, cookie: string;
const origin = 'https://tags.test';
const ownerKey = 'pd_owner_' + 'tags-isolated-test'.repeat(4);
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return app.request(origin + '/api' + path, { method,
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, { DB: db, OWNER_ACCESS_KEY: ownerKey } as unknown as Env);
}
async function read<T>(response: Response, status = 200): Promise<T> {
  const body = await response.json() as { data: T };
  expect(response.status, JSON.stringify(body)).toBe(status);
  return body.data;
}
let accountId = '';
async function spend(description: string, amount: string, categoryId = 'food') {
  return read<Transaction>(await request('/transactions', 'POST', {
    occurredAt: '2026-11-10T12:00:00+08:00', kind: 'expense', amount, description, counterparty: description, categoryId, accountId,
  }, { 'Idempotency-Key': `tag-test-${crypto.randomUUID()}` }), 201);
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qingji-tags-test-'));
  db = new LocalDatabase(join(directory, 'ledger.sqlite'));
  await applyMigrations(db, resolve('migrations'));
  cookie = '';
  const login = await request('/session', 'POST', { accessKey: ownerKey });
  cookie = login.headers.get('Set-Cookie')!.split(';')[0];
  const bootstrap = await read<Bootstrap>(await request('/bootstrap'));
  accountId = bootstrap.accounts[0]?.id ?? (await read<{ id: string }>(await request('/accounts', 'POST', { name: '测试账户', bank: '' }), 201)).id;
});
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

describe('二级标签匹配器', () => {
  const tags: Tag[] = [
    { id: 't-takeout', name: '外卖', categoryId: 'food', icon: 'other', position: 2, version: 1 },
    { id: 't-dine', name: '堂食', categoryId: 'food', icon: 'other', position: 3, version: 1 },
    { id: 't-fruit', name: '水果', categoryId: 'food', icon: 'other', position: 1, version: 1 },
  ];
  const rule = (id: string, tagId: string, keyword: string, matchType: TagRule['matchType'] = 'contains'): TagRule => ({ id, tagId, keyword, matchType, version: 1 });
  const rules = [rule('a', 't-takeout', '美团App'), rule('b', 't-dine', '美团App团购'), rule('c', 't-fruit', '百果园'), rule('d', 't-takeout', '饿了么'), rule('e', 't-dine', '微信支付')];
  const tx = (description: string, categoryId: string | null = 'food') => ({ categoryId, description, counterparty: '' });
  it('更具体的关键词优先，其余按标签顺序从上到下；只在当前分类下匹配', () => {
    expect(matchTag(tx('美团-美团App喜茶'), tags, rules)?.name).toBe('外卖');
    // 「美团App团购」包含「美团App」，更具体，即使堂食排在外卖之后也归堂食
    expect(matchTag(tx('美团-美团App团购'), tags, rules)?.name).toBe('堂食');
    // 「微信支付」与「饿了么」互不包含，按顺序外卖在前
    expect(matchTag(tx('财付通-微信支付-饿了么'), tags, rules)?.name).toBe('外卖');
    expect(matchTag(tx('财付通-微信支付-寿司郎'), tags, rules)?.name).toBe('堂食');
    expect(matchTag(tx('美团-美团App百果园（政通路店）'), tags, rules)?.name).toBe('水果');
    expect(matchTag(tx('美团-美团ＡＰＰ汉堡王'), tags, rules)?.name).toBe('外卖');
    expect(matchTag(tx('财付通-饿了么', 'shopping'), tags, rules)).toBeNull();
    expect(matchTag(tx('财付通-饿了么', null), tags, rules)).toBeNull();
    expect(matchTag(tx('寿司郎'), tags, rules)).toBeNull();
  });
  it('完全一致的关键词只匹配整段名称', () => {
    const exact = [rule('e', 't-fruit', '美团-美团App喜茶', 'exact')];
    expect(matchTag(tx('美团-美团App喜茶'), tags, exact)?.name).toBe('水果');
    expect(matchTag(tx('美团-美团App喜茶（大学路）'), tags, exact)).toBeNull();
  });
});

describe('二级标签 API', () => {
  it('新库自带各分类的二级标签，餐饮里具体商户类型排在外卖之前', async () => {
    const bootstrap = await read<Bootstrap>(await request('/bootstrap'));
    const food = bootstrap.tags.filter(t => t.categoryId === 'food').sort((a, b) => a.position - b.position).map(t => t.name);
    expect(food).toEqual(['水果', '买菜商超', '便利店', '饮品甜点', '外卖', '堂食']);
    // 微信、支付宝直接付给商户的餐饮账单归堂食；平台订单与具体品类先被前面的标签认领
    const food2 = (description: string) => matchTag({ categoryId: 'food', description, counterparty: '' }, bootstrap.tags, bootstrap.tagRules)?.name;
    expect(food2('财付通-微信支付-寿司郎上海黄浦来福士店')).toBe('堂食');
    expect(food2('支付宝-新派（上海）餐饮管理有限公司')).toBe('堂食');
    expect(food2('支付宝-上海拉扎斯信息科技有限公司')).toBe('外卖');
    expect(food2('财付通-微信支付-美团')).toBe('外卖');
    expect(food2('财付通-微信支付-LAWSON')).toBe('便利店');
    expect(food2('财付通-微信支付-上海乐茶实业有限公司')).toBe('饮品甜点');
    expect(food2('抖音支付-上海韩馔餐饮管理有限公司')).toBe('堂食');
    expect(food2('美团-美团App团购')).toBe('堂食');
    expect(food2('美团-美团App成都你六姐牛肉冒菜')).toBe('外卖');
    expect(food2('网银在线-京东商城-袁记云饺')).toBe('外卖');
    expect(bootstrap.tags.find(t => t.id === 'food:fruit')?.icon).toBe('apple');
    expect(bootstrap.tags.find(t => t.id === 'transport:transit')?.icon).toBe('tram');
    expect(bootstrap.tags.every(t => t.icon !== 'other')).toBe(true);
    for (const category of ['transport', 'health', 'shopping', 'leisure', 'housing', 'learning']) {
      expect(bootstrap.tags.some(t => t.categoryId === category), category).toBe(true);
    }
    expect(bootstrap.tagRules.some(r => r.keyword === '饿了么')).toBe(true);
    expect(matchTag({ categoryId: 'food', description: '美团-美团App百果园（上海政通路店)', counterparty: '' }, bootstrap.tags, bootstrap.tagRules)?.name).toBe('水果');
    expect(matchTag({ categoryId: 'transport', description: '支付宝-上海公共交通卡股份有限公司', counterparty: '' }, bootstrap.tags, bootstrap.tagRules)?.name).toBe('公交地铁');
    expect(matchTag({ categoryId: 'shopping', description: '拼多多支付-心愿先生彩妆官方旗舰店', counterparty: '' }, bootstrap.tags, bootstrap.tagRules)?.name).toBe('美妆个护');
  });

  it('新建标签排到分类末尾，可上移下移调整优先级', async () => {
    const tag = await read<Tag>(await request('/tags', 'POST', { name: '早餐', categoryId: 'food' }), 201);
    const before = (await read<TagList>(await request('/tags'))).tags.filter(t => t.categoryId === 'food').sort((a, b) => a.position - b.position);
    expect(before.at(-1)!.id).toBe(tag.id);
    const moved = await read<TagList>(await request(`/tags/${tag.id}/move`, 'POST', { direction: 'up' }));
    const order = moved.tags.filter(t => t.categoryId === 'food').sort((a, b) => a.position - b.position).map(t => t.name);
    expect(order.slice(-2)).toEqual(['早餐', '堂食']);
    const top = await read<TagList>(await request(`/tags/${moved.tags.find(t => t.name === '买菜商超')!.id}/move`, 'POST', { direction: 'up' }));
    expect(top.tags.filter(t => t.categoryId === 'food').sort((a, b) => a.position - b.position)[0].name).toBe('买菜商超');
  });

  it('可增删改标签与关键词；同分类重名冲突；删除标签连带删除关键词；分类删除时级联', async () => {
    const tag = await read<Tag>(await request('/tags', 'POST', { name: ' 奶茶 ', categoryId: 'food' }), 201);
    expect(tag).toMatchObject({ name: '奶茶', icon: 'other' });
    expect((await request('/tags', 'POST', { name: '奶茶', categoryId: 'food' })).status).toBe(409);
    expect((await request('/tags', 'POST', { name: '奶茶', categoryId: 'missing' })).status).toBe(422);
    const rule = await read<TagRule>(await request('/tag-rules', 'POST', { tagId: tag.id, keyword: '喜茶' }), 201);
    expect(rule.matchType).toBe('contains');
    const iconed = await read<Tag>(await request(`/tags/${tag.id}`, 'PATCH', { icon: 'soda', version: tag.version }));
    expect(iconed).toMatchObject({ name: '奶茶', icon: 'soda' });
    expect((await request(`/tags/${tag.id}`, 'PATCH', { icon: 'not-an-icon', version: iconed.version })).status).toBe(422);
    const renamed = await read<Tag>(await request(`/tags/${tag.id}`, 'PATCH', { name: '茶饮', version: iconed.version }));
    expect(renamed).toMatchObject({ name: '茶饮', icon: 'soda' });
    expect((await request(`/tags/${tag.id}`, 'PATCH', { name: '旧版本', version: tag.version })).status).toBe(409);
    await read(await request(`/tags/${tag.id}`, 'DELETE', { version: renamed.version }));
    const list = await read<TagList>(await request('/tags'));
    expect(list.tags.some(t => t.id === tag.id)).toBe(false);
    expect(list.rules.some(r => r.id === rule.id)).toBe(false);
    expect((await request(`/tag-rules/${rule.id}`, 'DELETE', { version: 1 })).status).toBe(404);
  });

  it('账单按标签筛选，月度汇总给出分类下的标签金额', async () => {
    await spend('美团-美团App喜茶', '20');
    await spend('财付通-微信支付-饿了么', '30');
    await spend('美团-美团App团购', '100');
    await spend('财付通-微信支付-寿司郎', '200');
    await spend('财付通-微信支付-饿了么超市', '50', 'shopping');
    await spend('现金-楼下早餐摊', '10');
    const page = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food&tagId=food:takeout'));
    expect(page.items.map(i => i.description)).toEqual(['财付通-微信支付-饿了么']);
    expect(page.summary.expenseCents).toBe(3000);
    const summary = await read<Summary>(await request('/summary?month=2026-11'));
    const food = summary.categories.find(c => c.categoryId === 'food')!;
    expect(food.amountCents).toBe(36000);
    expect(food.tags).toEqual([
      { tagId: 'food:dine-in', name: '堂食', amountCents: 30000, count: 2 },
      { tagId: 'food:takeout', name: '外卖', amountCents: 3000, count: 1 },
      { tagId: 'food:drinks', name: '饮品甜点', amountCents: 2000, count: 1 },
    ]);
    const other = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food&tagId=none'));
    expect(other.items.map(i => i.description)).toEqual(['现金-楼下早餐摊']);
    expect(summary.categories.find(c => c.categoryId === 'shopping')!.tags).toBeUndefined();
    // 账单列表按当前筛选给出「分类 × 二级标签」构成，金额降序
    const all = await read<TransactionPage>(await request('/transactions?month=2026-11'));
    expect(all.breakdown!.map(b => [b.categoryName, b.tagName, b.amountCents])).toEqual([
      ['餐饮', '堂食', 30000], ['购物', null, 5000], ['餐饮', '外卖', 3000], ['餐饮', '饮品甜点', 2000], ['餐饮', null, 1000],
    ]);
    const foodOnly = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food'));
    expect(foodOnly.breakdown!.every(b => b.categoryId === 'food')).toBe(true);
  });

  it('单笔手动指定二级分类：优先于规则，可归入其他或恢复自动；换分类后失效，删除标签时清除', async () => {
    const tea = await spend('美团-美团App喜茶', '20');
    const sushi = await spend('财付通-微信支付-寿司郎', '200');
    const put = (id: string, tagId: string | null) => request(`/transactions/${id}/tag`, 'PUT', { tagId });
    expect((await put(sushi.id, 'transport:taxi')).status).toBe(422);
    expect((await put('missing', null)).status).toBe(404);
    await read(await put(sushi.id, 'food:takeout'));
    await read(await put(tea.id, null));
    const takeout = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food&tagId=food:takeout'));
    expect(takeout.items.map(i => i.description)).toEqual(['财付通-微信支付-寿司郎']);
    expect(takeout.items[0].tagOverride).toEqual({ categoryId: 'food', tagId: 'food:takeout' });
    const none = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food&tagId=none'));
    expect(none.items.map(i => i.description)).toEqual(['美团-美团App喜茶']);
    const summary = await read<Summary>(await request('/summary?month=2026-11'));
    expect(summary.categories.find(c => c.categoryId === 'food')!.tags).toEqual([{ tagId: 'food:takeout', name: '外卖', amountCents: 20000, count: 1 }]);
    await read(await request(`/transactions/${tea.id}/tag`, 'DELETE', {}));
    const drinks = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food&tagId=food:drinks'));
    expect(drinks.items.map(i => i.id)).toEqual([tea.id]);
    // 换了分类后手动指定不再生效（只在原分类下作数）
    expect(matchTag({ categoryId: 'shopping', description: '寿司郎', counterparty: '', tagOverride: { categoryId: 'food', tagId: 'food:takeout' } },
      (await read<TagList>(await request('/tags'))).tags, [])).toBeNull();
    const custom = await read<Tag>(await request('/tags', 'POST', { name: '日料', categoryId: 'food' }), 201);
    await read(await put(sushi.id, custom.id));
    await read(await request(`/tags/${custom.id}`, 'DELETE', { version: custom.version }));
    const after = await read<TransactionPage>(await request('/transactions?month=2026-11&categoryId=food'));
    expect(after.items.find(i => i.id === sushi.id)!.tagOverride).toBeUndefined();
  });

  it('新库按备份恢复自定义种子、同名重建、删除和手动指定', async () => {
    await read(await request('/tags/food:takeout', 'DELETE', { version: 1 }));
    const replacement = await read<Tag>(await request('/tags', 'POST', { name: '外卖', categoryId: 'food' }), 201);
    await read(await request('/tags/food:drinks', 'PATCH', { name: '自定义饮品', icon: 'other', version: 1 }));
    await read(await request('/tags/food:drinks/move', 'POST', { direction: 'up' }));
    await read(await request('/tag-rules/food:dine-in:1', 'PATCH', { keyword: '自定义关键词', matchType: 'exact', version: 1 }));
    await read(await request('/tag-rules/food:dine-in:2', 'DELETE', { version: 1 }));
    const transaction = await spend('指定外卖标签的账单', '20');
    const route = `/transactions/${transaction.id}`;
    await read(await request(route + '/tag', 'PUT', { tagId: replacement.id }));
    const edited = await read<Transaction>(await request(route, 'PATCH', { ...transaction, transferDirection: undefined, amount: '20', note: '修改后仍保留标签' }));
    expect(edited.tagOverride).toEqual({ categoryId: 'food', tagId: replacement.id });
    await read(await request(route + '/archive', 'POST', { version: edited.version }));
    expect((await request(route + '/tag', 'PUT', { tagId: null })).status).toBe(404);
    expect((await request(route + '/tag', 'DELETE')).status).toBe(404);
    // Real email import uses a separate receipt scope from manual and shortcut writes.
    await db.prepare("UPDATE transactions SET idempotency_scope='mail:cmb-default', idempotency_key='imap:7:101', fixed_auto_excluded=1 WHERE id=?")
      .bind(transaction.id).run();
    const tag = await read<Tag>(await request('/tags', 'POST', { name: '早餐', categoryId: 'food' }), 201);
    await read<TagRule>(await request('/tag-rules', 'POST', { tagId: tag.id, keyword: '包子铺' }), 201);
    const backup = await read<CurrentBackup>(await request('/backup'));
    expect(backup.tags?.some(t => t.id === tag.id)).toBe(true);
    db.close(); await rm(directory, { recursive: true, force: true });
    directory = await mkdtemp(join(tmpdir(), 'qingji-tags-test-'));
    db = new LocalDatabase(join(directory, 'ledger.sqlite'));
    await applyMigrations(db, resolve('migrations'));
    const login = await request('/session', 'POST', { accessKey: ownerKey });
    cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    await read(await request('/backup/restore', 'POST', { ...backup, tagRules: [...backup.tagRules!, { id: 'orphan', tagId: 'missing', keyword: 'x', matchType: 'contains', version: 1 }] }));
    const list = await read<TagList>(await request('/tags'));
    expect(list.tags.find(t => t.id === tag.id)?.name).toBe('早餐');
    expect(list.rules.some(r => r.keyword === '包子铺')).toBe(true);
    expect(list.rules.some(r => r.id === 'orphan')).toBe(false);
    expect(list.tags.filter(t => t.name === '外卖')).toHaveLength(1);
    expect(list.tags.find(t => t.id === tag.id)?.position).toBe(backup.tags!.find(t => t.id === tag.id)!.position);
    const restored = await read<CurrentBackup>(await request('/backup'));
    expect(restored.tags).toEqual(backup.tags);
    expect(restored.tagRules).toEqual(backup.tagRules);
    expect(restored.transactionTags).toEqual([{ transactionId: transaction.id, tagId: replacement.id, categoryId: 'food' }]);
    expect(restored.receipts).toEqual(backup.receipts);
    expect(restored.transactions[0].fixedAutoExcluded).toBe(true);
    await read(await request('/backup/restore', 'POST', backup));
    await read(await request('/tags/food:drinks', 'PATCH', { name: '目标库独立修改', version: 2 }));
    expect((await request('/backup/restore', 'POST', backup)).status).toBe(409);
    expect((await read<TagList>(await request('/tags'))).tags.find(t => t.id === 'food:drinks')?.name).toBe('目标库独立修改');
  });
});
