import { useState } from 'react';
import { Archive, CalendarClock, CalendarOff, CalendarSync, Check, ChevronRight, CircleCheck, ExternalLink, MoreHorizontal, Pencil, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { CYCLE_LABELS, SUBSCRIPTION_CATEGORY_LABELS, needsReminder, type Subscription, type SubscriptionList, type SubscriptionSuggestion, type SubscriptionSuggestionList } from '../../shared/subscriptions';
import { api, errorMessage, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { dateLabel, money } from '@/lib/format';
import { SUBSCRIPTION_COLORS } from '@/lib/subscription';
import { PeriodBar, Pill, SubscriptionTile, paymentLabel } from '@/components/subscription-ui';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageLoading } from '@/components/states';
import { SubscriptionDialog } from '@/components/subscription-dialog';
import { HelpHint } from '@/components/help-hint';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const yuan = (cents: number) => `¥${money(cents).replace(/\.00$/, '')}`;
/* 清单够宽（容器 ≥ 48rem）才展开成多列；窄时名称在上、胶囊在下，不挤掉名称 */
const COLS = '@3xl/list:grid @3xl/list:grid-cols-[2rem_minmax(0,1fr)_9rem_9.5rem_6rem_2rem] @3xl/list:gap-x-4';
const PER: Record<Subscription['cycle'], string> = { weekly: '周', monthly: '月', quarterly: '季', semiannual: '半年', yearly: '年' };
/** 胶囊里的倒计时：扣款方式已经由另一枚胶囊说明，这里只说还有多久 */
const countdown = (item: Subscription) => item.state === 'ending' ? (item.daysLeft === 0 ? '今天到期' : `${item.daysLeft} 天后到期`)
  : item.daysLeft < 0 ? `逾期 ${-item.daysLeft} 天` : item.daysLeft === 0 ? '今天' : item.daysLeft === 1 ? '明天' : `${item.daysLeft} 天后`;
const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const shortDate = (date: string, today: string) => dateLabel(date, date.slice(0, 4) !== today.slice(0, 4));
const dueDate = (item: Subscription, today: string) => shortDate(item.dueDate, today);

/* 订阅：左栏上方是从账单识别出的「可能的订阅」待确认，下方是按扣费日排的清单；右栏是按月折算的合计与构成。
   自动扣款的只列出、不提醒；手动付款的到日子前在铃铛提醒，付完标记已付款。订阅单独记录，不会在账单里记一笔。 */
export default function Subscriptions() {
  const { location, navigate, revision, refresh } = useApp();
  const search = location.filters.search ?? '';
  const list = useResource<SubscriptionList>(`/subscriptions${search ? `?search=${encodeURIComponent(search)}` : ''}`, revision, { keepOnRefresh: true });
  const [editing, setEditing] = useState<{ item: Subscription | null } | null>(null);
  const [archive, setArchive] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const data = list.data;

  async function act(item: Subscription, action: 'renew' | 'end' | 'restore') {
    if (busy) return;
    setBusy(item.id); setError('');
    try {
      const next = await api<Subscription>(`/subscriptions/${item.id}/${action}`, { method: 'POST', body: { version: item.version } });
      toast.success(action === 'end' ? `「${item.name}」不再续费，${shortDate(next.dueDate, item.dueDate)} 到期`
        : action === 'restore' ? `「${item.name}」已恢复续费，下次 ${shortDate(next.dueDate, item.dueDate)} 扣费`
        : next.state === 'ending' ? `「${item.name}」最后一期已付，${shortDate(next.dueDate, item.dueDate)} 到期` : `「${item.name}」已付款，下次 ${shortDate(next.dueDate, item.dueDate)} 付款`);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); refresh(); }
  }

  return <>
    <PageHeader title="订阅" desc="房租、会员、软件等周期花费。手动付款的到日子前提醒，自动扣款的只列出、不打扰。">
      <Button onClick={() => setEditing({ item: null })}><Plus />添加</Button>
    </PageHeader>
    {search && <div className="flex items-center gap-2 text-sm text-muted-foreground">搜索“{search}”的结果<Button variant="ghost" size="sm" className="h-7" onClick={() => navigate('/subscriptions', {})}><X />清除搜索</Button></div>}
    {(error || list.error) && <ErrorState message={error || list.error} retry={refresh} />}

    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex min-w-0 flex-col gap-6">
      {!search && <SuggestionsCard />}
      <Card className="@container/list gap-0 overflow-hidden py-0">
        {/* 标题行兼作列头 */}
        <div className={cn('flex items-center gap-3 border-b py-3.5 pr-3 pl-4 @3xl/list:pl-5', data?.items.length ? COLS : '')}>
          <div className="col-span-2 flex min-w-0 items-center gap-2">
            <h2 className="text-base font-medium">进行中</h2>
            {data && <Badge variant="secondary" className="tabular-nums">{search ? data.items.length : data.counts.active}</Badge>}
          </div>
          {!!data?.items.length && <>
            <span className="hidden text-xs text-muted-foreground @3xl/list:block">扣款方式</span>
            <span className="hidden text-xs text-muted-foreground @3xl/list:block">下次扣费</span>
            <span className="hidden text-right text-xs text-muted-foreground @3xl/list:block">每期金额</span>
            <span className="hidden @3xl/list:block" />
          </>}
        </div>

        {!data ? (list.loading ? <PageLoading label="正在读取订阅" /> : null) : data.items.length ? (
          <div role="list" className="divide-y divide-border">
            {data.items.map(item => (
              <SubscriptionRow key={item.id} item={item} today={data.today} busy={busy === item.id} locked={!!busy}
                onOpen={() => setEditing({ item })} onRenew={() => void act(item, 'renew')} onEnd={() => void act(item, 'end')} onRestore={() => void act(item, 'restore')} />
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarClock} title={search ? '没有找到相关的订阅' : '还没有订阅'}
            description={search ? '换个关键词试试，或清除搜索查看全部。' : '账单里有规律重复的支出会出现在上方等你确认，也可以手动添加。'}>
            {!search && <Button size="sm" variant="outline" onClick={() => setEditing({ item: null })}><Plus />添加订阅</Button>}
          </EmptyState>
        )}

        {data && !search && data.items.length > 0 && (
          <button type="button" onClick={() => setEditing({ item: null })}
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-foreground/70 transition-colors outline-none hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40 lg:px-5">
            <Plus className="size-4" />添加订阅
          </button>
        )}
      </Card>
      </div>

      <div className="flex flex-col gap-4 lg:sticky lg:top-16">
        {data && <MonthlyCard list={data} onArchive={() => setArchive(true)} />}
      </div>
    </div>

    {editing && <SubscriptionDialog key={editing.item?.id ?? 'new'} item={editing.item} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
    {archive && <EndedSheet onClose={() => setArchive(false)} onOpen={item => setEditing({ item })} />}
  </>;
}

function SubscriptionRow({ item, today, busy, locked, onOpen, onRenew, onEnd, onRestore }: {
  item: Subscription; today: string; busy: boolean; locked: boolean; onOpen: () => void; onRenew: () => void; onEnd: () => void; onRestore: () => void;
}) {
  const ending = item.state === 'ending', attention = needsReminder(item);
  return (
    <div role="listitem" onClick={onOpen}
      className={cn('group/row flex cursor-pointer items-center gap-3 py-3.5 pr-3 pl-4 transition-colors hover:bg-accent/40 @3xl/list:pl-5', COLS)}>
      <span title={SUBSCRIPTION_CATEGORY_LABELS[item.category]}><SubscriptionTile category={item.category} /></span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-sm">{item.name}</span>
          {item.url && (
            <a href={item.url} target="_blank" rel="noreferrer noopener" aria-label={`打开「${item.name}」的管理页面`} title={host(item.url)}
              onClick={e => e.stopPropagation()}
              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
        {(item.note || item.url) && <p className="mt-0.5 hidden truncate text-xs text-muted-foreground @3xl/list:block">{item.note || host(item.url)}</p>}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 @3xl/list:hidden">
          <span className="text-xs text-muted-foreground">{paymentLabel(item)}</span>
          <Pill tone={attention ? 'attention' : 'neutral'}>{dueDate(item, today)} · {countdown(item)}</Pill>
        </div>
      </div>

      <div className="hidden @3xl/list:block">
        <div className="text-sm text-foreground/75">{paymentLabel(item)}</div>
        {item.endDate && !ending && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{shortDate(item.endDate, today)} 到期</div>}
      </div>

      <div className="hidden min-w-0 @3xl/list:block">
        <div className="flex items-center gap-2">
          <span className="text-sm text-foreground/80 tabular-nums">{dueDate(item, today)}</span>
          <Pill tone={attention ? 'attention' : 'neutral'}>{countdown(item)}</Pill>
          {item.isFinal && <span className="text-xs text-muted-foreground">最后一次</span>}
        </div>
        <PeriodBar item={item} className="mt-2 w-32" />
      </div>

      <div className="shrink-0 text-right tabular-nums">
        <div className="text-sm text-foreground/85">{yuan(item.amountCents)}<span className="ml-0.5 text-xs text-muted-foreground">/{PER[item.cycle]}</span></div>
        {item.cycle !== 'monthly' && <div className="mt-0.5 hidden text-xs text-muted-foreground @3xl/list:block">约 {yuan(item.monthlyCents)}/月</div>}
      </div>

      <div className="flex shrink-0 items-center justify-end" onClick={e => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={locked} aria-label={`${item.name} 的操作`}
              className={cn('size-7 text-muted-foreground/60 opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100', busy && 'opacity-100')}>
              {busy ? <Spinner className="size-3.5" /> : <MoreHorizontal />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={onOpen}><Pencil />编辑</DropdownMenuItem>
            {item.url && <DropdownMenuItem asChild><a href={item.url} target="_blank" rel="noreferrer noopener"><ExternalLink />打开管理页面</a></DropdownMenuItem>}
            {!ending && !item.autoRenew && <DropdownMenuItem onSelect={onRenew}><CircleCheck />已付款，推到下一期</DropdownMenuItem>}
            <DropdownMenuSeparator />
            {ending ? <DropdownMenuItem onSelect={onRestore}><CalendarSync />恢复续费</DropdownMenuItem>
              : <DropdownMenuItem onSelect={onEnd}><CalendarOff />不再续费（{dueDate(item, today)} 到期）</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/* 可能的订阅：账单里同一对象、同样金额、按固定周期重复出现的支出，逐条确认（✓ 加入，✗ 不是订阅），确认前可选扣款方式 */
function SuggestionsCard() {
  const { revision, refresh } = useApp();
  const list = useResource<SubscriptionSuggestionList>('/subscriptions/suggestions', revision, { keepOnRefresh: true });
  const [modes, setModes] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState('');
  const items = list.data?.items ?? [];
  if (!items.length) return null;
  async function act(item: SubscriptionSuggestion, accept: boolean) {
    if (busy) return;
    setBusy(item.key);
    try {
      const autoRenew = modes[item.key] ?? item.autoRenew;
      await api(`/subscriptions/suggestions/${accept ? 'accept' : 'dismiss'}`, { method: 'POST', body: accept ? { key: item.key, autoRenew } : { key: item.key } });
      toast.success(accept ? `已加入「${item.name}」，${autoRenew ? '自动扣款，不提醒' : '手动付款，到日子前提醒'}` : `「${item.name}」不再推荐`);
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(''); refresh(); }
  }
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-2 border-b py-3.5 pr-3 pl-4 lg:pl-5">
        <h2 className="text-base font-medium">可能的订阅</h2>
        <Badge variant="secondary" className="tabular-nums">{items.length}</Badge>
        <HelpHint>从账单里找出同一对象、同样金额、按固定周期重复的支出。确认后加入订阅，不会改动账单。</HelpHint>
      </div>
      <div role="list" className="divide-y divide-border">
        {items.map(item => {
          const auto = modes[item.key] ?? item.autoRenew, working = busy === item.key;
          return (
            <div key={item.key} role="listitem" className="flex flex-wrap items-center gap-3 py-3 pr-3 pl-4 lg:pl-5">
              <SubscriptionTile category={item.category} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{item.name}</div>
                <p className="mt-0.5 truncate text-xs text-muted-foreground tabular-nums">
                  {CYCLE_LABELS[item.cycle]} {yuan(item.amountCents)} · {item.count} 笔账单，最近 {dateLabel(item.lastPaidAt)}
                </p>
              </div>
              <ToggleGroup type="single" variant="outline" size="sm" value={auto ? 'auto' : 'manual'} disabled={!!busy} aria-label={`${item.name} 的扣款方式`}
                onValueChange={value => value && setModes(previous => ({ ...previous, [item.key]: value === 'auto' }))}>
                <ToggleGroupItem value="auto" className="px-2.5 text-xs">自动扣款</ToggleGroupItem>
                <ToggleGroupItem value="manual" className="px-2.5 text-xs">手动付款</ToggleGroupItem>
              </ToggleGroup>
              <div className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="icon-sm" disabled={!!busy} aria-label={`把「${item.name}」加入订阅`} onClick={() => void act(item, true)}>
                      {working ? <Spinner /> : <Check />}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>加入订阅</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-sm" className="text-muted-foreground" disabled={!!busy} aria-label={`「${item.name}」不是订阅`} onClick={() => void act(item, false)}>
                      <X />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>不是订阅，不再推荐</TooltipContent>
                </Tooltip>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* 右栏：按月折算的合计、类别构成，以及本月还要付和一年合计 */
function MonthlyCard({ list, onArchive }: { list: SubscriptionList; onArchive: () => void }) {
  const [whole, fraction] = money(list.monthlyCents).split('.');
  const total = list.byCategory.reduce((sum, group) => sum + group.monthlyCents, 0);
  return (
    <Card className="gap-4 overflow-hidden pb-0">
      <CardHeader>
        <CardTitle>每月合计</CardTitle>
        <CardDescription className="tabular-nums">{list.counts.active ? `进行中 ${list.counts.active} 项，按月折算` : '还没有进行中的订阅'}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className={cn('text-3xl leading-none font-medium tracking-tight tabular-nums', !list.monthlyCents && 'text-muted-foreground')}>
          <span className="mr-0.5 text-lg font-normal text-muted-foreground">¥</span>{whole}<span className="text-lg font-normal text-muted-foreground">.{fraction}</span>
        </div>
        {total > 0 && <>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-full" role="img" aria-label="各类别占比">
            {list.byCategory.map(group => (
              <span key={group.category} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${group.monthlyCents / total * 100}%`, background: SUBSCRIPTION_COLORS[group.category] }} />
            ))}
          </div>
          <dl className="grid gap-2 text-sm">
            {list.byCategory.map(group => (
              <div key={group.category} className="flex items-center gap-2">
                <span className="size-2 shrink-0 rounded-full" style={{ background: SUBSCRIPTION_COLORS[group.category] }} />
                <dt className="text-foreground/80">{SUBSCRIPTION_CATEGORY_LABELS[group.category]}<span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{group.count} 项</span></dt>
                <dd className="ml-auto text-foreground/80 tabular-nums">{yuan(group.monthlyCents)}</dd>
              </div>
            ))}
          </dl>
        </>}
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2 border-t bg-[#fafafb] py-3.5 text-sm [.border-t]:pt-3.5">
        <div className="flex"><span className="text-muted-foreground">本月还要付</span><span className="ml-auto tabular-nums">{yuan(list.remainingThisMonthCents)}</span></div>
        <div className="flex"><span className="text-muted-foreground">一年合计</span><span className="ml-auto tabular-nums">{yuan(list.yearlyCents)}</span></div>
      </CardFooter>
      {list.counts.ended > 0 && (
        <Button variant="ghost" className="-mt-4 justify-between rounded-none border-t px-6 text-muted-foreground" onClick={onArchive}>
          已到期 {list.counts.ended} 项<ChevronRight />
        </Button>
      )}
    </Card>
  );
}

/* 已到期的订阅：在抽屉里查看，可以恢复续费 */
function EndedSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (item: Subscription) => void }) {
  const { revision, refresh } = useApp();
  const list = useResource<SubscriptionList>('/subscriptions?status=ended', revision, { keepOnRefresh: true });
  const [busy, setBusy] = useState('');
  async function restore(item: Subscription) {
    if (busy) return;
    setBusy(item.id);
    try {
      await api(`/subscriptions/${item.id}/restore`, { method: 'POST', body: { version: item.version } });
      toast.success(`「${item.name}」已恢复续费`);
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(''); refresh(); }
  }
  return (
    <Sheet open onOpenChange={open => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b"><SheetTitle>已到期的订阅</SheetTitle>
          <SheetDescription>过了到期日、不再扣费的订阅，不提醒也不计入合计。恢复续费后按原周期继续。</SheetDescription></SheetHeader>
        {!list.data ? <PageLoading /> : list.data.items.length ? <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
          {list.data.items.map(item => {
            return (
              <Item key={item.id} size="sm" className="rounded-none px-4">
                <SubscriptionTile category={item.category} />
                <ItemContent className="min-w-0 cursor-pointer" onClick={() => onOpen(item)}>
                  <ItemTitle className="block truncate">{item.name}</ItemTitle>
                  <ItemDescription className="text-xs tabular-nums">{item.endedAt ? `${dateLabel(item.endedAt, true)} 停止` : `${dateLabel(item.endDate!, true)} 到期`} · {CYCLE_LABELS[item.cycle]} {yuan(item.amountCents)}</ItemDescription>
                </ItemContent>
                <ItemActions><Button variant="outline" size="sm" disabled={!!busy} onClick={() => void restore(item)}>{busy === item.id ? <Spinner /> : <CalendarSync />}恢复续费</Button></ItemActions>
              </Item>
            );
          })}
        </ItemGroup> : <EmptyState icon={Archive} title="没有已到期的订阅" />}
      </SheetContent>
    </Sheet>
  );
}
