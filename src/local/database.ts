import { closeSync, constants, mkdirSync, openSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

function binding(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  throw new TypeError('SQLite 参数只能使用文本、有限数字、二进制数据或 null。');
}

/** D1's used query contract on one local SQLite connection; no replica emulation. */
export class LocalDatabase implements D1Database {
  private readonly connection: DatabaseSync;
  private closed = false;

  constructor(readonly filename: string) {
    if (filename !== ':memory:') {
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
      const descriptor = openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      closeSync(descriptor);
      chmodSync(filename, 0o600);
    }
    this.connection = new DatabaseSync(filename);
    this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  }

  prepare(query: string): LocalStatement {
    const statement = this.connection.prepare(query);
    if (statement.sourceSQL.trim() !== query.trim()) throw new Error('prepare 只接受一条完整 SQL 语句。');
    return new LocalStatement(this, query, statement);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.some(statement => !(statement instanceof LocalStatement) || statement.database !== this)) {
      throw new TypeError('批量操作必须使用同一本地数据库的语句。');
    }
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      // No await inside the transaction: another request cannot interleave here.
      const results = statements.map(statement => (statement as LocalStatement).execute<T>());
      this.connection.exec('COMMIT');
      return results;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  execute<T>(statement: StatementSync, values: SQLInputValue[], runOnly = false): D1Result<T> {
    const started = performance.now();
    const before = this.statistics();
    let results: T[] = [], directChanges: number | undefined;
    if (runOnly) directChanges = Number(statement.run(...values).changes);
    else results = statement.all(...values).map(row => ({ ...row }) as T);
    const after = this.statistics();
    const written = after.total - before.total;
    return {
      success: true, results,
      meta: {
        duration: performance.now() - started, size_after: after.size,
        // Local counts describe materialized rows and SQLite writes, not D1 billing.
        rows_read: results.length, rows_written: written, last_row_id: after.lastId,
        changed_db: written > 0 || before.schema !== after.schema,
        changes: written > 0 ? directChanges ?? after.changes : 0,
      },
    };
  }

  private statistics(): { total: number; changes: number; lastId: number; size: number; schema: number } {
    const row = this.connection.prepare(`SELECT total_changes() AS total, changes() AS changes, last_insert_rowid() AS lastId,
      (SELECT page_count FROM pragma_page_count)*(SELECT page_size FROM pragma_page_size) AS size,
      (SELECT schema_version FROM pragma_schema_version) AS schema`).get()!;
    return row as unknown as { total: number; changes: number; lastId: number; size: number; schema: number };
  }

  appliedMigrations(): { name: string; sha256: string }[] {
    this.connection.exec('CREATE TABLE IF NOT EXISTS local_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)');
    return this.connection.prepare('SELECT name,sha256 FROM local_schema_migrations ORDER BY name').all()
      .map(row => ({ name: String(row.name), sha256: String(row.sha256) }));
  }

  applyMigration(name: string, sha256: string, sql: string): void {
    this.appliedMigrations();
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.connection.prepare('SELECT sha256 FROM local_schema_migrations WHERE name=?').get(name);
      if (existing && existing.sha256 !== sha256) throw new Error(`已应用的迁移 ${name} 内容发生变化，请恢复原迁移并追加新文件。`);
      if (!existing) {
        this.connection.exec(sql);
        this.connection.prepare('INSERT INTO local_schema_migrations(name,sha256,applied_at) VALUES (?,?,?)')
          .run(name, sha256, new Date().toISOString());
      }
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    if (!this.closed) { this.connection.close(); this.closed = true; }
  }

  async exec(_query: string): Promise<D1ExecResult> { throw new Error('本地数据库不提供 D1 exec；结构变更必须使用追加迁移。'); }
  withSession(_constraint?: string): D1DatabaseSession { throw new Error('本地数据库使用单连接，不提供 D1 副本会话。'); }
  async dump(): Promise<ArrayBuffer> { throw new Error('本地数据库不提供已弃用的 D1 dump；请使用账本备份接口。'); }
}

class LocalStatement implements D1PreparedStatement {
  constructor(readonly database: LocalDatabase, private readonly query: string,
              private readonly statement: StatementSync, private readonly values: SQLInputValue[] = []) {}

  bind(...values: unknown[]): LocalStatement {
    const bound = this.database.prepare(this.query);
    return new LocalStatement(this.database, this.query, bound.statement, values.map(binding));
  }

  execute<T = Record<string, unknown>>(): D1Result<T> { return this.database.execute<T>(this.statement, this.values); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>().results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column)) throw new Error('查询结果中不存在指定列。');
    return row[column] as T;
  }
  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.execute<T>(); }
  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { return this.database.execute<T>(this.statement, this.values, true); }
  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    this.statement.setReturnArrays(true);
    try {
      const rows = this.statement.all(...this.values) as unknown as T[];
      return options?.columnNames ? [this.statement.columns().map(column => column.name), ...rows] : rows;
    } finally { this.statement.setReturnArrays(false); }
  }
}
