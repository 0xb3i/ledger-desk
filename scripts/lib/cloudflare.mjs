import { wrangler } from './runtime.mjs';

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Initialize the account's workers.dev address once, preserving any existing address. */
export async function ensureWorkersDevSubdomain(
  { accountId, requestedSubdomain, workersDev = true, wranglerOptions = {} },
  { fetchImpl = globalThis.fetch, wranglerImpl = wrangler } = {},
) {
  if (workersDev === false) return null;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error('无法确认 workers.dev 的目标账号。');
  if (requestedSubdomain !== undefined && (typeof requestedSubdomain !== 'string' || !dnsLabel.test(requestedSubdomain))) {
    throw new Error('DASHBOARD_SUBDOMAIN 必须是 1 至 63 位小写字母、数字或连字符，且不能以连字符开头或结尾。');
  }
  const desired = requestedSubdomain ?? `personal-${accountId.slice(0, 6).toLowerCase()}`;
  let credentials;
  try {
    const result = await wranglerImpl(['auth', 'token', '--json'], {
      ...wranglerOptions, sensitive: true, forward: false, allowFailure: true, timeout: 30_000,
    });
    if (result.code !== 0) throw new Error();
    credentials = JSON.parse(result.stdout);
  } catch {
    throw new Error('无法读取 Cloudflare 授权，请在本机终端检查 Wrangler 登录状态后重试；未输出授权内容。');
  }
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (['oauth', 'api_token'].includes(credentials?.type) && typeof credentials.token === 'string' && credentials.token) {
    headers.Authorization = `Bearer ${credentials.token}`;
  } else if (credentials?.type === 'api_key' && typeof credentials.key === 'string' && credentials.key && typeof credentials.email === 'string' && credentials.email) {
    headers['X-Auth-Key'] = credentials.key;
    headers['X-Auth-Email'] = credentials.email;
  } else {
    throw new Error('Wrangler 返回的授权格式无效，未发起 workers.dev 注册。');
  }

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;
  async function request(method, body) {
    let response, result;
    try {
      response = await fetchImpl(endpoint, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      result = await response.json();
    } catch {
      throw new Error('Cloudflare workers.dev 请求失败或响应格式异常，请检查网络后重试；未输出请求头或响应正文。');
    }
    const errors = Array.isArray(result?.errors) ? result.errors : [];
    const codes = errors.map((error) => error?.code).filter(Number.isInteger);
    if (method === 'GET' && result?.success === false && errors.length > 0 && errors.every((error) => error?.code === 10007)) return null;
    if (!response.ok || result?.success !== true) {
      if (codes.includes(10031)) throw new Error('指定的 workers.dev 子域不可用，请设置其他 DASHBOARD_SUBDOMAIN 后重试；现有地址未被覆盖。');
      throw new Error(`Cloudflare workers.dev ${method === 'GET' ? '查询' : '注册'}失败（HTTP ${response.status}${codes.length ? `，错误码 ${codes.join(',')}` : ''}），未尝试更改已有地址。`);
    }
    const subdomain = result.result?.subdomain;
    if (typeof subdomain !== 'string' || !dnsLabel.test(subdomain)) throw new Error('Cloudflare 未返回有效的 workers.dev 子域，无法确认注册结果。');
    return subdomain;
  }

  const existing = await request('GET');
  if (existing) {
    if (requestedSubdomain !== undefined && requestedSubdomain !== existing) {
      throw new Error(`账号已有 workers.dev 子域 ${existing}，与 DASHBOARD_SUBDOMAIN 不一致；已保留原地址，请移除或修正该环境变量后重试。`);
    }
    return { subdomain: existing, created: false };
  }
  const created = await request('PUT', { subdomain: desired });
  if (created !== desired) throw new Error('Cloudflare 注册结果与请求的子域不同，请核对账号设置后重试。');
  const verified = await request('GET');
  if (verified !== desired) throw new Error('workers.dev 注册后的回读未通过，请核对账号设置后重试；不会自动改写其他地址。');
  return { subdomain: verified, created: true };
}
