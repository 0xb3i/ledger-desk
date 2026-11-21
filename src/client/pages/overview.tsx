import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { CalendarDays, ChevronRight, Pencil, Plus, ReceiptText, Settings2, TrendingDown, TrendingUp, X } from 'lucide-react';
import type { MonthlyBudget, Summary, Transaction, TransactionPage } from '../../shared/contracts';
import { api, errorMessage, RequestError, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { centsToDecimal, currentMonth, dateInShanghai, dateLabel, money } from '@/lib/format';
import { CategoryTile, TagTile, categoryColor } from '@/lib/category';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Spinner } from '@/components/ui/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ItemGroup } from '@/components/ui/item';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MonthStepper } from '@/components/month-stepper';
import { TransactionItem } from '@/components/transaction-item';
import { DailyChart, CumulativeChart } from '@/components/charts';
import { EmptyState, ErrorState, PageLoading } from '@/components/states';

const hour = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
const greeting = () => { const h = hour(); return h < 6 ? '夜深了' : h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'; };
const WEEK = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const yuan = (cents: number) => `¥${money(cents)}`;
const whole = (cents: number) => `¥${money(cents).replace(/\.00$/, '')}`;

function Amount({ cents, signed, primary }: { cents: number; signed?: boolean; primary?: boolean }) {
  const neg = signed && cents < 0;
  const [intPart, decPart] = money(Math.abs(cents)).split('.');
  return (
    <span className={cn('tracking-tight tabular-nums', primary ? 'text-4xl font-medium text-foreground' : 'text-3xl font-medium', neg && 'text-brand')}>
      {neg && '−'}
      <span className={cn('mr-0.5 font-normal text-muted-foreground', primary ? 'text-xl' : 'text-lg')}>¥</span>
      {intPart}
      <span className={cn('font-normal text-muted-foreground', primary ? 'text-xl' : 'text-lg')}>.{decPart}</span>
    </span>
  );
}

export default function Overview() {
  const { location, navigate, revision, bootstrap, openTransaction } = useApp();
  const month = location.month, now = currentMonth(), isCurrent = month === now;
  const summary = useResource<Summary>(`/summary?month=${month}`, revision, { keepOnRefresh: true });
  const budgetRes = useResource<MonthlyBudget>('/budget', revision, { keepOnRefresh: true });
  const [mode, setMode] = useState('day');
  const [recentKind, setRecentKind] = useState('all');
  const recentQuery = new URLSearchParams({ month, page: '1', pageSize: '4', ...(recentKind !== 'all' ? { kind: recentKind } : {}) });
  const recent = useResource<TransactionPage>(`/transactions?${recentQuery}`, revision, { keepOnRefresh: true });
  const go = (filters: Record<string, string>) => navigate('/transactions', filters, month);

  const today = dateInShanghai(new Date());
  const header = (
    <div className="flex flex-wrap items-end gap-4 pt-1">
      <div className="grid gap-1">
        <h1 className="text-3xl font-medium tracking-tight text-foreground">
          {isCurrent ? greeting() : `${Number(month.slice(0, 4))} 年 ${Number(month.slice(5))} 月收支`}
        </h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {isCurrent
            ? `${Number(today.slice(5, 7))} 月 ${Number(today.slice(8))} 日 ${WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()]}，本月还剩 ${daysLeft(month)} 天`
            : month < now ? '已结束的月份' : '还未开始的月份'}
          {summary.data && `，已记 ${summary.data.count + summary.data.pendingCount} 笔`}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <MonthStepper value={month} onChange={value => navigate('/overview', {}, value)} />
        <Button onClick={() => openTransaction(null)}><Plus />记一笔</Button>
      </div>
    </div>
  );
  if (!summary.data || summary.data.month !== month) return <>{header}{summary.error ? <ErrorState message={summary.error} /> : <PageLoading label="正在读取账本" />}</>;
  const s = summary.data;
  const budget = budgetRes.data?.amountCents ?? 0;
  const remain = budget - s.expenseCents;
  const left = isCurrent ? Math.max(1, daysLeft(month)) : month > now ? s.daily.length : 0;
  const perDay = budget && left ? Math.max(0, Math.round(remain / left)) : null;
  const prev = s.previous, diff = prev.currentExpenseCents - prev.expenseCents;
  const prevLabel = prev.period === 'same-period' ? '上月同期' : '上月';
  const elapsed = isCurrent ? (s.daily.length - daysLeft(month) + 1) / s.daily.length : month < now ? 1 : 0;
  const budgetRatio = budget ? s.expenseCents / budget : 0;
  const overPace = budget > 0 && (budgetRatio > 1 || (elapsed > 0 && elapsed < 1 && budgetRatio > elapsed));
  // 指标卡小字只回答「和什么比、是好是坏」，不重复页面别处已有的信息（每天可花在图表虚线上，已用比例在底栏）
  const compare = (delta: number, more: string, less: string) => Math.abs(delta) < 100 ? `与${prevLabel}持平` : `比${prevLabel}${delta > 0 ? more : less} ${yuan(Math.abs(delta))}`;
  const paceDelta = Math.round(s.expenseCents - budget * elapsed);
  const budgetFoot = remain < 0 ? `已超出预算 ${yuan(-remain)}`
    : elapsed > 0 && elapsed < 1 ? (Math.abs(paceDelta) < 100 ? '花费与时间进度持平' : `比时间进度${paceDelta > 0 ? '多花' : '少花'} ${yuan(Math.abs(paceDelta))}`)
    : month < now ? `预算内结束，余下 ${whole(remain)}` : `预算 ${whole(budget)}`;
  const incomeCount = s.incomeCategories.reduce((a, c) => a + c.count, 0);
  const incomeFoot = !s.incomeCents ? '本月还没有收入'
    : prev.comparable && prev.currentIncomeCents !== undefined ? (prev.incomeCents ? compare(prev.currentIncomeCents - prev.incomeCents, '多', '少') : `${prevLabel}没有收入`)
    : `共 ${incomeCount} 笔`;
  const netFoot = prev.comparable && prev.currentNetIncomeCents !== undefined && prev.netIncomeCents !== undefined
    ? compare(prev.currentNetIncomeCents - prev.netIncomeCents, '多结余', '少结余') : '收入减去实际支出';

  return <>
    {header}

    <Card className="pb-0">
      <CardHeader>
        <CardTitle>{isCurrent ? '本月' : `${Number(month.slice(5))} 月`}收支</CardTitle>
        <CardDescription className="tabular-nums">
          {bootstrap.bankBalance ? (
            <>招行余额 <span className="text-foreground">{yuan(bootstrap.bankBalance.amountCents)}</span>（截至 {dateLabel(bootstrap.bankBalance.asOf, true)}）</>
          ) : '尚未读取到招行邮件余额'}
          {s.dailyAverageExpenseCents !== null && <>，日均支出 {yuan(s.dailyAverageExpenseCents)}</>}
        </CardDescription>
        <CardAction>
          <Tabs value={mode} onValueChange={setMode}>
            <TabsList className="h-8">
              <TabsTrigger value="day" className="px-3 text-xs">每日</TabsTrigger>
              <TabsTrigger value="cum" className="px-3 text-xs">累计</TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-[1.3fr_1fr_1fr_1fr]">
        <Metric label={<MetricLink label="支出" facts={[
          ...(s.matchedRefundCents > 0 ? [['原支出', yuan(s.grossExpenseCents)], ['退款抵扣', `−${yuan(s.matchedRefundCents)}`]] as [string, string][] : []),
          ['支出笔数', `${s.categories.reduce((a, c) => a + c.count, 0)} 笔`],
          ...(s.dailyAverageExpenseCents !== null ? [['日均支出', yuan(s.dailyAverageExpenseCents)] as [string, string]] : []),
        ]} onView={() => go({ kind: 'expense' })} viewLabel="查看支出账单" />}
          value={<Amount cents={s.expenseCents} primary />}
          foot={prev.comparable ? <><Badge variant="secondary" className={cn('gap-1 border-transparent font-normal text-foreground', diff > 0 ? 'bg-brand-soft' : 'bg-success/10')}>{diff > 0 ? <TrendingUp className="text-brand" /> : <TrendingDown className="text-success" />}{prev.expenseCents ? `${Math.abs(diff / prev.expenseCents * 100).toFixed(1)}%` : '—'}</Badge>{diff === 0 ? `与${prevLabel}持平` : `比${prevLabel}${diff > 0 ? '多' : '少'} ${yuan(Math.abs(diff))}`}</> : '上月记录不足，暂不比较'} />
        <Metric label={budget ? '剩余预算' : '月度预算'}
          value={budget ? <Amount cents={remain} signed /> : <span className="text-2xl font-normal text-muted-foreground">未设置</span>}
          foot={budget ? budgetFoot
            : budgetRes.data && <BudgetEditor budget={budgetRes.data} trigger={<Button variant="link" className="h-auto p-0 text-xs has-[>svg]:px-0">设置月度预算<ChevronRight /></Button>} />} />
        <Metric label={<MetricLink label="收入" facts={[['收入笔数', `${s.incomeCategories.reduce((a, c) => a + c.count, 0)} 笔`], ...s.incomeCategories.map(c => [c.name, yuan(c.amountCents)] as [string, string])]}
          onView={() => go({ kind: 'income' })} viewLabel="查看收入账单" disabled={!s.incomeCents} />}
          value={<Amount cents={s.incomeCents} />} foot={incomeFoot} />
        <Metric label={<MetricLink label="结余" facts={[
          ...(s.incomeCents ? [['结余率', `${(s.netIncomeCents / s.incomeCents * 100).toFixed(1)}%`] as [string, string]] : []),
          ['收入到账', yuan(s.incomeCents)], ['原始支出', `−${yuan(s.grossExpenseCents)}`],
          ...(s.refundCents ? [['退款到账', `+${yuan(s.refundCents)}`] as [string, string]] : []),
        ]} onView={() => go({})} viewLabel="查看全部账单" disabled={!s.expenseCents && !s.incomeCents && !s.refundCents} />}
          value={<Amount cents={s.netIncomeCents} signed />}
          foot={s.unknownTransferCount ? `另有 ${s.unknownTransferCount} 笔转账方向待确认` : netFoot} />
      </CardContent>
      <CardContent>
        <div className="mb-1 flex items-center text-sm text-muted-foreground">
          {mode === 'day' ? (s.fixedExpenses.length ? '每日日常支出，不含固定支出' : '每日支出') : '累计支出，对照预算节奏'}
        </div>
        {mode === 'day' ? <DailyChart days={s.daily} perDayCents={budget && remain > 0 ? perDay : null} onPick={date => go({ date })} />
          : <CumulativeChart days={s.daily} budgetCents={budget} />}
      </CardContent>
      <CardFooter className="border-t !py-3 text-sm">
        {budget ? <>
          <span className="text-muted-foreground">已用预算</span>
          <div className="relative mx-3 flex w-56 items-center">
            <Progress value={Math.min(100, budgetRatio * 100)} className={cn('w-full', overPace && '[&>[data-slot=progress-indicator]]:bg-brand-muted')} />
            {elapsed > 0 && elapsed < 1 && (
              <span
                title={`本月时间已过 ${(elapsed * 100).toFixed(1)}%`}
                className="pointer-events-none absolute top-1/2 h-3.5 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/65 ring-1 ring-card"
                style={{ left: `${elapsed * 100}%` }}
              />
            )}
          </div>
          <span className={cn('tabular-nums', overPace && 'font-medium text-foreground')}>{(budgetRatio * 100).toFixed(1)}%</span>
          {elapsed > 0 && elapsed < 1 && <span className="ml-3 text-xs text-foreground/65 tabular-nums">时间过去 {(elapsed * 100).toFixed(1)}%</span>}
          {budgetRes.data && <BudgetEditor budget={budgetRes.data} trigger={<Button variant="ghost" size="sm" className="ml-auto h-7 text-muted-foreground">月度预算 <span className="text-foreground tabular-nums">{whole(budget)}</span><Pencil /></Button>} />}
        </> : <>
          <span className="text-muted-foreground">还没有设置月度预算，设置后可以看到剩余额度和每天可花。</span>
          {budgetRes.data && <BudgetEditor budget={budgetRes.data} trigger={<Button variant="outline" size="sm" className="ml-auto h-7">设置月度预算</Button>} />}
        </>}
      </CardFooter>
    </Card>

    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <CategorySpendCard summary={s} onPick={(categoryId, tagId) => go(categoryId === 'transfer' ? { kind: 'transfer' } : { categoryId, ...(tagId ? { tagId } : {}) })} onOpen={openTransaction} />
      <Card className="flex flex-col gap-0 overflow-hidden py-0">
        <CardHeader className="border-b py-4 [.border-b]:pb-4">
          <CardTitle>最近账单</CardTitle>
          <CardAction>
            <Tabs value={recentKind} onValueChange={setRecentKind}>
              <TabsList className="h-8 w-36"><TabsTrigger value="all" className="min-w-0 px-0 text-xs">全部</TabsTrigger><TabsTrigger value="expense" className="min-w-0 px-0 text-xs">支出</TabsTrigger><TabsTrigger value="income" className="min-w-0 px-0 text-xs">收入</TabsTrigger></TabsList>
            </Tabs>
          </CardAction>
        </CardHeader>
        {(s.pendingCount > 0 || s.uncategorizedCount > 0) && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-[#fafafb] px-4 py-2 text-xs">
            {s.pendingCount > 0 && <button type="button" onClick={() => go({ status: 'pending' })} className="inline-flex items-center gap-0.5 font-medium text-brand hover:underline">{s.pendingCount} 笔待核对<ChevronRight className="size-3.5" /></button>}
            {s.pendingCount > 0 && s.uncategorizedCount > 0 && <span className="text-border">·</span>}
            {s.uncategorizedCount > 0 && <button type="button" onClick={() => go({ categoryId: 'uncategorized' })} className="inline-flex items-center gap-0.5 text-foreground/80 hover:text-foreground hover:underline">{s.uncategorizedCount} 笔未分类<ChevronRight className="size-3.5" /></button>}
          </div>
        )}
        <div className="min-h-72">
          {recent.data?.items.length ? <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
            {recent.data.items.map(t => <TransactionItem key={t.id} item={t} bootstrap={bootstrap} onOpen={openTransaction} showDate compact />)}
          </ItemGroup> : recent.loading ? <PageLoading label="正在读取最近账单" /> : recent.error ? <div className="p-4"><ErrorState message={recent.error} /></div> : (
            <EmptyState icon={ReceiptText} title={recentKind === 'all' ? '这里还没有账单' : '这里还没有符合条件的账单'}>
              {recentKind === 'all' && <Button size="sm" onClick={() => openTransaction(null)}><Plus />记一笔</Button>}
            </EmptyState>
          )}
        </div>
        <CardFooter className="mt-auto border-t !py-3 text-sm text-muted-foreground">
          {recent.data ? <span className="tabular-nums">共 {recent.data.total} 笔</span> : ''}
          <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => go(recentKind === 'all' ? {} : { kind: recentKind })}>查看全部<ChevronRight /></Button>
        </CardFooter>
      </Card>
    </div>

  </>;
}

/** 当前月剩余天数（不含今天之前，含今天） */
function daysLeft(month: string) {
  const today = dateInShanghai(new Date());
  if (!today.startsWith(month)) return 0;
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  return last - Number(today.slice(8)) + 1;
}

function Metric({ label, value, foot }: { label: React.ReactNode; value: React.ReactNode; foot: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-5 items-center text-sm text-muted-foreground">{label}</div>
      <div className="flex min-h-10 items-baseline text-3xl leading-none font-medium tracking-tight tabular-nums">{value}</div>
      <div className="flex min-h-6 items-center gap-1.5 text-xs text-muted-foreground">{foot}</div>
    </div>
  );
}
/* 指标明细：点标签弹出构成，并可跳到对应账单 */
function MetricLink({ label, facts, onView, viewLabel, disabled }: { label: string; facts: [string, string][]; onView: () => void; viewLabel: string; disabled?: boolean }) {
  return (
    <Popover>
      <PopoverTrigger asChild disabled={disabled}>
        <Button variant="link" className="h-auto gap-0.5 p-0 font-normal text-muted-foreground has-[>svg]:px-0" disabled={disabled}>{label}<ChevronRight className="size-3.5" /></Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="border-b px-4 py-3 text-sm font-medium">{label}明细</div>
        <dl className="grid gap-2 px-4 py-3 text-sm">
          {facts.map(([a, v], i) => <div key={a + i} className="flex"><dt className="text-muted-foreground">{a}</dt><dd className="ml-auto tabular-nums">{v}</dd></div>)}
        </dl>
        <div className="border-t p-1"><Button variant="ghost" size="sm" className="w-full justify-between" onClick={onView}>{viewLabel}<ChevronRight /></Button></div>
      </PopoverContent>
    </Popover>
  );
}

/* 分类支出：顶部一条占比条看构成，下面两列看各分类。有二级标签的分类点击后原地裂变为二级明细，
   占比条与列表都换成该分类下的标签；没有标签的分类、以及二级明细里的每一项，点击查看对应账单。 */
const TAG_SHADES = [100, 78, 60, 46, 35, 27, 21, 16];
type Segment = { key: string; name: string; amountCents: number; count: number; color: string; tile: React.ReactNode; hint: string; pick: () => void; expandable?: boolean };
function CategorySpendCard({ summary: s, onPick, onOpen }: { summary: Summary; onPick: (categoryId: string, tagId?: string) => void; onOpen: (item: Transaction) => void }) {
  const { bootstrap, navigate } = useApp();
  const [focusId, setFocusId] = useState<string | null>(null);
  const rows = s.categories.filter(c => c.amountCents > 0).sort((a, b) => b.amountCents - a.amountCents)
    .map(r => ({ ...r, category: bootstrap.categories.find(c => c.id === r.categoryId) }));
  const total = rows.reduce((a, r) => a + r.amountCents, 0);
  const tone = (r: typeof rows[number]) => r.category
    ? categoryColor(r.category.color).foreground
    : r.categoryId === 'transfer'
      ? categoryColor('sage').foreground
      : 'color-mix(in srgb, var(--muted-foreground) 55%, var(--card))';
  const focus = rows.find(r => r.categoryId === focusId && r.tags?.length);

  let segments: Segment[], base = total;
  if (focus) {
    const color = tone(focus), tags = focus.tags!;
    const rest = { amountCents: focus.amountCents - tags.reduce((a, t) => a + t.amountCents, 0), count: focus.count - tags.reduce((a, t) => a + t.count, 0) };
    base = focus.amountCents;
    segments = tags.map((t, i) => ({ key: t.tagId, name: t.name, amountCents: t.amountCents, count: t.count, tile: <TagTile tag={bootstrap.tags.find(tag => tag.id === t.tagId) ?? { icon: 'other' }} />,
      color: `color-mix(in srgb, ${color} ${TAG_SHADES[Math.min(i, TAG_SHADES.length - 1)]}%, var(--card))`,
      hint: `查看${focus.name} · ${t.name}账单`, pick: () => onPick(focus.categoryId!, t.tagId) }));
    if (rest.amountCents > 0) segments.push({ key: 'none', name: '其他', ...rest, tile: <CategoryTile category={{ icon: 'other', color: 'slate' }} />,
      color: 'color-mix(in srgb, var(--muted-foreground) 30%, var(--card))', hint: `查看${focus.name}里未细分的账单`, pick: () => onPick(focus.categoryId!, 'none') });
  } else {
    segments = rows.map(r => {
      const expandable = Boolean(r.tags?.length);
      return { key: r.categoryId ?? 'none', name: r.name, amountCents: r.amountCents, count: r.count, color: tone(r),
        tile: <CategoryTile category={r.category ?? (r.categoryId === 'transfer' ? { icon: 'wallet', color: 'sage' } : { icon: 'other', color: 'slate' })} />,
        hint: expandable ? `展开${r.name}的二级分类` : `查看${r.name}账单`, expandable,
        pick: () => expandable ? setFocusId(r.categoryId) : onPick(r.categoryId ?? 'uncategorized') };
    });
  }
  const percent = (cents: number) => `${Math.round(cents / base * 100)}%`;

  return (
    <Card className={cn('gap-3 py-4', s.fixedExpenses.length > 0 && 'overflow-hidden pb-0')}>
      <CardHeader>
        {focus ? <>
          <CardTitle className="flex items-center gap-1.5">
            <button type="button" onClick={() => setFocusId(null)} className="text-muted-foreground transition-colors hover:text-foreground">分类支出</button>
            <ChevronRight className="size-4 text-muted-foreground/60" />{focus.name}<Badge variant="secondary" className="ml-0.5">{segments.length}</Badge>
          </CardTitle>
          <CardDescription className="tabular-nums">{yuan(focus.amountCents)}，共 {focus.count} 笔，按二级标签细分</CardDescription>
          <CardAction className="flex items-center gap-1">
            <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => navigate('/categories', { categoryId: focus.categoryId!, tab: 'tags' })}><Settings2 />设置标签</Button>
            <Button variant="ghost" size="sm" className="h-7" onClick={() => setFocusId(null)}><X />收起</Button>
          </CardAction>
        </> : <>
          <CardTitle className="flex items-center gap-2">分类支出<Badge variant="secondary">{rows.length}</Badge></CardTitle>
          <CardDescription>按实际支出计算，已扣除退款；带二级标签的分类可点开细分</CardDescription>
        </>}
      </CardHeader>
      {rows.length ? <CardContent className="grid gap-3">
        <div className="group/bar flex h-2 gap-0.5">
          {segments.map(g => (
            <Tooltip key={g.key}>
              <TooltipTrigger asChild>
                <button type="button" aria-label={g.hint} onClick={g.pick}
                  className="relative h-full min-w-1 cursor-pointer outline-none transition-opacity first:rounded-l-full last:rounded-r-full group-hover/bar:opacity-40 hover:!opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 after:absolute after:inset-x-0 after:-inset-y-2"
                  style={{ flex: g.amountCents, background: g.color }} />
              </TooltipTrigger>
              <TooltipContent className="tabular-nums">{g.name} · {yuan(g.amountCents)} · {percent(g.amountCents)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
          {segments.map(g => (
            <button key={g.key} type="button" onClick={g.pick} aria-label={g.hint}
              className="group/row -mx-2 flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-accent/60">
              {g.tile}
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm"><span className="size-1.5 shrink-0 rounded-full" style={{ background: g.color }} />{g.name}</span>
                <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span>{g.count} 笔</span><span>{percent(g.amountCents)}</span></span>
              </span>
              <span className="text-sm tabular-nums">{yuan(g.amountCents)}</span>
              {!focus && <ChevronRight aria-hidden className={cn('-ml-1.5 size-4 shrink-0 transition-colors', g.expandable ? 'text-muted-foreground/60 group-hover/row:text-foreground' : 'invisible')} />}
            </button>
          ))}
        </div>
      </CardContent> : <CardContent><EmptyState icon={ReceiptText} title="这个月还没有支出" /></CardContent>}
      {s.fixedExpenses.length > 0 && <CardFooter className="flex-col items-stretch gap-1 border-t bg-[#fafafb] py-3.5 [.border-t]:pt-3.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <CalendarDays className="size-4 text-muted-foreground" />
          <span>固定支出</span><Badge variant="secondary">{s.fixedExpenses.length}</Badge>
          <span className="text-xs text-muted-foreground">不计入每日日常支出</span>
        </div>
        <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
          {s.fixedExpenses.map(t => (
            <button key={t.id} onClick={() => onOpen(t)} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60">
              <span className="w-9 text-xs text-muted-foreground tabular-nums">{Number(dateInShanghai(t.occurredAt).slice(8))} 日</span>
              <span className="min-w-0 flex-1 truncate">{t.description || '固定支出'}</span>
              <span className="tabular-nums">{yuan(t.refundAdjustment?.netExpenseCents ?? t.amountCents)}</span>
            </button>
          ))}
        </div>
      </CardFooter>}
    </Card>
  );
}

/* 月度预算：一个总额适用于每个月，在总览里直接修改；留空表示不设预算 */
function BudgetEditor({ budget, trigger }: { budget: MonthlyBudget; trigger: React.ReactElement }) {
  const { refresh } = useApp();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = !value.trim() || /^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(value.trim()) && Number(value) > 0;
  async function save(event: FormEvent, clear = false) {
    event.preventDefault();
    if (busy || (!clear && !valid)) return;
    setBusy(true); setError('');
    try {
      const next = await api<MonthlyBudget>('/budget', { method: 'PUT', body: { amount: clear || !value.trim() ? null : value.trim(), version: budget.version } });
      toast.success(next.amountCents ? `月度预算已设为 ¥${money(next.amountCents)}` : '已取消月度预算');
      setOpen(false); refresh();
    } catch (cause) {
      setError(cause instanceof RequestError && cause.status === 409 ? '预算已在别处修改，已为你刷新，请重新保存。' : errorMessage(cause));
      if (cause instanceof RequestError && cause.status === 409) refresh();
    } finally { setBusy(false); }
  }
  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setValue(budget.amountCents ? centsToDecimal(budget.amountCents) : ''); setError(''); } }}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <form onSubmit={save} className="grid gap-3">
          <div className="grid gap-1"><span className="text-sm font-medium">月度预算</span><span className="text-xs text-muted-foreground">每个月都按这个金额计算剩余额度和每天可花。</span></div>
          <InputGroup>
            <InputGroupAddon><InputGroupText>¥</InputGroupText></InputGroupAddon>
            <InputGroupInput autoFocus inputMode="decimal" placeholder="例如 8000" aria-label="月度预算" aria-invalid={!valid} className="tabular-nums" value={value} onChange={e => setValue(e.target.value)} disabled={busy} />
          </InputGroup>
          {!valid && <p className="text-xs text-destructive">金额需大于 0，最多两位小数</p>}
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            {budget.amountCents !== null && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={e => save(e, true)}>取消预算</Button>}
            <Button type="submit" size="sm" className="ml-auto" disabled={busy || !valid}>{busy && <Spinner />}保存</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
