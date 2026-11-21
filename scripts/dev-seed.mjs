/* 仅供开发：通过真实接口给 dev-server（隔离数据目录）写入一批明确合成的账目，用来走查界面。
   不要指向安装版轻记。用法：先 `npm run dev:server`，再 `node scripts/dev-seed.mjs`。 */
const port = Number(process.env.QINGJI_DEV_API_PORT ?? 43928);
const origin = `http://127.0.0.1:${port}`;
// Node 的 fetch 固定发送 Sec-Fetch-Mode: cors，会被本机入口拒绝；用 node:http 模拟直接打开入口
import { get } from 'node:http';
const cookie = await new Promise((resolve, reject) => get(`${origin}/local/open`, response => {
  response.resume();
  resolve(response.headers['set-cookie']?.[0]?.split(';')[0]);
}).on('error', reject));
if (!cookie) throw new Error('无法建立开发会话，请确认 dev-server 已启动。');
const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie };
async function call(path, method = 'GET', body, extra = {}) {
  const response = await fetch(`${origin}/api${path}`, { method, headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${JSON.stringify(json)}`);
  return json.data;
}

const { accounts } = await call('/bootstrap');
const account = accounts[0].id;
let seed = 20261120;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const pick = list => list[Math.floor(rnd() * list.length)];
const amount = (a, b) => (a + rnd() * (b - a)).toFixed(2);
const at = (month, day, hour) => `${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}:00+08:00`;
async function add(occurredAt, kind, amountText, description, categoryId = null, extra = {}) {
  return call('/transactions', 'POST', { occurredAt, kind, amount: amountText, description, accountId: account, categoryId, ...(categoryId ? { categoryOverride: true } : {}), ...extra },
    { 'Idempotency-Key': `dev-seed-${occurredAt}-${description}-${amountText}`.replace(/[^A-Za-z0-9._:-]/g, '') + '-' + Math.floor(rnd() * 1e9) });
}

const today = Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', day: '2-digit' }).format(new Date()));
const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' }).format(new Date());
const [y, m] = month.split('-').map(Number);
const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;

for (const [target, lastDay] of [[prev, 30], [month, today]]) {
  for (let d = 1; d <= lastDay; d++) {
    const weekend = [0, 6].includes(new Date(`${target}-${String(d).padStart(2, '0')}T12:00:00+08:00`).getDay());
    if (!weekend) {
      if (rnd() < .6) await add(at(target, d, 8), 'expense', amount(12, 22), pick(['瑞幸咖啡', 'Manner Coffee']), 'food');
      await add(at(target, d, 12), 'expense', amount(24, 46), pick(['和府捞面', '老乡鸡', '萨莉亚', '西贝莜面村']), 'food');
      await add(at(target, d, 9), 'expense', amount(6, 8), '地铁出行', 'transport');
      if (rnd() < .2) await add(at(target, d, 21), 'expense', amount(18, 46), '滴滴出行', null);
    } else {
      await add(at(target, d, 12), 'expense', amount(58, 118), pick(['太二酸菜鱼', '外婆家', '绿茶餐厅']), 'food');
      if (rnd() < .5) await add(at(target, d, 15), 'expense', amount(48, 150), pick(['万达影城', '猫眼演出']), 'leisure');
    }
    if (d % 6 === 3) await add(at(target, d, 19), 'expense', amount(58, 128), pick(['盒马鲜生', '永辉超市']), 'shopping');
  }
  await add(at(target, 1, 10), 'expense', '3200.00', '房租', 'housing', { isFixed: true });
  await add(at(target, 5, 10), 'expense', '25.00', '哔哩哔哩大会员', 'leisure', { isFixed: true });
  await add(at(target, 10, 10), 'income', '18500.00', '工资', 'salary');
}
// 本月几笔特别的：大额购物、退款、方向待确认的转账、未分类
await add(at(month, 11, 0), 'expense', '1086.00', '天猫 双11', 'shopping', { note: '扫地机器人 + 显示器支架' });
await add(at(month, 13, 14), 'refund', '199.00', '天猫 退款', 'shopping');
await add(at(month, 14, 20), 'transfer', '500.00', '转给室友', null, { transferDirection: 'outflow' });
await add(at(month, 17, 13), 'expense', '68.00', 'POS 消费', null);

// 招行快捷指令记录：一笔"其他入账"会进入待核对
const { token } = await call('/devices', 'POST', { name: '开发种子', accountId: account });
for (const [i, item] of [
  { amount: '25.00', transaction_type: 'purchase', direction: 'outflow', description: '扫码付款', counterparty: '个人收款码', balance: '12880.50' },
  { amount: '300.00', transaction_type: 'credit', direction: 'inflow', description: '其他入账', counterparty: '某某科技', balance: '13180.50' },
].entries()) {
  await fetch(`${origin}/api/ingest/cmb`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Idempotency-Key': `dev-seed-cmb-${i}-${Date.now()}` },
    body: JSON.stringify({ ...item, transaction_time: at(month, today - 1 + i, 9 + i), transaction_fingerprint: `dev-${i}-${Date.now()}`, currency: 'CNY', bank: '招商银行', parser_version: 'dev-1' }) });
}

const { version } = await call('/budget');
await call('/budget', 'PUT', { amount: '9000', version });
await call('/category-rules', 'POST', { keyword: '瑞幸', matchType: 'contains', kind: 'expense', categoryId: 'food', enabled: true });
for (const [title, price, note] of [['Kindle Paperwhite', '1099', '通勤路上读书'], ['Sony WH-1000XM6', '2899', '旧耳机降噪坏了'], ['人体工学椅', '1599', '先去线下试坐'], ['登山杖', null, '']]) {
  await call('/wishlist', 'POST', { id: crypto.randomUUID(), title, amount: price, url: price ? 'https://example.com/item' : '', note });
}
console.log('开发数据已写入。');
