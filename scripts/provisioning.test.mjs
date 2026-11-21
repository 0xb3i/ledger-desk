import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindDeploymentConfig, databaseIdFromCreateOutput, ensureOwnerKey, parseWranglerConfig,
  placeholderDatabaseId, resolveAccountId, writeIfUnchanged,
} from './lib/runtime.mjs';
import { ensureWorkersDevSubdomain } from './lib/cloudflare.mjs';

const accountId = 'a'.repeat(32);
const databaseId = '12345678-1234-1234-1234-123456789012';
const config = `{
  // Keep user comments and custom fields.
  "name": "ledgerdesk",
  "d1_databases": [{ "binding": "DB", "database_name": "ledgerdesk", "database_id": "${placeholderDatabaseId}" }],
  "vars": {"PREFERENCE": "keep"},
}`;
const temporary = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'dashboard-provisioning-'));
  temporary.push(path);
  return path;
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe('deployment identity', () => {
  it('preserves JSONC comments and custom settings when binding actual resource IDs', () => {
    const next = bindDeploymentConfig(config, databaseId, accountId);
    expect(next).toContain('// Keep user comments and custom fields.');
    expect(next).toContain('"vars": {"PREFERENCE": "keep"},');
    expect(parseWranglerConfig(next).database.database_id).toBe(databaseId);
    expect(parseWranglerConfig(next).config.account_id).toBe(accountId);
    expect(bindDeploymentConfig(next, databaseId, accountId)).toBe(next);
  });
  it('does not replace a configured database or account with another one', () => {
    const next = bindDeploymentConfig(config, databaseId, accountId);
    expect(() => bindDeploymentConfig(next, '87654321-1234-1234-1234-123456789012', accountId)).toThrow('已有数据库绑定');
    expect(() => bindDeploymentConfig(next, databaseId, 'b'.repeat(32))).toThrow('已有账号配置');
  });
  it('accepts only one real UUID from a D1 creation result', () => {
    expect(databaseIdFromCreateOutput(`Created your new D1 database.\n"database_id": "${databaseId}"`)).toBe(databaseId);
    expect(() => databaseIdFromCreateOutput('Created your new D1 database.')).toThrow('无法从 Wrangler');
    expect(() => databaseIdFromCreateOutput(`"database_id": "${placeholderDatabaseId}"`)).toThrow();
    expect(() => databaseIdFromCreateOutput(`"database_id": "${databaseId}"\n"database_id": "87654321-1234-1234-1234-123456789012"`)).toThrow();
  });
  it('requires an explicitly selected account when several are authorized', () => {
    const identity = { loggedIn: true, accounts: [{ id: accountId }, { id: 'b'.repeat(32) }] };
    expect(() => resolveAccountId(identity)).toThrow('多个');
    expect(resolveAccountId(identity, accountId)).toBe(accountId);
    expect(() => resolveAccountId(identity, accountId, 'b'.repeat(32))).toThrow('不同');
    expect(() => resolveAccountId({ loggedIn: false, accounts: [] })).toThrow('登录状态');
  });
  it('detects user changes before writing configuration', async () => {
    const path = join(await directory(), 'wrangler.jsonc');
    await writeFile(path, config);
    const updated = config.replace('"keep"', '"user-edit"');
    await writeFile(path, updated);
    await expect(writeIfUnchanged(path, config, bindDeploymentConfig(config, databaseId, accountId))).rejects.toThrow('已被修改');
    expect(await readFile(path, 'utf8')).toBe(updated);
  });
});

describe('owner credentials', () => {
  it('generates a private credential once and keeps its exact contents on reruns', async () => {
    const path = join(await directory(), '.dev.vars');
    const first = await ensureOwnerKey(path);
    const contents = await readFile(path, 'utf8');
    expect(first.created).toBe(true);
    expect(first.accessKey).toMatch(/^pd_owner_[A-Za-z0-9_-]{43}$/);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = await ensureOwnerKey(path);
    expect(second.created).toBe(false);
    expect(second.accessKey === first.accessKey).toBe(true);
    expect(await readFile(path, 'utf8') === contents).toBe(true);
  });
  it('keeps an existing invalid file intact instead of resetting the key', async () => {
    const path = join(await directory(), '.dev.vars');
    const contents = 'OWNER_ACCESS_KEY=ordinary-password\nOTHER_SETTING=preserve\n';
    await writeFile(path, contents);
    await expect(ensureOwnerKey(path)).rejects.toThrow('原文件已保留');
    expect(await readFile(path, 'utf8')).toBe(contents);
  });
  it('does not follow a key-file symlink', async () => {
    const path = await directory();
    const target = join(path, 'existing');
    await writeFile(target, 'protected');
    await symlink(target, join(path, '.dev.vars'));
    await expect(ensureOwnerKey(join(path, '.dev.vars'))).rejects.toThrow('符号链接');
    expect(await readFile(target, 'utf8')).toBe('protected');
  });
});

describe('first workers.dev deployment', () => {
  function boundary(responses, credentials = { type: 'oauth', token: 'test-oauth-only' }) {
    const fetchImpl = vi.fn();
    for (const [status, body] of responses) fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
    const wranglerImpl = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify(credentials), stderr: '' });
    return { fetchImpl, wranglerImpl };
  }
  const present = (subdomain) => [200, { success: true, result: { subdomain }, errors: [] }];
  const missing = [404, { success: false, errors: [{ code: 10007, message: 'missing' }] }];

  it('preserves an existing subdomain without any write', async () => {
    const dependencies = boundary([present('existing-address')]);
    await expect(ensureWorkersDevSubdomain({ accountId }, dependencies)).resolves.toEqual({ subdomain: 'existing-address', created: false });
    expect(dependencies.fetchImpl.mock.calls.map(([, options]) => options.method)).toEqual(['GET']);
    expect(dependencies.wranglerImpl).toHaveBeenCalledWith(['auth', 'token', '--json'], expect.objectContaining({ sensitive: true, forward: false }));
  });
  it('registers only the missing account subdomain and verifies it by reading back', async () => {
    const dependencies = boundary([missing, present('personal-aaaaaa'), present('personal-aaaaaa')]);
    await expect(ensureWorkersDevSubdomain({ accountId }, dependencies)).resolves.toEqual({ subdomain: 'personal-aaaaaa', created: true });
    expect(dependencies.fetchImpl.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT', 'GET']);
    const [url, options] = dependencies.fetchImpl.mock.calls[1];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`);
    expect(JSON.parse(options.body)).toEqual({ subdomain: 'personal-aaaaaa' });
    expect(options.redirect).toBe('error');
  });
  it('does not register on an unknown API error', async () => {
    const dependencies = boundary([[403, { success: false, errors: [{ code: 10000, message: 'not authorized' }] }]]);
    await expect(ensureWorkersDevSubdomain({ accountId }, dependencies)).rejects.toThrow('错误码 10000');
    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('does not treat mixed or malformed errors as an absent subdomain', async () => {
    const dependencies = boundary([[403, { success: false, errors: [{ code: 10007 }, { message: 'unknown failure' }] }]]);
    await expect(ensureWorkersDevSubdomain({ accountId }, dependencies)).rejects.toThrow('查询失败');
    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('refuses to change an existing address when the environment requests another', async () => {
    const dependencies = boundary([present('existing-address')]);
    await expect(ensureWorkersDevSubdomain({ accountId, requestedSubdomain: 'new-address' }, dependencies)).rejects.toThrow('已保留原地址');
    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('reports an unavailable requested name instead of trying to overwrite or rename it', async () => {
    const dependencies = boundary([missing, [409, { success: false, errors: [{ code: 10031 }] }]]);
    await expect(ensureWorkersDevSubdomain({ accountId, requestedSubdomain: 'my-dashboard' }, dependencies)).rejects.toThrow('子域不可用');
    expect(dependencies.fetchImpl.mock.calls.map(([, options]) => options.method)).toEqual(['GET', 'PUT']);
  });
  it('fails if the registered address cannot be verified', async () => {
    const dependencies = boundary([missing, present('my-dashboard'), present('different-address')]);
    await expect(ensureWorkersDevSubdomain({ accountId, requestedSubdomain: 'my-dashboard' }, dependencies)).rejects.toThrow('回读未通过');
  });
  it('supports API keys without disclosing credentials in errors or logs', async () => {
    const credentials = { type: 'api_key', key: 'test-sensitive-key', email: 'test@example.invalid' };
    const dependencies = boundary([[403, { success: false, errors: [{ code: 10000, message: `echo ${credentials.key}` }] }]], credentials);
    const spies = ['log', 'warn', 'error'].map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    try {
      const error = await ensureWorkersDevSubdomain({ accountId }, dependencies).catch((failure) => failure);
      expect(error.message).not.toContain(credentials.key);
      expect(error.message).not.toContain(credentials.email);
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
      const headers = dependencies.fetchImpl.mock.calls[0][1].headers;
      expect(headers['X-Auth-Key'] === credentials.key).toBe(true);
      expect(headers['X-Auth-Email'] === credentials.email).toBe(true);
      expect(headers.Authorization).toBeUndefined();
    } finally { spies.forEach((spy) => spy.mockRestore()); }
  });
  it('rejects malformed labels and skips disabled workers.dev without credential access', async () => {
    const dependencies = boundary([]);
    await expect(ensureWorkersDevSubdomain({ accountId, requestedSubdomain: 'invalid/path' }, dependencies)).rejects.toThrow('DASHBOARD_SUBDOMAIN');
    await expect(ensureWorkersDevSubdomain({ accountId, workersDev: false }, dependencies)).resolves.toBeNull();
    expect(dependencies.wranglerImpl).not.toHaveBeenCalled();
    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });
});
