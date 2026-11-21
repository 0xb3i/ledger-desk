import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LocalDatabase } from './database';

export async function applyMigrations(db: LocalDatabase, directory: string): Promise<void> {
  const names = (await readdir(directory)).filter(name => /^\d{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error('找不到本地数据库迁移文件。');
  const applied = db.appliedMigrations();
  if (applied.some(migration => !names.includes(migration.name))) throw new Error('当前应用缺少数据库已经应用的迁移，请使用匹配或更新的应用版本。');
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
  }));
  // Check every previous digest before applying any new migration.
  for (const previous of applied) {
    if (migrations.find(migration => migration.name === previous.name)!.sha256 !== previous.sha256) {
      throw new Error(`已应用的迁移 ${previous.name} 内容发生变化，请恢复原迁移并追加新文件。`);
    }
  }
  for (const migration of migrations) db.applyMigration(migration.name, migration.sha256, migration.sql);
}
