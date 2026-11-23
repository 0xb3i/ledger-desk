import { useEffect, useRef, useState } from 'react';
import { Bell, CalendarClock, CircleHelp, ClipboardCheck, RefreshCw, Search, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import type { MailSyncStatus } from '../../shared/contracts';
import { api, errorMessage } from '@/lib/api';
import { useApp } from '@/lib/app';
import { useSubscriptionReminders } from '@/lib/subscription';
import { dueLabel } from '../../shared/subscriptions';
import { dateInShanghai, dateLabel, money, timeLabel } from '@/lib/format';
import { cn } from '@/lib/utils';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';

export function SiteHeader({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-20 flex h-13 shrink-0 items-center gap-2 border-b bg-background">
      <div className="flex w-full items-center gap-1 px-5 lg:gap-2 lg:px-8">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <span className="text-sm text-muted-foreground">轻记</span>
        <span aria-hidden className="text-sm text-muted-foreground/45">/</span>
        <span className="text-sm font-medium text-foreground">{title}</span>
        <div className="ml-auto flex items-center gap-2">
          <HeaderSearch />
          <SyncStatus />
          <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
          <AttentionPopover />
        </div>
      </div>
    </header>
  );
}

/* 全局搜索：心愿单页搜心愿，分类页搜类目或关键词，订阅页搜订阅，其余页面搜账单；⌘K 聚焦 */
function HeaderSearch() {
  const { location, navigate } = useApp();
  const mode = location.path === '/wishlist' ? 'wishlist' : location.path === '/categories' ? 'categories' : location.path === '/subscriptions' ? 'subscriptions' : 'transactions';
  const placeholder = mode === 'wishlist' ? '搜索心愿' : mode === 'categories' ? '搜索类目或关键词' : mode === 'subscriptions' ? '搜索订阅' : '搜索账单';
  const [value, setValue] = useState(location.filters.search ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setValue(location.filters.search ?? ''), [location.filters.search]);
  useEffect(() => {
    const focus = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); input.current?.focus(); }
    };
    window.addEventListener('keydown', focus);
    return () => window.removeEventListener('keydown', focus);
  }, []);
  return (
    <form className="hidden md:block" onSubmit={event => {
      event.preventDefault();
      if (mode === 'wishlist') navigate('/wishlist', { ...(location.filters.status ? { status: location.filters.status } : {}), search: value.trim() });
      else if (mode === 'categories') navigate('/categories', { search: value.trim() });
      else if (mode === 'subscriptions') navigate('/subscriptions', { search: value.trim() });
      else navigate('/transactions', { search: value.trim() });
    }}>
      <InputGroup className="h-8 w-56 bg-card">
        <InputGroupInput
          ref={input}
          value={value}
          onChange={event => {
            const next = event.target.value;
            setValue(next);
            if (mode === 'categories') navigate('/categories', { search: next.trim() }, undefined, true);
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <InputGroupAddon><Search /></InputGroupAddon>
        <InputGroupAddon align="inline-end"><Kbd>⌘K</Kbd></InputGroupAddon>
      </InputGroup>
    </form>
  );
}

/* 同步状态：点击立即同步；出错时跳到同步与备份处理 */
export function SyncStatus() {
  const { sync, navigate, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const status = sync.data;
  if (!status?.configured) return null;
  const syncing = busy || status.syncing;
  const progressText = status.progress && status.progress.total > 0 ? `正在同步 ${status.progress.processed}/${status.progress.total}` : '正在同步…';
  const label = syncing ? progressText : status.lastError ? '同步需处理'
    : status.lastSuccessAt ? `${dateInShanghai(status.lastSuccessAt) === dateInShanghai(new Date()) ? '今天' : dateLabel(status.lastSuccessAt)} ${timeLabel(status.lastSuccessAt)} 已同步` : '等待首次同步';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" className={cn('h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground tabular-nums', status.lastError && 'text-brand')} disabled={syncing}
          onClick={async () => {
            if (status.lastError) { navigate('/settings'); return; }
            setBusy(true);
            try {
              const result = await syncNow();
              refresh();
              if (result.lastError) toast.error(result.lastError); else toast.success(result.syncing ? '正在从 QQ 邮箱同步账单。' : 'QQ 邮箱账单已同步。');
            } catch (error) { toast.error(errorMessage(error)); } finally { setBusy(false); }
          }}>
          {syncing ? <Spinner className="size-3" /> : <span className={cn('size-1.5 rounded-full', status.lastError ? 'bg-brand' : 'bg-success')} />}{label}{!syncing && !status.lastError && <RefreshCw className="size-3 opacity-70" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{status.lastError ? '打开同步与备份处理' : '立即从 QQ 邮箱同步'}</TooltipContent>
    </Tooltip>
  );
}
export const syncNow = (range?: { startDate: string; endDate: string }) =>
  api<MailSyncStatus>('/integrations/mail/sync', { method: 'POST', body: range ?? {} });

/* 忽略的提醒：按「事项 + 当前状态」记在本机浏览器里。状态一变（笔数变了、进入新的月份、订阅换了一期或变成逾期）就会重新出现 */
const DISMISSED_KEY = 'qingji.attention.dismissed';
function useDismissed() {
  const [keys, setKeys] = useState<string[]>(() => {
    try { const value = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]'); return Array.isArray(value) ? value.filter(k => typeof k === 'string') : []; } catch { return []; }
  });
  const save = (next: string[]) => { const kept = next.slice(-200); setKeys(kept); try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(kept)); } catch { /* 存不下就只在本次会话忽略 */ } };
  return { has: (key: string) => keys.includes(key), add: (key: string) => save([...keys.filter(k => k !== key), key]), remove: (removed: string[]) => save(keys.filter(k => !removed.includes(k))) };
}

/* 需要留意：汇总本月待核对、未分类、超预算、订阅即将扣费与同步问题，点击直达处理位置；每条可以忽略 */
function AttentionPopover() {
  const { currentSummary: summary, currentSummaryMonth: month, budget, sync, navigate } = useApp();
  const reminders = useSubscriptionReminders().data?.items ?? [];
  const dismissed = useDismissed();
  const [open, setOpen] = useState(false);
  type Entry = { key: string; warn?: boolean; icon: typeof Bell; title: string; desc: string; go: () => void };
  const all: Entry[] = [];
  const s = summary.data;
  const limit = budget.data?.amountCents;
  if (s && limit && s.expenseCents > limit) all.push({ key: `budget:${month}`, warn: true, icon: TriangleAlert, title: `本月已超出预算 ¥${money(s.expenseCents - limit)}`,
    desc: `已花 ¥${money(s.expenseCents)} · 月度预算 ¥${money(limit)}`, go: () => navigate('/overview', {}, month) });
  // 订阅：只提醒手动付款的（快到付款日、逾期，或快到期且不再续费）；逾期或 3 天内的标橙；超过 4 项时合并成一条
  for (const r of reminders.slice(0, reminders.length > 4 ? 3 : 4)) all.push({ key: `sub:${r.id}:${r.dueDate}:${r.state}`, warn: r.state === 'overdue' || r.daysLeft <= 3, icon: CalendarClock,
    title: `${r.name} ${dueLabel(r)}${r.state === 'ending' ? '，不再续费' : ''}`,
    desc: r.state === 'ending' ? `${dateLabel(r.dueDate)} 到期，之后不再续费` : `${dateLabel(r.dueDate)} · ¥${money(r.amountCents)}${r.isFinal ? ' · 最后一次' : ''}`, go: () => navigate('/subscriptions') });
  if (reminders.length > 4) all.push({ key: `sub-more:${reminders.slice(3).map(r => `${r.id}:${r.dueDate}`).join(',')}`, icon: CalendarClock,
    title: `另有 ${reminders.length - 3} 项订阅即将付款`, desc: '前往订阅查看', go: () => navigate('/subscriptions') });
  if (s?.pendingCount) all.push({ key: `pending:${month}:${s.pendingCount}`, icon: ClipboardCheck, title: `${s.pendingCount} 笔账单待核对`, desc: '确认后才计入收支', go: () => navigate('/transactions', { status: 'pending' }, month) });
  if (s?.uncategorizedCount) all.push({ key: `uncategorized:${month}:${s.uncategorizedCount}`, icon: CircleHelp, title: `${s.uncategorizedCount} 笔账单未分类`, desc: '选个分类，或添加自动分类规则', go: () => navigate('/transactions', { categoryId: 'uncategorized' }, month) });
  if (sync.data?.issueCount) all.push({ key: `mail-issues:${sync.data.issueCount}`, warn: true, icon: RefreshCw, title: `${sync.data.issueCount} 封招行邮件需要核对`, desc: '部分邮件暂未自动解析，前往同步页查看', go: () => navigate('/settings') });
  else if (sync.data?.lastError) all.push({ key: `mail-error:${sync.data.lastError}`, warn: true, icon: RefreshCw, title: 'QQ 邮箱同步需要处理', desc: sync.data.lastError, go: () => navigate('/settings') });
  const items = all.filter(item => !dismissed.has(item.key));
  const hidden = all.filter(item => dismissed.has(item.key));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="需要留意">
          <Bell />
          {!!items.length && <Badge className="absolute top-0.5 right-0.5 h-3.5 min-w-3.5 rounded-full bg-brand px-1 text-[10px] leading-none tabular-nums">{items.length}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-90 p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3 text-sm font-medium">需要留意<Badge variant="secondary">{items.length}</Badge></div>
        {items.length ? <ItemGroup className="p-1">
          {items.map(a => (
            <Item key={a.key} size="sm" className="gap-1 px-1 py-1 hover:bg-accent has-[button:focus-visible]:bg-accent">
              <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none" onClick={() => { setOpen(false); a.go(); }}>
                <ItemMedia variant="icon" className={cn(a.warn && 'border-brand/20 bg-brand-soft text-brand')}><a.icon /></ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className={cn('block truncate', a.warn && 'text-brand')}>{a.title}</ItemTitle>
                  <ItemDescription className="truncate text-xs">{a.desc}</ItemDescription>
                </ItemContent>
              </button>
              <ItemActions className="opacity-0 transition-opacity group-hover/item:opacity-100 has-[:focus-visible]:opacity-100">
                <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground hover:text-foreground" aria-label={`忽略「${a.title}」`} onClick={() => dismissed.add(a.key)}><X /></Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup> : <p className="px-4 py-6 text-center text-sm text-muted-foreground">当前没有新通知</p>}
        {hidden.length > 0 && (
          <div className="flex items-center border-t px-4 py-2 text-xs text-muted-foreground">
            <span className="tabular-nums">已忽略 {hidden.length} 条</span>
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => dismissed.remove(hidden.map(item => item.key))}>重新显示</Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
