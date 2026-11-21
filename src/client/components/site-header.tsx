import { useEffect, useRef, useState } from 'react';
import { Bell, ChevronRight, CircleHelp, ClipboardCheck, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { MailSyncStatus, MonthlyBudget, Summary } from '../../shared/contracts';
import { api, errorMessage, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { currentMonth, dateInShanghai, dateLabel, money, timeLabel } from '@/lib/format';
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

/* 全局搜索：心愿单页搜心愿，分类页搜类目或关键词，其余页面搜账单；⌘K 聚焦 */
function HeaderSearch() {
  const { location, navigate } = useApp();
  const mode = location.path === '/wishlist' ? 'wishlist' : location.path === '/categories' ? 'categories' : 'transactions';
  const placeholder = mode === 'wishlist' ? '搜索心愿' : mode === 'categories' ? '搜索类目或关键词' : '搜索账单';
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

/* 需要留意：汇总本月待核对、未分类、超预算与同步问题，点击直达处理位置 */
function AttentionPopover() {
  const { revision, sync, navigate } = useApp();
  const month = currentMonth();
  const summary = useResource<Summary>(`/summary?month=${month}`, revision, { keepOnRefresh: true });
  const budget = useResource<MonthlyBudget>('/budget', revision, { keepOnRefresh: true });
  const [open, setOpen] = useState(false);
  type Entry = { warn?: boolean; icon: typeof Bell; title: string; desc: string; go: () => void };
  const items: Entry[] = [];
  const s = summary.data;
  const limit = budget.data?.amountCents;
  if (s && limit && s.expenseCents > limit) items.push({ warn: true, icon: TriangleAlert, title: `本月已超出预算 ¥${money(s.expenseCents - limit)}`,
    desc: `已花 ¥${money(s.expenseCents)} · 月度预算 ¥${money(limit)}`, go: () => navigate('/overview', {}, month) });
  if (s?.pendingCount) items.push({ icon: ClipboardCheck, title: `${s.pendingCount} 笔账单待核对`, desc: '确认后才计入收支', go: () => navigate('/transactions', { status: 'pending' }, month) });
  if (s?.uncategorizedCount) items.push({ icon: CircleHelp, title: `${s.uncategorizedCount} 笔账单未分类`, desc: '选个分类，或添加自动分类规则', go: () => navigate('/transactions', { categoryId: 'uncategorized' }, month) });
  if (sync.data?.issues?.length) items.push({ warn: true, icon: RefreshCw, title: `${sync.data.issues.length} 封招行邮件需要核对`, desc: '部分邮件暂未自动解析，前往同步页查看', go: () => navigate('/settings') });
  else if (sync.data?.lastError) items.push({ warn: true, icon: RefreshCw, title: 'QQ 邮箱同步需要处理', desc: sync.data.lastError, go: () => navigate('/settings') });
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
          {items.map((a, i) => (
            <Item key={i} size="sm" asChild className="px-3">
              <button className="text-left hover:bg-accent" onClick={() => { setOpen(false); a.go(); }}>
                <ItemMedia variant="icon" className={cn(a.warn && 'border-brand/20 bg-brand-soft text-brand')}><a.icon /></ItemMedia>
                <ItemContent className="min-w-0 gap-0.5">
                  <ItemTitle className={cn('block truncate', a.warn && 'text-brand')}>{a.title}</ItemTitle>
                  <ItemDescription className="truncate text-xs">{a.desc}</ItemDescription>
                </ItemContent>
                <ItemActions className="opacity-0 transition-opacity group-hover/item:opacity-100"><ChevronRight className="size-4 text-muted-foreground" /></ItemActions>
              </button>
            </Item>
          ))}
        </ItemGroup> : <p className="px-4 py-6 text-center text-sm text-muted-foreground">都处理好了，暂时没有要留意的事。</p>}
      </PopoverContent>
    </Popover>
  );
}
