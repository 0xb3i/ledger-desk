import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import ts from 'typescript';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const placeholderDatabaseId = '00000000-0000-0000-0000-000000000000';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validDatabaseId(value) {
  return typeof value === 'string' && uuidPattern.test(value) && value !== placeholderDatabaseId;
}

export function parseWranglerConfig(source, filename = 'wrangler.jsonc') {
  const { config, error } = ts.parseConfigFileTextToJson(filename, source);
  if (error || !config || typeof config !== 'object') throw new Error(`${filename} 不是有效的 JSONC 配置。`);
  const bindings = config.d1_databases?.filter((item) => item.binding === 'DB') ?? [];
  if (bindings.length !== 1 || !bindings[0].database_name) throw new Error('配置必须包含唯一的 DB 绑定及 database_name。');
  if (!config.name || !/^[a-z0-9][a-z0-9-]*$/.test(config.name)) throw new Error('请为 Worker 配置有效的 name。');
  if (config.env && Object.keys(config.env).length > 0) throw new Error('部署脚本只管理顶层生产配置；命名环境请单独配置发布流程。');
  return { config, database: bindings[0] };
}

export function resolveAccountId(identity, configuredId, environmentId) {
  if (identity?.loggedIn !== true || !Array.isArray(identity.accounts)) throw new Error('无法确认 Cloudflare 登录状态。');
  if (configuredId && environmentId && configuredId !== environmentId) throw new Error('CLOUDFLARE_ACCOUNT_ID 与 wrangler.jsonc 的 account_id 不同，请先核对目标账号。');
  const selected = environmentId || configuredId;
  const accounts = identity.accounts.filter((account) => typeof account.id === 'string');
  const id = selected || (accounts.length === 1 ? accounts[0].id : undefined);
  if (!id) throw new Error('发现多个或未发现可用 Cloudflare 账号；请设置 CLOUDFLARE_ACCOUNT_ID 后重试。');
  if (!/^[a-f0-9]{32}$/i.test(id) || !accounts.some((account) => account.id === id)) throw new Error('所选 Cloudflare 账号不在当前授权账号列表中。');
  return id;
}

export function databaseIdFromCreateOutput(output) {
  const ids = [...output.matchAll(/["']?database_id["']?\s*[:=]\s*["']([0-9a-f-]{36})["']/gi)].map((match) => match[1]);
  const unique = [...new Set(ids.filter(validDatabaseId))];
  if (unique.length !== 1) throw new Error('D1 已发起创建，但无法从 Wrangler 返回值确认唯一 UUID。请查看 d1 list，勿填写猜测的 ID；重新部署会按数据库名称恢复。');
  return unique[0];
}

function property(object, name) {
  return object.properties.find((entry) => ts.isPropertyAssignment(entry) && entry.name.text === name);
}

export function bindDeploymentConfig(source, databaseId, accountId) {
  const { config, database } = parseWranglerConfig(source);
  if (!validDatabaseId(databaseId)) throw new Error('不能将无效的数据库 UUID 写入部署配置。');
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('不能将无效的账号 ID 写入部署配置。');
  if (database.database_id !== placeholderDatabaseId && database.database_id !== databaseId) throw new Error('已有数据库绑定与本次部署不同，未修改配置。');
  if (config.account_id && config.account_id !== accountId) throw new Error('已有账号配置与本次部署不同，未修改配置。');
  const ast = ts.parseJsonText('wrangler.jsonc', source);
  const root = ast.statements[0]?.expression;
  if (!root || !ts.isObjectLiteralExpression(root)) throw new Error('无法定位 Wrangler 配置对象。');
  const databases = property(root, 'd1_databases')?.initializer;
  if (!databases || !ts.isArrayLiteralExpression(databases)) throw new Error('无法定位 DB 配置。');
  const binding = databases.elements.find((item) => ts.isObjectLiteralExpression(item) && property(item, 'binding')?.initializer.text === 'DB');
  const idNode = binding && property(binding, 'database_id')?.initializer;
  if (!idNode || !ts.isStringLiteral(idNode)) throw new Error('请保留 DB 的 database_id 字段。');
  const edits = [{ start: idNode.getStart(ast), end: idNode.end, text: JSON.stringify(databaseId) }];
  if (!config.account_id) edits.push({ start: root.getStart(ast) + 1, end: root.getStart(ast) + 1, text: `\n  "account_id": ${JSON.stringify(accountId)},` });
  let result = source;
  for (const edit of edits.sort((left, right) => right.start - left.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

export async function writeIfUnchanged(path, previous, next) {
  if (previous === next) return;
  if (await readFile(path, 'utf8') !== previous) throw new Error(`${path} 已被修改，请检查当前配置后重新部署；本次没有覆盖。`);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await open(temporary, 'wx', 0o600).then(async (file) => { try { await file.writeFile(next); } finally { await file.close(); } });
    if (await readFile(path, 'utf8') !== previous) throw new Error(`${path} 在部署期间发生变化，本次没有覆盖。`);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function ensureOwnerKey(path) {
  let created = false;
  try {
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`OWNER_ACCESS_KEY=pd_owner_${randomBytes(32).toString('base64url')}\n`); } finally { await file.close(); }
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path} 必须是本机普通文件，不能使用符号链接。`);
  await chmod(path, 0o600);
  const accessKey = parseEnv(await readFile(path, 'utf8')).OWNER_ACCESS_KEY;
  if (!accessKey || !/^pd_owner_[A-Za-z0-9_-]{43}$/.test(accessKey)) throw new Error(`${path} 中的 OWNER_ACCESS_KEY 不是项目生成的 256 位访问密钥。原文件已保留，请核对后重试。`);
  return { accessKey, created };
}

export function showOwnerKey(accessKey, label) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    console.log(`${label}访问密钥（请存入密码管理器）：\n${accessKey}`);
  } else {
    console.log(`${label}访问密钥已保存在权限为 600 的本地密钥文件中；非交互运行不显示密钥。`);
  }
}

export async function run(command, args, options = {}) {
  const { cwd = projectRoot, input, forward = false, timeout = 120_000, env = {}, sensitive = false, allowFailure = false } = options;
  return await new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NO_COLOR: '1', FORCE_COLOR: '0', BROWSER: 'none', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false', ...env },
    });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (forward && !sensitive) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (forward && !sensitive) process.stderr.write(chunk); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const result = { code, stdout, stderr };
      if (timedOut) return reject(new Error(`命令 ${args[0] ?? command} 超时，已退出；请检查网络后重试。`));
      if (code !== 0 && !allowFailure) return reject(new Error(sensitive ? '密钥上传失败，未输出敏感内容；请检查账号权限及网络后重试。' : `命令失败：${args.join(' ')}\n${(stderr || stdout).trim().slice(-3500)}`));
      accept(result);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function wrangler(args, options = {}) {
  return run(process.execPath, [resolve(projectRoot, 'node_modules/wrangler/bin/wrangler.js'), ...args], options);
}

export async function acquireDeployLock() {
  const path = resolve(projectRoot, '.wrangler/dashboard-deploy.lock');
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${randomBytes(12).toString('hex')}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      try { await file.writeFile(token); } finally { await file.close(); }
      return async () => { if (await readFile(path, 'utf8').catch(() => '') === token) await unlink(path); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = await readFile(path, 'utf8');
      const pid = Number(previous.split(':')[0]);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('部署锁无效，请确认没有部署进程后移除 .wrangler/dashboard-deploy.lock。');
      try { process.kill(pid, 0); } catch (status) {
        if (status.code === 'ESRCH') { await unlink(path); continue; }
        throw status;
      }
      throw new Error('另一个部署进程仍在运行，请等待它结束。');
    }
  }
  throw new Error('无法取得部署锁，请重试。');
}
