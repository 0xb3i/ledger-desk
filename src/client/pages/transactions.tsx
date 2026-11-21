import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Download, Plus, ReceiptText, X } from 'lucide-react';
import { toast } from 'sonner';
import { KIND_LABELS, type Summary, type Transaction, type TransactionKind, type TransactionPage } from '../../shared/contracts';
import { api, errorMessage, useResource } from '@/lib/api';
import { useApp, type Filters } from '@/lib/app';
import { CategoryDot, categoryColor, tagOf } from '@/lib/category';
import { centsToDecimal, dateInShanghai, money, transactionKindLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from '@/components/ui/pagination';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ItemGroup } from '@/components/ui/item';
import { PageHeader } from '@/components/page-header';
import { MonthStepper } from '@/components/month-stepper';
import { DatePicker } from '@/components/date-picker';
import { TransactionItem } from '@/components/transaction-item';
import { MiniDailyChart } from '@/components/charts';
import { EmptyState, ErrorState, PageLoading } from '@/components/states';

const PAGE_SIZE = 12;
const SORTS = [['newest', '最新在前'], ['oldest', '最早在前'], ['largest', '金额从高到低'], ['smallest', '金额从低到高']] as const;
const ALL = '__all__';

export default function Transactions() {
  const { location, navigate, revision, bootstrap, openTransaction, refresh } = useApp();
  const { month, filters } = location;
  const setFilters = (next: Filters, replace = false) => {
    const applied = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== ''));
    navigate('/transactions', applied, month, replace);
  };
  const update = (patch: Filters) => setFilters({ ...filters, ...patch, page: '1' });
  const [exporting, setExporting] = useState(false);
  const uncategorized = filters.categoryId === 'uncategorized';
  const { status, ...queryFilters } = filters;
  const reviewStatus = status === 'pending' ? 'pending' : uncategorized && filters.deleted !== 'true' ? 'confirmed' : undefined;
  const scope = { month, ...queryFilters, ...(reviewStatus ? { status: reviewStatus } : {}) };
  const query = new URLSearchParams({ ...scope, pageSize: String(PAGE_SIZE) });
  const result = useResource<TransactionPage>(`/transactions?${query}`, revision, { keepOnRefresh: true });
  const summary = useResource<Summary>(`/summary?month=${month}`, revision, { keepOnRefresh: true });
  const deleted = useResource<TransactionPage>(`/transactions?month=${month}&deleted=true&pageSize=1`, revision, { keepOnRefresh: true });
  const data = result.data;
  const page = data?.page ?? Math.max(1, Number(filters.page) || 1), total = data?.total ?? 0, pageSize = data?.pageSize ?? PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const sort = SORTS.some(([v]) => v === filters.sort) ? filters.sort : 'newest';
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const hasFilters = Boolean(filters.search || filters.kind || filters.status === 'pending' || filters.deleted === 'true' || filters.categoryId || filters.tagId || filters.date);
  const kinds: TransactionKind[] = ['expense', 'income'];
  for (const kind of ['refund', 'transfer'] as const) if (filters.kind === kind || summary.data?.[`${kind}Cents`] || data?.items.some(i => i.kind === kind)) kinds.push(kind);
  // 按所选收支类型过滤可选类目，避免“收入 + 餐饮”这类无意义组合
  const categoryMatchesKind = (catKind: string, txKind?: string) =>
    !txKind || txKind === 'transfer' || catKind === 'both' || (txKind === 'income' ? catKind === 'income' : catKind === 'expense');
  const availableCategories = bootstrap.categories.filter(c => categoryMatchesKind(c.kind, filters.kind));
  const categoryTags = filters.categoryId ? (bootstrap.tags ?? []).filter(t => t.categoryId === filters.categoryId) : [];
  const stateFilter = filters.deleted === 'true' ? 'deleted' : filters.status === 'pending' ? 'pending' : ALL;
  const pickKind = (v: string) => {
    const nextKind = v === ALL ? '' : v;
    const currentCat = filters.categoryId && !uncategorized ? bootstrap.categories.find(c => c.id === filters.categoryId) : null;
    const keepCat = !currentCat || categoryMatchesKind(currentCat.kind, nextKind);
    update({ kind: nextKind, ...(keepCat ? {} : { categoryId: '', tagId: '' }) });
  };
  const pickState = (v: string) => {
    if (v === 'pending') update({ status: 'pending', deleted: '' });
    else if (v === 'deleted') update({ status: '', deleted: 'true' });
    else update({ status: '', deleted: '' });
  };

  // 删除导致当前页为空时，回到最后一页
  useEffect(() => {
    if (data && !result.refreshing && data.page > pages) setFilters({ ...filters, page: String(pages) }, true);
  }, [data, result.refreshing, pages]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (filters.status === 'confirmed') setFilters({ ...filters, status: '' }, true);
  }, [filters.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportCsv() {
    if (exporting || !total) return;
    setExporting(true);
    try {
      const rows: Transaction[] = [], ids = new Set<string>();
      let expected: number | undefined;
      for (let p = 1; ; p++) {
        const response = await api<TransactionPage>(`/transactions?${new URLSearchParams({ ...scope, page: String(p), pageSize: '30' })}`);
        expected ??= response.total;
        if (response.total !== expected || response.items.some(i => ids.has(i.id))) throw new Error('导出期间账单发生变化，请重试。');
        for (const item of response.items) { ids.add(item.id); rows.push(item); }
        if (rows.length >= expected) break;
        if (!response.items.length) throw new Error('账单读取不完整，请重试。');
      }
      const cell = (v: string) => `"${(/^[\s]*[=+@-]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
      const csv = [['日期', '名称', '类型', '分类', '标签', '金额（元）', '备注'], ...rows.map(i => [
        dateInShanghai(i.occurredAt), i.description, transactionKindLabel(i),
        bootstrap.categories.find(c => c.id === i.categoryId)?.name ?? '未分类', tagOf(bootstrap, i)?.name ?? '', centsToDecimal(i.amountCents), i.note,
      ])].map(r => r.map(cell).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a'); a.href = url; a.download = `轻记-账单-${month}.csv`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(`已导出 ${rows.length} 笔账单`);
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setExporting(false); }
  }

  // 按日期分组（仅按时间排序时）
  const groupByDate = sort === 'newest' || sort === 'oldest';
  const groups: { date: string; items: Transaction[] }[] = [];
  for (const item of data?.items ?? []) {
    const date = dateInShanghai(item.occurredAt), last = groups.at(-1);
    if (groupByDate && last?.date === date) last.items.push(item); else groups.push({ date, items: [item] });
  }

  return <>
    <PageHeader title="收支明细" desc={data ? `${Number(month.slice(5))} 月共 ${total} 笔${filters.search ? `，搜索“${filters.search}”` : ''}` : '正在读取'}>
      <Button variant="outline" disabled={exporting || !total} onClick={exportCsv}>{exporting ? <Spinner /> : <Download />}导出账单</Button>
      <MonthStepper value={month} onChange={value => navigate('/transactions', {}, value)} />
      <Button onClick={() => openTransaction(null)}><Plus />记一笔</Button>
    </PageHeader>
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <Tabs value={filters.kind ?? ALL} onValueChange={pickKind}>
          <TabsList className="h-8">
            <TabsTrigger value={ALL} className="px-3 text-xs">全部</TabsTrigger>
            {kinds.map(k => <TabsTrigger key={k} value={k} className="px-3 text-xs">{k === 'transfer' ? '转账' : KIND_LABELS[k]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <Select value={filters.categoryId || ALL} onValueChange={v => update({ categoryId: v === ALL ? '' : v, tagId: '' })}>
          <SelectTrigger size="sm" className={cn('min-w-28', filters.categoryId && 'border-foreground/25 bg-accent/50')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部分类</SelectItem>
            <SelectItem value="uncategorized">
              <span className="flex w-full items-center gap-2">
                <span>未分类</span>
                {summary.data?.uncategorizedCount ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{summary.data.uncategorizedCount}</span> : null}
              </span>
            </SelectItem>
            {availableCategories.length > 0 && <SelectSeparator />}
            {availableCategories.map(c => (
              <SelectItem key={c.id} value={c.id}>
                <span className="flex items-center gap-2"><CategoryDot color={c.color} className="size-1.5" />{c.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {categoryTags.length > 0 && (
          <Select value={filters.tagId || ALL} onValueChange={v => update({ tagId: v === ALL ? '' : v })}>
            <SelectTrigger size="sm" className={cn('min-w-24', filters.tagId && 'border-foreground/25 bg-accent/50')}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全部标签</SelectItem>
              {[...categoryTags].sort((a, b) => a.position - b.position).map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              <SelectSeparator />
              <SelectItem value="none">其他（未细分）</SelectItem>
            </SelectContent>
          </Select>
        )}
        <DatePicker className="w-auto min-w-32 [&>button:first-child]:h-8" value={filters.date ?? ''} onChange={date => update({ date })} placeholder="全部日期" min={`${month}-01`} max={`${month}-${lastDay}`} clearable />
        <Select value={stateFilter} onValueChange={pickState}>
          <SelectTrigger size="sm" className={cn('min-w-26', stateFilter !== ALL && 'border-foreground/25 bg-accent/50')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部状态</SelectItem>
            <SelectItem value="pending">
              <span className="flex w-full items-center gap-2">
                <span>待核对</span>
                {summary.data?.pendingCount ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{summary.data.pendingCount}</span> : null}
              </span>
            </SelectItem>
            <SelectItem value="deleted">
              <span className="flex w-full items-center gap-2">
                <span>已删除</span>
                {deleted.data?.total ? <span className="ml-auto text-xs text-muted-foreground tabular-nums">{deleted.data.total}</span> : null}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 px-2.5 text-muted-foreground hover:text-foreground" onClick={() => setFilters({})}>
            重置
          </Button>
        )}
        <Select value={sort} onValueChange={v => update({ sort: v })}>
          <SelectTrigger size="sm" className="ml-auto w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{SORTS.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      {filters.search && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          搜索“{filters.search}”的结果
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => update({ search: '' })}><X />清除搜索</Button>
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
        <Card className="gap-0 overflow-hidden py-0" aria-busy={result.loading || result.refreshing}>
          {result.loading && !data ? <PageLoading label="正在读取账单" /> : result.error ? <div className="p-4"><ErrorState message={result.error} retry={refresh} /></div>
            : data?.items.length ? groups.map(group => {
              const day = data.daily.find(d => d.date === group.date);
              return (
                <section key={group.date + group.items[0].id}>
                  {groupByDate && <div className="flex border-b bg-[#fafafb] px-4 py-2.5 text-xs text-muted-foreground lg:px-6">
                    <span>{Number(group.date.slice(5, 7))} 月 {Number(group.date.slice(8))} 日</span>
                    {day && <span className="ml-auto tabular-nums">{[day.expenseCents && `支出 ¥${money(day.expenseCents)}`, day.incomeCents && `收入 ¥${money(day.incomeCents)}`].filter(Boolean).join('　')}</span>}
                  </div>}
                  <ItemGroup className="[&>*]:border-b [&>*]:border-b-border">{group.items.map(t => <TransactionItem key={t.id} item={t} bootstrap={bootstrap} onOpen={openTransaction} showDate={!groupByDate} />)}</ItemGroup>
                </section>
              );
            }) : <EmptyState icon={ReceiptText} title={hasFilters ? '没有符合条件的账单' : '本月还没有账单'}>
              <Button variant={hasFilters ? 'outline' : 'default'} size="sm" onClick={() => hasFilters ? setFilters({}) : openTransaction(null)}>{hasFilters ? '清除筛选' : <><Plus />记一笔</>}</Button>
            </EmptyState>}
          {data && total > 0 && <div className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground lg:px-6">
            <span className="tabular-nums">{(page - 1) * pageSize + 1}—{Math.min(page * pageSize, total)}，共 {total} 笔</span>
            {pages > 1 && <Pagination className="mx-0 ml-auto w-auto">
              <PaginationContent>
                <PaginationItem><PaginationPrevious href="#" text="上一页" aria-disabled={page <= 1} className={cn(page <= 1 && 'pointer-events-none opacity-50')} onClick={e => { e.preventDefault(); setFilters({ ...filters, page: String(page - 1) }); }} /></PaginationItem>
                <PaginationItem><span className="px-2 tabular-nums">{page} / {pages}</span></PaginationItem>
                <PaginationItem><PaginationNext href="#" text="下一页" aria-disabled={page >= pages} className={cn(page >= pages && 'pointer-events-none opacity-50')} onClick={e => { e.preventDefault(); setFilters({ ...filters, page: String(page + 1) }); }} /></PaginationItem>
              </PaginationContent>
            </Pagination>}
          </div>}
        </Card>
        </div>

        <div className="sticky top-16 flex flex-col gap-4">
        {data && <ReceiptCard summary={data.summary} month={month} date={filters.date} active={hasFilters} />}
        {summary.data && <Card className="gap-3">
          <CardHeader>
            <CardTitle>每日支出</CardTitle>
            <CardAction>{filters.date ? <Button variant="ghost" size="sm" className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => update({ date: '' })}>清除 {Number(filters.date.slice(8))} 日<X /></Button>
              : <span className="text-xs text-muted-foreground">点柱子按天筛选</span>}</CardAction>
          </CardHeader>
          <CardContent><MiniDailyChart days={summary.data.daily} selected={filters.date ?? ''} onPick={date => update({ date: filters.date === date ? '' : date })} /></CardContent>
        </Card>}
        {data?.breakdown && data.breakdown.length > 0 && (
          <BreakdownCard items={data.breakdown} scoped={Boolean(filters.categoryId)}
            onPick={item => update(item.categoryId === 'transfer' ? { kind: 'transfer', categoryId: '', tagId: '' }
              : !filters.categoryId ? { categoryId: item.categoryId ?? 'uncategorized', tagId: '' }
              : { categoryId: item.categoryId ?? 'uncategorized', tagId: item.tagId ?? ((bootstrap.tags ?? []).some(t => t.categoryId === item.categoryId) ? 'none' : '') })} />
        )}
        </div>
      </div>
    </div>
  </>;
}

/* 支出构成：未选分类时按一级分类画环形图，点一块即筛选到该分类；选了分类后细分为它下面的二级分类，
   子分类用该分类颜色的深浅区分。悬停时圆心显示该项，超过 7 项时其余合并为一块，图例可展开。 */
type BreakdownItem = NonNullable<TransactionPage['breakdown']>[number];
const SHADES = [100, 72, 52, 38, 28, 21];
function BreakdownCard({ items: raw, scoped, onPick }: { items: BreakdownItem[]; scoped: boolean; onPick: (item: BreakdownItem) => void }) {
  const { bootstrap } = useApp();
  // 未选分类：把二级细分合并回一级分类
  const items = scoped ? raw : [...raw.reduce((map, item) => {
    const merged = map.get(item.categoryId) ?? { ...item, tagId: null, tagName: null, amountCents: 0, count: 0 };
    merged.amountCents += item.amountCents; merged.count += item.count;
    return map.set(item.categoryId, merged);
  }, new Map<string | null, BreakdownItem>()).values()].sort((a, b) => b.amountCents - a.amountCents);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const total = items.reduce((a, i) => a + i.amountCents, 0) || 1;
  const hasTags = (categoryId: string | null) => (bootstrap.tags ?? []).some(t => t.categoryId === categoryId);
  const base = (item: BreakdownItem) => {
    const category = bootstrap.categories.find(c => c.id === item.categoryId);
    return category ? categoryColor(category.color).foreground : item.categoryId === 'transfer' ? categoryColor('sage').foreground : 'var(--muted-foreground)';
  };
  // 同分类内按金额先后取深浅，保证同色系的块彼此可分
  const seen = new Map<string | null, number>();
  const rows = items.map(item => {
    const index = seen.get(item.categoryId) ?? 0; seen.set(item.categoryId, index + 1);
    const color = `color-mix(in srgb, ${base(item)} ${item.categoryId === null ? 35 : scoped ? SHADES[Math.min(index, SHADES.length - 1)] : 100}%, var(--card))`;
    const label = scoped ? item.tagName ?? (hasTags(item.categoryId) ? '未细分' : item.categoryName) : item.categoryName;
    return { item, key: `${item.categoryId}:${item.tagId}`, color, label };
  });
  const LIMIT = 7;
  const head = rows.length > LIMIT ? rows.slice(0, LIMIT - 1) : rows, tail = rows.length > LIMIT ? rows.slice(LIMIT - 1) : [];
  const restCents = tail.reduce((a, r) => a + r.item.amountCents, 0);
  const slices = [...head.map(r => ({ key: r.key, cents: r.item.amountCents, color: r.color, pick: () => onPick(r.item) })),
    ...(tail.length ? [{ key: 'rest', cents: restCents, color: 'color-mix(in srgb, var(--muted-foreground) 22%, var(--card))', pick: () => setExpanded(true) }] : [])];
  const R = 52, C = 2 * Math.PI * R, GAP = slices.length > 1 ? 2 : 0;
  let offset = 0;
  const focus = hover === 'rest' ? { label: `其余 ${tail.length} 项`, cents: restCents } : (() => { const r = rows.find(x => x.key === hover); return r ? { label: r.label, cents: r.item.amountCents } : null; })();
  const legend = expanded ? rows : head;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle>支出构成</CardTitle>
        <CardAction><span className="text-xs text-muted-foreground">{scoped ? '点扇区筛选' : '点分类看细分'}</span></CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="relative mx-auto size-36">
          <svg viewBox="0 0 128 128" className="size-full -rotate-90" role="img" aria-label="支出构成环形图">
            {slices.map(slice => {
              const length = slice.cents / total * C, dash = Math.max(0.5, length - GAP);
              const el = <circle key={slice.key} cx="64" cy="64" r={R} fill="none" strokeWidth={hover === slice.key ? 18 : 15} stroke={slice.color}
                strokeDasharray={`${dash} ${C - dash}`} strokeDashoffset={-offset} className="cursor-pointer transition-[stroke-width,opacity]"
                opacity={hover && hover !== slice.key ? 0.45 : 1} onMouseEnter={() => setHover(slice.key)} onMouseLeave={() => setHover(null)} onClick={slice.pick} />;
              offset += length;
              return el;
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
            <span className="max-w-24 truncate text-xs text-muted-foreground">{focus ? focus.label : '实际支出'}</span>
            <span className="text-base tabular-nums">¥{money(focus ? focus.cents : total).replace(/\.\d+$/, '')}</span>
            {focus && <span className="text-xs text-muted-foreground tabular-nums">{Math.round(focus.cents / total * 100)}%</span>}
          </div>
        </div>
        <div className="grid">
          {legend.map(r => (
            <button key={r.key} type="button" onClick={() => onPick(r.item)} onMouseEnter={() => setHover(rows.indexOf(r) >= head.length ? 'rest' : r.key)} onMouseLeave={() => setHover(null)}
              className={cn('-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60', hover === r.key && 'bg-accent/60')}>
              <span className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="min-w-0 truncate">{r.label}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{Math.round(r.item.amountCents / total * 100)}%</span>
              <span className="w-20 shrink-0 text-right tabular-nums">¥{money(r.item.amountCents)}</span>
            </button>
          ))}
          {tail.length > 0 && !expanded && (
            <button type="button" aria-expanded={false} onClick={() => setExpanded(true)} onMouseEnter={() => setHover('rest')} onMouseLeave={() => setHover(null)}
              className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground">
              <span className="size-2 shrink-0 rounded-full" style={{ background: 'color-mix(in srgb, var(--muted-foreground) 22%, var(--card))' }} />
              其余 {tail.length} 项
              <span className="ml-auto text-xs tabular-nums">{Math.round(restCents / total * 100)}%</span>
              <span className="w-20 text-right tabular-nums text-foreground">¥{money(restCents)}</span>
            </button>
          )}
          {expanded && tail.length > 0 && (
            <Button type="button" variant="ghost" size="xs" aria-expanded={true} className="mt-1 -ml-2 justify-self-start gap-1.5 text-sm text-muted-foreground has-[>svg]:pr-2 has-[>svg]:pl-1.5"
              onClick={() => { setExpanded(false); setHover(null); }}>
              <ChevronUp aria-hidden />收起
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* 汇总：单一类型显示合计，混合类型显示收支结余；退款抵扣可展开 */
function ReceiptCard({ summary: s, month, date, active }: { summary: TransactionPage['summary']; month: string; date?: string; active: boolean }) {
  const flows = [
    { kind: 'income', label: '收入', amount: s.incomeCents, count: s.incomeCount },
    { kind: 'expense', label: s.matchedRefundCents > 0 ? '实际支出' : '支出', amount: s.expenseCents, count: s.expenseCount, present: s.grossExpenseCents > 0 },
    { kind: 'refund', label: '退款到账', amount: s.refundCents, count: s.refundCount },
    { kind: 'transfer', label: '方向待确认', amount: s.unknownTransferCents, count: s.unknownTransferCount },
  ].filter(line => line.present ?? line.count > 0);
  if (!flows.length) return null;
  const single = flows.length === 1, value = single ? flows[0].amount : s.netIncomeCents;
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const period = date ? date.replaceAll('-', '/') : `${month.replace('-', '/')}/01 — ${month.slice(5)}/${lastDay}`;
  const sign = (cents: number) => `${cents < 0 ? '−' : ''}¥${money(Math.abs(cents))}`;
  const Breakdown = ({ title, rows, nested }: { title: string; rows: [string, number][]; nested?: boolean }) => (
    <Collapsible className={nested ? 'mt-1.5 border-l border-border pl-2.5' : 'mt-1.5'}>
      <CollapsibleTrigger className="group inline-flex items-center gap-1 text-xs text-muted-foreground/85 transition-colors hover:text-foreground">{title}<ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" /></CollapsibleTrigger>
      <CollapsibleContent><dl className="mt-1.5 grid gap-1 text-xs">{rows.map(([a, v]) => <div key={a} className="flex items-baseline justify-between gap-3"><dt className="text-muted-foreground">{a}</dt><dd className="text-foreground/70 tabular-nums">{sign(v)}</dd></div>)}</dl></CollapsibleContent>
    </Collapsible>
  );
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle>{active ? '筛选汇总' : `${Number(month.slice(5))} 月汇总`}</CardTitle>
        <CardDescription className="tabular-nums">{period}</CardDescription>
      </CardHeader>
      {!single && <CardContent className="grid gap-2.5 text-sm">
        {flows.filter(f => f.kind !== 'refund').map(f => <div key={f.kind}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">{f.label}<span className="ml-1.5 text-xs text-muted-foreground/80">{f.count} 笔</span></span>
            <span className="shrink-0 text-foreground/75 tabular-nums">{sign(f.amount)}</span>
          </div>
          {f.kind === 'expense' && s.matchedRefundCents > 0 && <Breakdown nested title="退款抵扣明细" rows={[['原支出', s.grossExpenseCents], ['退款抵扣', -s.matchedRefundCents]]} />}
        </div>)}
      </CardContent>}
      <CardFooter className="flex-col items-stretch gap-1 border-t">
        <span className="text-xs text-muted-foreground">{single ? `${flows[0].label}合计` : '收支结余'}</span>
        <span className="text-2xl font-normal text-foreground/85 tabular-nums">{sign(value)}</span>
        {single && flows[0].count > 0 && <span className="text-xs text-muted-foreground">{flows[0].count} 笔{flows[0].label}</span>}
        {single && flows[0].kind === 'expense' && s.matchedRefundCents > 0 && <Breakdown title="退款抵扣明细" rows={[['原支出', s.grossExpenseCents], ['退款抵扣', -s.matchedRefundCents]]} />}
        {!single && (s.refundCents > 0 || s.matchedRefundCents > 0) && <Breakdown title="结余明细" rows={[
          ...(s.incomeCents > 0 ? [['收入', s.incomeCents] as [string, number]] : []),
          ...(s.grossExpenseCents > 0 ? [['原支出', -s.grossExpenseCents] as [string, number]] : []),
          ...(s.refundCents > 0 ? [['退款到账', s.refundCents] as [string, number]] : []),
        ]} />}
        {!single && s.unknownTransferCount > 0 && <Badge variant="outline" className="mt-1 self-start border-brand/40 text-brand">结余未含方向待确认的转账</Badge>}
      </CardFooter>
    </Card>
  );
}
