import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { app } from '../src/server';
import type { Env } from '../src/server/types';
import type { Backup, BackupRestoreResult, MonthlyBudget } from '../src/shared/contracts';

let db: LocalDatabase, directory: string, cookie: string;
const origin = 'https://budget.test';
const ownerKey = 'pd_owner_' + 'budget-isolated-test'.repeat(4);
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
const budget = async () => read<MonthlyBudget>(await request('/budget'));
const save = (amount: string | null, version: number) => request('/budget', 'PUT', { amount, version });

async function freshDatabase() {
  directory = await mkdtemp(join(tmpdir(), 'qingji-budget-test-'));
  db = new LocalDatabase(join(directory, 'ledger.sqlite'));
  await applyMigrations(db, resolve('migrations'));
  cookie = '';
  const login = await request('/session', 'POST', { accessKey: ownerKey });
  expect(login.status).toBe(200);
  cookie = login.headers.get('Set-Cookie')!.split(';')[0];
}
beforeEach(freshDatabase);
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });

describe('月度总预算 API', () => {
  it('需要会话，跨来源写入被拒绝', async () => {
    expect((await request('/budget', 'GET', undefined, { Cookie: '' })).status).toBe(401);
    expect((await request('/budget', 'PUT', { amount: '100', version: 1 }, { Origin: 'https://other.test' })).status).toBe(403);
  });

  it('默认未设置；可设置、修改和清除，每次修改版本加一', async () => {
    expect(await budget()).toEqual({ amountCents: null, version: 1 });
    expect(await read<MonthlyBudget>(await save('9100', 1))).toEqual({ amountCents: 910000, version: 2 });
    expect(await read<MonthlyBudget>(await save('8000.50', 2))).toEqual({ amountCents: 800050, version: 3 });
    expect(await read<MonthlyBudget>(await save(null, 3))).toEqual({ amountCents: null, version: 4 });
    expect(await read<MonthlyBudget>(await save('  ', 4))).toEqual({ amountCents: null, version: 5 });
  });

  it('过期版本返回 409 且不写入', async () => {
    await read(await save('100', 1));
    expect((await save('999', 1)).status).toBe(409);
    expect(await budget()).toEqual({ amountCents: 10000, version: 2 });
  });

  it('拒绝零、负数、千位分隔符和超过两位小数的金额', async () => {
    for (const amount of ['0', '-1', '1,000', '1.234', 'abc']) expect((await save(amount, 1)).status).toBe(422);
    expect(await budget()).toEqual({ amountCents: null, version: 1 });
  });
});

describe('预算备份', () => {
  it('导出 v7 含预算；恢复到新库后保持一致，重复恢复不改动', async () => {
    await read(await save('9100', 1));
    const backup = await read<Backup>(await request('/backup'));
    expect(backup.schemaVersion).toBe(7);
    expect('budget' in backup && backup.budget).toEqual({ amountCents: 910000 });

    db.close(); await rm(directory, { recursive: true, force: true }); await freshDatabase();
    expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', backup))).toMatchObject({ budgetRestored: true });
    expect((await budget()).amountCents).toBe(910000);
    expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', backup))).toMatchObject({ budgetRestored: false });
  });

  it('当前已有不同预算时整批拒绝，不写入任何数据', async () => {
    await read(await save('9100', 1));
    const backup = await read<Backup>(await request('/backup'));
    await read(await save('100', 2));
    expect((await request('/backup/restore', 'POST', backup)).status).toBe(409);
    expect((await budget()).amountCents).toBe(10000);
  });

  it('未设预算的备份与旧 v6 备份不影响现有预算；拒绝非法预算金额', async () => {
    const empty = await read<Backup>(await request('/backup'));
    expect('budget' in empty && empty.budget).toBeNull();
    await read(await save('50', 1));
    expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', empty))).toMatchObject({ budgetRestored: false });
    const { budget: _, ...legacy } = empty as Extract<Backup, { schemaVersion: 7 }>;
    expect(await read<BackupRestoreResult>(await request('/backup/restore', 'POST', { ...legacy, schemaVersion: 6 }))).toMatchObject({ budgetRestored: false });
    expect((await request('/backup/restore', 'POST', { ...empty, budget: { amountCents: 0 } })).status).toBe(422);
    expect((await budget()).amountCents).toBe(5000);
  });
});
