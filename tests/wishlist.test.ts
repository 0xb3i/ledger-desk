import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { WishlistInput, WishlistItem, WishlistPage } from '../src/shared/contracts';

let db: LocalDatabase, directory: string, cookie: string;
const origin = 'https://wishlist.test';
const ownerKey = 'pd_owner_' + 'wishlist-isolated-test'.repeat(4);
const input = (extra: Partial<WishlistInput> = {}): WishlistInput => ({ title: '降噪耳机', brand: '', amount: '899.90', url: 'https://example.com/headphones', note: '试戴后再决定', ...extra });
function request(path = '/wishlist', method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
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
async function create(extra: Partial<WishlistInput> = {}) {
  return read<WishlistItem>(await request('/wishlist', 'POST', { ...input(extra), id: crypto.randomUUID() }), 201);
}
async function list(query = '') { return read<WishlistPage>(await request('/wishlist' + query)); }

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qingji-wishlist-test-'));
  db = new LocalDatabase(join(directory, 'ledger.sqlite'));
  await applyMigrations(db, resolve('migrations'));
  cookie = '';
  const login = await request('/session', 'POST', { accessKey: ownerKey });
  expect(login.status).toBe(200);
  cookie = login.headers.get('Set-Cookie')!.split(';')[0];
});
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

describe('独立心愿单 API', () => {
  it('拒绝无会话、设备令牌及跨来源访问，所有写入都需要会话与 Origin', async () => {
    const item = await create();
    const routes = [
      ['/wishlist', 'GET', undefined], ['/wishlist/' + item.id, 'GET', undefined],
      ['/wishlist', 'POST', { ...input(), id: crypto.randomUUID() }],
      ['/wishlist/' + item.id, 'PUT', { ...input(), version: 1 }],
      ['/wishlist/' + item.id, 'DELETE', { version: 1 }],
      [`/wishlist/${item.id}/status`, 'POST', { status: 'purchased', version: 1 }],
      [`/wishlist/${item.id}/restore`, 'POST', { version: 1 }],
    ] as const;
    for (const [path, method, body] of routes) {
      expect((await request(path, method, body, { Cookie: '' })).status).toBe(401);
      expect((await request(path, method, body, { Cookie: '', Authorization: 'Bearer pd_device_' + 'A'.repeat(43) })).status).toBe(401);
      if (method !== 'GET') {
        expect((await request(path, method, body, { Origin: 'https://other.test' })).status).toBe(403);
        expect((await request(path, method, body, { Origin: '' })).status).toBe(403);
      }
    }
    expect(await read<WishlistItem>(await request('/wishlist/' + item.id))).toEqual(item);
  });

  it('可创建、修改、标记已购、重新想买、软删和恢复，持久保存且不生成账目', async () => {
    let item = await create({ title: '  降噪耳机  ' });
    expect(item).toMatchObject({ title: '降噪耳机', amountCents: 89990, status: 'wanted', purchasedAt: null, deletedAt: null, version: 1 });
    item = await read<WishlistItem>(await request('/wishlist/' + item.id, 'PUT', { ...input({ amount: null, note: '稍后对比价格' }), version: item.version }));
    expect(item).toMatchObject({ amountCents: null, note: '稍后对比价格', version: 2 });
    item = await read<WishlistItem>(await request(`/wishlist/${item.id}/status`, 'POST', { status: 'purchased', version: item.version }));
    expect(item.status).toBe('purchased'); expect(item.purchasedAt).toEqual(expect.any(String));
    const purchasedAt = item.purchasedAt;
    item = await read<WishlistItem>(await request('/wishlist/' + item.id, 'DELETE', { version: item.version }));
    expect(item.deletedAt).toEqual(expect.any(String));
    expect((await list()).total).toBe(0);
    expect((await list('?status=purchased')).total).toBe(0);
    expect((await list('?status=deleted')).items).toEqual([item]);
    expect(await read<WishlistItem>(await request('/wishlist/' + item.id))).toEqual(item);
    expect((await request('/wishlist/' + item.id, 'PUT', { ...input(), version: item.version })).status).toBe(409);
    expect((await request(`/wishlist/${item.id}/status`, 'POST', { status: 'wanted', version: item.version })).status).toBe(409);
    item = await read<WishlistItem>(await request(`/wishlist/${item.id}/restore`, 'POST', { version: item.version }));
    expect(item).toMatchObject({ status: 'purchased', purchasedAt, deletedAt: null });
    expect((await list('?status=purchased')).items).toEqual([item]);
    item = await read<WishlistItem>(await request(`/wishlist/${item.id}/status`, 'POST', { status: 'wanted', version: item.version }));
    expect(item).toMatchObject({ status: 'wanted', purchasedAt: null });
    db.close(); db = new LocalDatabase(join(directory, 'ledger.sqlite'));
    await applyMigrations(db, resolve('migrations'));
    expect(await read<WishlistItem>(await request('/wishlist/' + item.id))).toEqual(item);
    expect(await db.prepare('SELECT COUNT(*) FROM transactions').first('COUNT(*)')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) FROM transaction_audit').first('COUNT(*)')).toBe(0);
  });

  it('稳定创建 ID 的网络重试不会重复，编辑或删除后仍返回原记录；不同初始内容冲突', async () => {
    const body = { ...input(), id: crypto.randomUUID() };
    const responses = await Promise.all([request('/wishlist', 'POST', body), request('/wishlist', 'POST', body)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
    const item = (await responses[0].json() as { data: WishlistItem }).data;
    let updated = await read<WishlistItem>(await request('/wishlist/' + item.id, 'PUT', { ...input({ title: '后来选中的耳机' }), version: item.version }));
    expect(await read<WishlistItem>(await request('/wishlist', 'POST', body))).toEqual(updated);
    updated = await read<WishlistItem>(await request('/wishlist/' + item.id, 'DELETE', { version: updated.version }));
    expect(await read<WishlistItem>(await request('/wishlist', 'POST', body))).toEqual(updated);
    expect((await request('/wishlist', 'POST', { ...body, amount: '900' })).status).toBe(409);
    expect(await db.prepare('SELECT COUNT(*) FROM wishlist_items').first('COUNT(*)')).toBe(1);
    expect(updated).not.toHaveProperty('create_payload_hash');
  });

  it('并发修改只允许一个版本成功，旧版本删除与恢复不会覆盖新状态', async () => {
    const item = await create();
    const results = await Promise.all([
      request('/wishlist/' + item.id, 'PUT', { ...input({ title: '修改 A' }), version: item.version }),
      request('/wishlist/' + item.id, 'PUT', { ...input({ title: '修改 B' }), version: item.version }),
    ]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const latest = await read<WishlistItem>(await request('/wishlist/' + item.id));
    expect(latest.version).toBe(2);
    expect((await request('/wishlist/' + item.id, 'DELETE', { version: 1 })).status).toBe(409);
    const removed = await read<WishlistItem>(await request('/wishlist/' + item.id, 'DELETE', { version: latest.version }));
    expect((await request(`/wishlist/${item.id}/restore`, 'POST', { version: latest.version })).status).toBe(409);
    expect(await read<WishlistItem>(await request('/wishlist/' + item.id))).toEqual(removed);
    expect((await request(`/wishlist/${crypto.randomUUID()}`, 'GET')).status).toBe(404);
  });

  it('搜索、各状态数量及价格合计共用筛选范围，未知价格不当成零价商品', async () => {
    await create({ title: '相机机身', amount: '1234.56' });
    await create({ title: '相机镜头', amount: null });
    let purchased = await create({ title: '相机包', amount: '99.01' });
    purchased = await read<WishlistItem>(await request(`/wishlist/${purchased.id}/status`, 'POST', { status: 'purchased', version: purchased.version }));
    const removed = await create({ title: '相机三脚架', amount: '50' });
    await read<WishlistItem>(await request('/wishlist/' + removed.id, 'DELETE', { version: removed.version }));
    await create({ title: '无关商品', amount: '9999' });
    await create({ title: '折扣 50%_off', amount: '10.01' });
    expect(await list('?search=' + encodeURIComponent('相机'))).toMatchObject({ total: 2, pricedCount: 1, totalAmountCents: 123456, counts: { wanted: 2, purchased: 1, deleted: 1 } });
    expect(await list('?status=purchased&search=' + encodeURIComponent('相机'))).toMatchObject({ total: 1, pricedCount: 1, totalAmountCents: 9901, counts: { wanted: 2, purchased: 1, deleted: 1 } });
    expect(await list('?status=deleted&search=' + encodeURIComponent('相机'))).toMatchObject({ total: 1, pricedCount: 1, totalAmountCents: 5000, counts: { wanted: 2, purchased: 1, deleted: 1 } });
    expect((await list('?search=' + encodeURIComponent('%_'))).total).toBe(1);
    expect((await list('?search=OFF')).total).toBe(1);
    expect(await list('?search=absent')).toMatchObject({ items: [], total: 0, totalAmountCents: 0, pricedCount: 0, counts: { wanted: 0, purchased: 0, deleted: 0 } });
  });

  it('品牌可保存、修改并参与搜索；旧客户端不传品牌时按空字符串处理', async () => {
    const legacy = { title: '旧客户端心愿', amount: null, url: '', note: '' };
    expect((await read<WishlistItem>(await request('/wishlist', 'POST', { ...legacy, id: crypto.randomUUID() }), 201)).brand).toBe('');
    const item = await create({ title: '双肩包', brand: ' Charles & Keith ' });
    expect(item.brand).toBe('Charles & Keith');
    expect((await list('?search=' + encodeURIComponent('keith'))).items.map(i => i.id)).toEqual([item.id]);
    const edited = await read<WishlistItem>(await request('/wishlist/' + item.id, 'PUT', { ...input({ title: '双肩包', brand: 'Coach' }), version: item.version }));
    expect(edited.brand).toBe('Coach');
    expect((await request('/wishlist', 'POST', { ...input({ brand: 'x'.repeat(101) }), id: crypto.randomUUID() })).status).toBe(422);
  });

  it('分页顺序稳定且金额统计覆盖全部结果，不被当前页缩小', async () => {
    const ids: string[] = [];
    for (let index = 0; index < 32; index++) ids.push((await create({ title: `分页 ${index}`, amount: '0.01' })).id);
    const first = await list(), second = await list('?page=2');
    expect(first.items).toHaveLength(30); expect(second.items).toHaveLength(2);
    expect(first).toMatchObject({ total: 32, page: 1, pageSize: 30, totalAmountCents: 32, pricedCount: 32 });
    expect(second).toMatchObject({ total: 32, page: 2, totalAmountCents: 32, pricedCount: 32 });
    expect(new Set([...first.items, ...second.items].map(item => item.id))).toEqual(new Set(ids));
    const all = [...first.items, ...second.items];
    // 想买按排队顺序：新心愿排在队尾，所以与添加顺序一致
    expect(all.map(item => item.id)).toEqual(ids);
    expect(all.map(item => item.position)).toEqual([...all.map(item => item.position)].sort((a, b) => a! - b!));
  });

  it('调整排队顺序：移到指定位置，其余顺延；已购心愿不能调整，不存在返回 404', async () => {
    const [a, b, c] = [await create({ title: '甲' }), await create({ title: '乙' }), await create({ title: '丙' })];
    const order = async () => (await list()).items.map(item => item.title);
    expect(await order()).toEqual(['甲', '乙', '丙']);
    await read(await request(`/wishlist/${c.id}/position`, 'POST', { position: 1 }));
    expect(await order()).toEqual(['丙', '甲', '乙']);
    await read(await request(`/wishlist/${c.id}/position`, 'POST', { position: 99 }));
    expect(await order()).toEqual(['甲', '乙', '丙']);
    const bought = await read<WishlistItem>(await request(`/wishlist/${b.id}/status`, 'POST', { status: 'purchased', version: b.version }));
    expect((await request(`/wishlist/${b.id}/position`, 'POST', { position: 1 })).status).toBe(409);
    expect((await request(`/wishlist/${crypto.randomUUID()}/position`, 'POST', { position: 1 })).status).toBe(404);
    expect((await request(`/wishlist/${a.id}/position`, 'POST', { position: 0 })).status).toBe(422);
    // 移回想买后仍按原来的槽位排队，不与现有顺序冲突
    await read(await request(`/wishlist/${b.id}/status`, 'POST', { status: 'wanted', version: bought.version }));
    expect((await order()).sort()).toEqual(['丙', '乙', '甲'].sort());
  });

  it('两次并发排序均保留，第二页的心愿可以提到队首', async () => {
    const items = [];
    for (let i = 0; i < 31; i++) items.push(await create({ title: `心愿 ${i}` }));
    const ids = items.map(item => item.id);
    const moves = await Promise.all([
      request(`/wishlist/${ids[0]}/position`, 'POST', { position: 2 }),
      request(`/wishlist/${ids[3]}/position`, 'POST', { position: 3 }),
    ]);
    expect(moves.map(r => r.status)).toEqual([200, 200]);
    expect((await list()).items.slice(0, 4).map(i => i.id)).toEqual([ids[1], ids[0], ids[3], ids[2]]);
    const last = (await list('?page=2')).items[0];
    await read(await request(`/wishlist/${last.id}/position`, 'POST', { position: 1 }));
    expect((await list()).items[0].id).toBe(last.id);
  });

  it('校验空名称、长度、金额精度、危险链接、版本和筛选参数', async () => {
    for (const extra of [
      { title: '   ' }, { title: '字'.repeat(201) }, { note: '字'.repeat(2001) },
      { amount: '0' }, { amount: '-1' }, { amount: '1.001' }, { amount: '1e2' }, { amount: '10000000000' }, { amount: '' },
      { url: 'javascript:alert(1)' }, { url: 'data:text/html,hello' }, { url: 'https://user:password@example.com/' },
      { url: 'file:///etc/passwd' }, { url: 'not a url' }, { url: 'https://example.com/\nsecret' },
    ]) expect((await request('/wishlist', 'POST', { ...input(extra), id: crypto.randomUUID() })).status, JSON.stringify(extra)).toBe(422);
    expect((await create({ amount: '9999999999.99', url: '', note: '' })).amountCents).toBe(999999999999);
    const item = await create();
    for (const version of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) expect((await request('/wishlist/' + item.id, 'PUT', { ...input(), version })).status).toBe(422);
    expect((await request('/wishlist', 'POST', { ...input(), id: 'arbitrary-key' })).status).toBe(422);
    for (const query of ['?page=0', '?page=-1', '?page=1.5', '?status=unknown']) expect((await request('/wishlist' + query)).status).toBe(422);
    expect((await request(`/wishlist/${item.id}/status`, 'POST', { status: 'archived', version: 1 })).status).toBe(422);
  });

  it('数据库约束拒绝非整数金额与无购买时间的已购状态', async () => {
    const item = await create();
    for (const amount of [0, -1, 1.5, 1000000000000]) {
      await expect(db.prepare('UPDATE wishlist_items SET amount_cents=? WHERE id=?').bind(amount, item.id).run()).rejects.toThrow();
    }
    await expect(db.prepare("UPDATE wishlist_items SET status='purchased' WHERE id=?").bind(item.id).run()).rejects.toThrow();
    await expect(db.prepare('UPDATE wishlist_items SET version=0 WHERE id=?').bind(item.id).run()).rejects.toThrow();
    expect(await read<WishlistItem>(await request('/wishlist/' + item.id))).toEqual(item);
  });
});
