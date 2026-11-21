import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  acquireDeployLock, bindDeploymentConfig, databaseIdFromCreateOutput, ensureOwnerKey,
  parseWranglerConfig, placeholderDatabaseId, projectRoot, resolveAccountId, run,
  showOwnerKey, validDatabaseId, wrangler, writeIfUnchanged,
} from './lib/runtime.mjs';
import { ensureWorkersDevSubdomain } from './lib/cloudflare.mjs';

let releaseLock;
try {
  releaseLock = await acquireDeployLock();
  console.log('开始发布前检查……');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const args of [['test'], ['run', 'test:shortcut'], ['run', 'check'], ['run', 'build']]) await run(npm, args, { forward: true, timeout: 300_000 });

  const identityResult = await wrangler(['whoami', '--json'], { allowFailure: true, timeout: 30_000 });
  if (identityResult.code !== 0) throw new Error('未取得 Cloudflare 授权，或授权检查失败。请先自行注册 Cloudflare 账号，在本机终端运行 npx wrangler login 完成浏览器授权，再执行 npm run deploy。本次没有创建线上资源，也没有发起交互登录。');
  const identity = JSON.parse(identityResult.stdout);
  const configPath = resolve(projectRoot, 'wrangler.jsonc');
  const original = await readFile(configPath, 'utf8');
  const { config, database } = parseWranglerConfig(original);
  const accountId = resolveAccountId(identity, config.account_id, process.env.CLOUDFLARE_ACCOUNT_ID);
  const options = { env: { CLOUDFLARE_ACCOUNT_ID: accountId } };
  const query = async (args) => JSON.parse((await wrangler(args, options)).stdout);

  // Read resource identity before mutations; a configured UUID is never silently replaced.
  let databases = await query(['d1', 'list', '--json']);
  if (!Array.isArray(databases)) throw new Error('D1 返回的数据库列表格式异常，已停止部署。');
  let databaseId = database.database_id;
  if (databaseId === placeholderDatabaseId) {
    const matches = databases.filter((item) => item.name === database.database_name);
    if (matches.length > 1) throw new Error('D1 返回多个同名数据库，无法安全确定绑定。');
    if (matches.length === 1) {
      databaseId = matches[0].uuid;
      console.log(`使用已存在的 D1 数据库 ${database.database_name}，恢复部署。`);
    } else {
      console.log(`创建 D1 数据库 ${database.database_name}……`);
      // Wrangler treats --binding as implicit permission to edit JSON config, even with --update-config=false.
      // Own the binding update below so concurrent edits stay protected.
      const created = await wrangler(['d1', 'create', database.database_name, '--update-config=false'], options);
      databaseId = databaseIdFromCreateOutput(created.stdout);
      databases = await query(['d1', 'list', '--json']);
    }
  }
  if (!validDatabaseId(databaseId) || !databases.some((item) => item.uuid === databaseId && item.name === database.database_name)) throw new Error('数据库 UUID、名称或账号不匹配；未修改现有数据库绑定。');
  await writeIfUnchanged(configPath, original, bindDeploymentConfig(original, databaseId, accountId));

  const secretsResult = await wrangler(['secret', 'list', '--format', 'json'], { ...options, allowFailure: true });
  let secrets;
  if (secretsResult.code === 0) {
    secrets = JSON.parse(secretsResult.stdout);
    if (!Array.isArray(secrets)) throw new Error('无法确认线上密钥列表，已停止部署。');
  } else if (`${secretsResult.stdout}\n${secretsResult.stderr}`.includes(`Worker "${config.name}" not found.`)) {
    secrets = [];
  } else {
    throw new Error('无法读取 Worker 密钥列表，未覆盖任何密钥。请核对 Workers 权限、Worker 名称及网络后重试。');
  }

  console.log('正在应用线上数据库迁移……');
  await wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], { ...options, forward: true });
  let uploadedKey;
  if (!secrets.some((secret) => secret.name === 'OWNER_ACCESS_KEY')) {
    const { accessKey } = await ensureOwnerKey(resolve(projectRoot, '.deploy.vars'));
    await wrangler(['secret', 'bulk'], { ...options, input: JSON.stringify({ OWNER_ACCESS_KEY: accessKey }), sensitive: true });
    const verified = await query(['secret', 'list', '--format', 'json']);
    if (!Array.isArray(verified) || !verified.some((secret) => secret.name === 'OWNER_ACCESS_KEY')) throw new Error('未确认访问密钥已保存，已停止发布。');
    uploadedKey = accessKey;
    console.log('已通过标准输入上传线上访问密钥。');
  } else {
    console.log('保留已有线上访问密钥。');
  }

  const workersDev = await ensureWorkersDevSubdomain({
    accountId, requestedSubdomain: process.env.DASHBOARD_SUBDOMAIN,
    workersDev: config.workers_dev, wranglerOptions: options,
  });
  if (workersDev) console.log(`已确认 workers.dev 子域：${workersDev.subdomain}.workers.dev。`);

  console.log('正在发布应用……');
  const deployment = await wrangler(['deploy'], { ...options, forward: true, timeout: 180_000 });
  const detectedUrl = deployment.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i)?.[0];
  const url = process.env.DASHBOARD_URL || detectedUrl;
  if (!url || new URL(url).protocol !== 'https:') throw new Error('Wrangler 已完成发布，但无法确定 HTTPS 访问地址。请在 Cloudflare 控制台确认地址，设置 DASHBOARD_URL 后重新部署并校验。');
  const { version } = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  let healthy = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(new URL('/api/health', url), { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      const result = await response.json();
      if (response.ok && result.data?.status === 'ok' && result.data?.version === version) { healthy = true; break; }
    } catch {}
    if (attempt < 3) await delay(2000);
  }
  if (!healthy) throw new Error(`应用已发起发布，但 ${url} 的数据库健康状态或版本未通过验证。请检查部署日志；不要切换日常快捷指令。`);
  console.log(`发布及数据库健康检查通过：${url}（${version}）。请完成登录与真实设备连通性验收。`);
  if (uploadedKey) showOwnerKey(uploadedKey, '线上');
} catch (error) {
  console.error(`发布未完成：${error.message}`);
  process.exitCode = 1;
} finally {
  if (releaseLock) await releaseLock();
}
