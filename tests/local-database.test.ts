import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalDatabase } from '../src/local/database';
import { applyMigrations } from '../src/local/migrations';
import { createTransaction } from '../src/server/ledger/repository';
import { normalizeInput } from '../src/server/ledger/domain';

let directory: string, db: LocalDatabase;
const migrations = new URL('../migrations/', import.meta.url).pathname;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'qingji-sqlite-test-'));
  db = new LocalDatabase(join(directory, 'ledger.sqlite'));
  await applyMigrations(db, migrations);
});
afterEach(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });

describe('真实 SQLite 的 D1 核心契约', () => {
  it('绑定互不污染，first/null/raw 返回原始类型，SELECT 不误报之前的写入', async () => {
    const prepared = db.prepare('SELECT ? AS value');
    expect(await Promise.all([prepared.bind('甲').first('value'), prepared.bind('乙').first('value')])).toEqual(['甲', '乙']);
    expect(await prepared.bind(null).first('value')).toBeNull();
    expect(await db.prepare('SELECT id FROM accounts WHERE id=?').bind('missing').first()).toBeNull();
    await expect(prepared.bind('甲').first('absent')).rejects.toThrow('不存在');
    expect(await db.prepare('SELECT 1 AS a, 2 AS b').raw({ columnNames: true })).toEqual([['a', 'b'], [1, 2]]);
    const inserted = await db.prepare('INSERT INTO categories(id,name,kind) VALUES (?,?,?)').bind('local-test', '测试', 'both').run();
    expect(inserted.meta.changes).toBe(1);
    expect((await db.prepare('SELECT * FROM categories').all()).meta.changes).toBe(0);
    expect((await db.prepare('SELECT 1').run()).meta.changes).toBe(0);
    expect(() => db.prepare('SELECT 1; SELECT 2')).toThrow('一条');
  });

  it('batch 保留 RETURNING 结果，任何失败回滚所有数据及触发器审计', async () => {
    await db.prepare('CREATE TABLE batch_entries(id INTEGER PRIMARY KEY)').run();
    await db.prepare('CREATE TABLE batch_audit(entry_id INTEGER)').run();
    await db.prepare('CREATE TRIGGER batch_log AFTER INSERT ON batch_entries BEGIN INSERT INTO batch_audit VALUES(NEW.id); END;').run();
    await expect(db.batch([
      db.prepare('INSERT INTO batch_entries VALUES (1) RETURNING id'),
      db.prepare('INSERT INTO batch_entries VALUES (1)'),
    ])).rejects.toThrow();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM batch_entries').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM batch_audit').first('n')).toBe(0);
    const result = await db.batch<{ id: number }>([
      db.prepare('INSERT INTO batch_entries VALUES (2) RETURNING id'),
      db.prepare('SELECT id FROM batch_entries'),
    ]);
    expect(result.map(item => item.results)).toEqual([[{ id: 2 }], [{ id: 2 }]]);
    expect(result[0].meta.changes).toBe(1);
    expect(result[1].meta.changes).toBe(0);
  });

  it('共享入账逻辑并发重试只产生一笔和一条审计，重启保留数据', async () => {
    const input = normalizeInput({ occurredAt: '2026-11-02T09:00:00+08:00', amount: '10.29', kind: 'expense', description: '隔离测试', accountId: 'cmb-default' });
    const results = await Promise.all(Array.from({ length: 8 }, () => createTransaction(db, input, { source: 'shortcut', scope: 'shortcut:cmb-default', key: 'native-sqlite-key' })));
    expect(new Set(results.map(result => result.transaction.id)).size).toBe(1);
    expect(results.filter(result => !result.duplicate)).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) FROM transaction_audit').first('COUNT(*)')).toBe(1);
    db.close();
    db = new LocalDatabase(join(directory, 'ledger.sqlite'));
    await applyMigrations(db, migrations);
    expect(await db.prepare('SELECT amount_cents FROM transactions').first('amount_cents')).toBe(1029);
    expect((await stat(join(directory, 'ledger.sqlite'))).mode & 0o777).toBe(0o600);
    expect(await db.prepare('PRAGMA foreign_keys').first('foreign_keys')).toBe(1);
    expect(await db.prepare('PRAGMA journal_mode').first('journal_mode')).toBe('wal');
  });

  it('迁移可重复运行，旧文件修改会拒绝，失败迁移完整回滚', async () => {
    const copied = join(directory, 'migrations');
    await mkdir(copied);
    for (const name of await readdir(migrations)) await writeFile(join(copied, name), await readFile(join(migrations, name)));
    await applyMigrations(db, copied);
    const before = db.appliedMigrations();
    await writeFile(join(copied, '0003_invalid.sql'), 'CREATE TABLE should_rollback(id TEXT); INSERT INTO missing_table VALUES (1);');
    await expect(applyMigrations(db, copied)).rejects.toThrow();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").first()).toBeNull();
    expect(db.appliedMigrations()).toEqual(before);
    await rm(join(copied, '0003_invalid.sql'));
    await writeFile(join(copied, '0001_platform.sql'), '-- changed migration');
    await expect(applyMigrations(db, copied)).rejects.toThrow('内容发生变化');
    expect(await db.prepare('SELECT COUNT(*) FROM accounts').first('COUNT(*)')).toBe(1);
  });
});
