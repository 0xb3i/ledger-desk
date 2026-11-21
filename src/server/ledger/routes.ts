import { Hono } from 'hono';
import type { Context } from 'hono';
import type { IngestResult } from '../../shared/contracts';
import { ApiError } from '../errors';
import type { ApiEnv } from '../types';
import { idempotencyKey, normalizeInput, parseCmb, parseInput, transactionInputSchema, updateSchema, versionSchema } from './domain';
import { getRefundExpense, getSummary, listTransactions } from './queries';
import { changeStatus, createTransaction, updateTransaction } from './repository';
import { getTagOverride } from './tags';

async function readJson(c: Context<ApiEnv>): Promise<unknown> {
  try { return await c.req.json(); }
  catch { throw new ApiError(400, 'INVALID_JSON', '请求正文不是有效 JSON'); }
}

export const ledgerRoutes = new Hono<ApiEnv>();
ledgerRoutes.get('/summary', async (c) => c.json({ data: await getSummary(c.env.DB, c.req.query('month')) }));
ledgerRoutes.get('/transactions', async (c) => c.json({ data: await listTransactions(c.env.DB, c.req.query()) }));
ledgerRoutes.get('/transactions/:id/refund-expense', async c => c.json({ data: await getRefundExpense(c.env.DB, c.req.param('id')) }));
ledgerRoutes.post('/transactions', async (c) => {
  const key = idempotencyKey(c.req.header('Idempotency-Key'));
  const input = normalizeInput(parseInput(transactionInputSchema, await readJson(c)));
  const result = await createTransaction(c.env.DB, input, { source: 'manual', scope: 'manual', key });
  return c.json({ data: result.transaction }, result.duplicate ? 200 : 201);
});
ledgerRoutes.patch('/transactions/:id', async (c) => {
  const body = parseInput(updateSchema, await readJson(c));
  const data = await updateTransaction(c.env.DB, c.req.param('id'), normalizeInput(body), body.version, body.reviewStatus);
  const tagOverride = await getTagOverride(c.env.DB, data.id);
  return c.json({ data: tagOverride ? { ...data, tagOverride } : data });
});
for (const operation of ['archive', 'restore', 'confirm'] as const) {
  ledgerRoutes.post(`/transactions/:id/${operation}`, async (c) => {
    const { version } = parseInput(versionSchema, await readJson(c));
    return c.json({ data: await changeStatus(c.env.DB, c.req.param('id'), version, operation) });
  });
}

export const ingestRoutes = new Hono<ApiEnv>();
ingestRoutes.post('/cmb', async (c) => {
  const key = idempotencyKey(c.req.header('Idempotency-Key'));
  const device = c.get('device');
  const parsed = parseCmb(await readJson(c), device.accountId);
  const result = await createTransaction(c.env.DB, parsed.transaction, {
    source: 'shortcut', scope: `shortcut:${device.accountId}`, key, fingerprint: parsed.fingerprint,
    needsReview: parsed.needsReview, sourceDetails: parsed.sourceDetails,
  });
  const status = result.duplicate ? 'duplicate' : result.transaction.reviewStatus === 'pending' ? 'needs_review' : 'created';
  const data: IngestResult = {
    status, transactionId: result.transaction.id,
    message: status === 'duplicate' ? '该请求已处理，无需重复记账' : status === 'needs_review' ? '已保存，请在账本中核对交易性质或疑似重复' : '已记账',
  };
  return c.json({ data }, result.duplicate ? 200 : 201);
});
