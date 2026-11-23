import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronRight, Gift, GripVertical, MoreHorizontal, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { WishlistItem, WishlistPage } from '../../shared/contracts';
import { api, errorMessage, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { dateInShanghai, dateLabel, money } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageLoading } from '@/components/states';

const formatYuan = (cents: number) => `¥${money(cents).replace(/\.00$/, '')}`;
const price = (item: WishlistItem) => item.amountCents === null ? '未填价格' : formatYuan(item.amountCents);
const COLS = 'lg:grid lg:grid-cols-[1.25rem_minmax(0,1fr)_10rem_6rem_5rem_1.5rem] lg:gap-x-4';
const waited = (createdAt: string) => {
  const days = Math.round((Date.parse(dateInShanghai(new Date())) - Date.parse(dateInShanghai(createdAt))) / 86_400_000);
  return days <= 0 ? '今天加入' : `已等 ${days} 天`;
};
type Drag = { id: string; from: 'wanted' | 'purchased'; over: number | 'purchased' | 'wanted' | null };

/* 心愿单：左栏是可上下拖拽排序的单列优先级清单，右栏是预算小计与已购队列 */
export default function Wishlist() {
  const { location, navigate, revision, refresh, openWish } = useApp();
  const search = location.filters.search ?? '';
  const q = search ? `&search=${encodeURIComponent(search)}` : '';
  const requestedPage = Number(location.filters.page);
  const page = Number.isInteger(requestedPage) && requestedPage >= 1 && requestedPage <= 1_000_000 ? requestedPage : 1;
  const setPage = (next: number) => navigate('/wishlist', { ...location.filters, page: String(next) });
  const wanted = useResource<WishlistPage>(`/wishlist?status=wanted&page=${page}${q}`, revision, { keepOnRefresh: true });
  const bought = useResource<WishlistPage>(`/wishlist?status=purchased&page=1${q}`, revision, { keepOnRefresh: true });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [drag, setDrag] = useState<Drag | null>(null);
  const [archive, setArchive] = useState<'purchased' | 'deleted' | null>(null);
  const queue = !search; // 搜索结果不是完整队列，不允许调整顺序
  const w = wanted.data, b = bought.data;

  const pages = w ? Math.max(1, Math.ceil(w.total / w.pageSize)) : 1;
  const offset = w ? (w.page - 1) * w.pageSize : 0;
  useEffect(() => {
    if (w && page > pages) navigate('/wishlist', { ...location.filters, page: String(pages) }, undefined, true);
  }, [w, page, pages, navigate, location.filters]);

  async function run(id: string, task: () => Promise<string | void>) {
    if (busy) return;
    setBusy(id); setError('');
    try { const message = await task(); if (message) toast.success(message); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); refresh(); }
  }
  const setStatus = (item: WishlistItem, status: 'wanted' | 'purchased') => run(item.id, async () => {
    await api<WishlistItem>(`/wishlist/${item.id}/status`, { method: 'POST', body: { status, version: item.version } });
    return status === 'purchased' ? `「${item.title}」已移入已购` : '已移回想买';
  });
  const remove = (item: WishlistItem) => run(item.id, async () => {
    await api<WishlistItem>(`/wishlist/${item.id}`, { method: 'DELETE', body: { version: item.version } });
    return '心愿已移除，可在已移除中恢复';
  });
  const move = (item: WishlistItem, position: number) => run(item.id, async () => {
    await api<WishlistItem[]>(`/wishlist/${item.id}/position`, { method: 'POST', body: { position } });
    if (w) {
      const destinationPage = Math.ceil(position / w.pageSize);
      if (destinationPage !== page) setPage(destinationPage);
    }
  });
  function drop(target: Drag['over']) {
    if (!drag) return;
    const all = [...(w?.items ?? []), ...(b?.items ?? [])], item = all.find(i => i.id === drag.id);
    setDrag(null);
    if (!item) return;
    if (target === 'purchased' && drag.from === 'wanted') setStatus(item, 'purchased');
    else if ((target === 'wanted' || typeof target === 'number') && drag.from === 'purchased') setStatus(item, 'wanted');
    else if (typeof target === 'number' && drag.from === 'wanted' && queue && item.id !== w?.items[target]?.id) move(item, offset + target + 1);
  }

  return <>
    <PageHeader title="心愿单" desc="按想要程度从上到下排序，拖到右侧标记买到；心愿不计入账本收支。">
      <Button onClick={() => openWish(null)}><Plus />添加心愿</Button>
    </PageHeader>
    {search && <div className="flex items-center gap-2 text-sm text-muted-foreground">搜索“{search}”的结果<Button variant="ghost" size="sm" className="h-7" onClick={() => navigate('/wishlist', {})}><X />清除搜索</Button></div>}
    {(error || wanted.error || bought.error) && <ErrorState message={error || wanted.error || bought.error} retry={refresh} />}

    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左栏：单列有序队列 */}
      <Card
        className={cn('gap-0 overflow-hidden py-0 transition-shadow', drag?.from === 'purchased' && drag.over === 'wanted' && 'ring-2 ring-brand/40')}
        onDragOver={e => { if (drag?.from === 'purchased') { e.preventDefault(); if (drag.over !== 'wanted') setDrag({ ...drag, over: 'wanted' }); } }}
        onDrop={e => { e.preventDefault(); drop('wanted'); }}
      >
        {/* 标题行兼作列头：标题落在「心愿」列，其余列名与下方各列对齐 */}
        <div className={cn('flex items-center gap-3 border-b py-3.5 pl-4 pr-2.5 lg:pl-5 lg:pr-3', w?.items.length ? COLS : '')}>
          <div className="col-span-2 flex min-w-0 items-center gap-2">
            <h2 className="text-base font-medium">想买</h2>
            {w && <Badge variant="secondary" className="tabular-nums">{w.total}</Badge>}
            {!queue && <span className="truncate text-xs text-muted-foreground">搜索模式下暂不可调顺序</span>}
          </div>
          {!!w?.items.length && <>
            <span className="hidden text-xs text-muted-foreground lg:block">品牌</span>
            <span className="hidden text-xs text-muted-foreground lg:block">加入时间</span>
            <span className="hidden text-right text-xs text-muted-foreground lg:block">价格</span>
            <span className="hidden lg:block" />
          </>}
        </div>

        {!w ? <PageLoading label="正在读取心愿单" /> : w.items.length ? (
          <div role="list" className="divide-y divide-border">
            {w.items.map((item, index) => (
              <WishRow
                key={item.id}
                item={item}
                rank={offset + index + 1}
                total={w.total}
                queue={queue}
                busy={busy === item.id}
                locked={!!busy}
                dragging={drag?.id === item.id}
                dropHint={!!drag && drag.from === 'wanted' && drag.id !== item.id && drag.over === index}
                onDragStart={() => setDrag({ id: item.id, from: 'wanted', over: null })}
                onDragOver={() => drag && drag.over !== index && setDrag({ ...drag, over: index })}
                onDrop={() => drop(index)}
                onDragEnd={() => setDrag(null)}
                onOpen={() => openWish(item)}
                onMove={p => move(item, p)}
                onBuy={() => setStatus(item, 'purchased')}
                onRemove={() => remove(item)}
              />
            ))}
          </div>
        ) : (
          <EmptyState icon={Gift} title={search ? '想买里没有找到相关心愿' : '还没有想买的心愿'}
            description={search ? '换个关键词试试，或清除搜索查看完整队列。' : '把近期想买的东西先记进队列，排好先后再决定什么时候入手。'}>
            {!search && <Button size="sm" onClick={() => openWish(null)}><Plus />添加第一个心愿</Button>}
          </EmptyState>
        )}

        {w && !search && w.items.length > 0 && (
          <button
            type="button"
            onClick={() => openWish(null)}
            className="flex w-full items-center gap-2 border-t px-4 py-3 text-sm text-foreground/70 transition-colors hover:bg-accent/40 hover:text-foreground lg:px-5"
          >
            <Plus className="size-4" />添加心愿
          </button>
        )}
        {w && pages > 1 && (
          <div className="flex items-center justify-between gap-3 border-t px-4 py-2 text-sm">
            <Button variant="ghost" size="sm" disabled={page <= 1 || !!busy} onClick={() => setPage(page - 1)}>上一页</Button>
            <span className="tabular-nums text-muted-foreground">{page} / {pages}</span>
            <Button variant="ghost" size="sm" disabled={page >= pages || !!busy} onClick={() => setPage(page + 1)}>下一页</Button>
          </div>
        )}
      </Card>

      {/* 右栏：心愿预计 + 已购拖拽面板 */}
      <div className="flex flex-col gap-4 lg:sticky lg:top-16">
        {w && (
          <Card className="gap-3">
            <CardHeader>
              <CardTitle>想买预计</CardTitle>
              <CardDescription className="tabular-nums">
                {w.total ? `${w.total} 项心愿${w.pricedCount < w.total ? `，${w.total - w.pricedCount} 项未填价格` : ''}` : '还没有想买的心愿'}，不计入账本
              </CardDescription>
            </CardHeader>
            <CardContent className={cn('text-2xl font-normal tabular-nums', w.pricedCount ? 'text-foreground/85' : 'text-muted-foreground')}>
              ¥{money(w.totalAmountCents)}
            </CardContent>
            {b && b.total > 0 && (
              <CardFooter className="mt-1 border-t text-sm">
                <span className="text-muted-foreground">已购<span className="ml-1.5 text-xs text-muted-foreground/80 tabular-nums">{b.total} 项</span></span>
                <span className="ml-auto text-foreground/75 tabular-nums">{b.pricedCount ? `¥${money(b.totalAmountCents)}` : '—'}</span>
              </CardFooter>
            )}
          </Card>
        )}

        <Card
          className={cn('gap-0 py-0 transition-shadow', drag?.from === 'wanted' && 'ring-2 ring-brand/30', drag?.over === 'purchased' && 'ring-brand')}
          onDragOver={e => { if (drag?.from === 'wanted') { e.preventDefault(); if (drag.over !== 'purchased') setDrag({ ...drag, over: 'purchased' }); } }}
          onDragLeave={() => drag?.over === 'purchased' && setDrag({ ...drag, over: null })}
          onDrop={e => { e.preventDefault(); drop('purchased'); }}
        >
          <CardHeader className="border-b px-5 py-3.5 [.border-b]:pb-3.5">
            <CardTitle className="flex items-center gap-2 text-base">已购<Badge variant="secondary" className="tabular-nums">{b?.total ?? 0}</Badge></CardTitle>
            {drag?.from === 'wanted' && <CardDescription>松开即标记为买到了</CardDescription>}
          </CardHeader>
          {!b ? <PageLoading /> : b.items.length ? (
            <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
              {b.items.slice(0, 6).map(item => (
                <Item key={item.id} size="sm" draggable={!busy} onDragStart={() => setDrag({ id: item.id, from: 'purchased', over: null })} onDragEnd={() => setDrag(null)}
                  className="group/row cursor-pointer rounded-none px-4 hover:bg-accent/40" onClick={() => openWish(item)}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={!!busy}
                        aria-label={`将「${item.title}」移回想买`}
                        onClick={e => { e.stopPropagation(); setStatus(item, 'wanted'); }}
                        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-full bg-success/15 text-success transition-colors hover:bg-success/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-success disabled:cursor-default disabled:opacity-50"
                      >
                        {busy === item.id ? <Spinner className="size-3" /> : <Check className="size-3" aria-hidden />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">移回想买</TooltipContent>
                  </Tooltip>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="block truncate font-normal">{item.title}</ItemTitle>
                    <ItemDescription className="text-xs">{item.purchasedAt && `${dateLabel(item.purchasedAt, true)} 买到`}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="text-xs text-muted-foreground tabular-nums">{price(item)}</ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <CardContent className="py-8 text-center text-xs text-muted-foreground">把左栏想买的心愿拖到这里，就算买到了</CardContent>
          )}
          {b && (b.total > 6 || b.counts.deleted > 0) && (
            <CardFooter className="flex-col items-stretch gap-0 border-t p-0">
              {b.total > 6 && <Button variant="ghost" className="justify-between rounded-none px-4" onClick={() => setArchive('purchased')}>查看全部已购 {b.total} 项<ChevronRight /></Button>}
              {b.counts.deleted > 0 && <Button variant="ghost" className="justify-between rounded-none px-4 text-muted-foreground" onClick={() => setArchive('deleted')}>已移除 {b.counts.deleted} 项<ChevronRight /></Button>}
            </CardFooter>
          )}
        </Card>
      </div>
    </div>
    {archive && <ArchiveSheet status={archive} onClose={() => setArchive(null)} />}
  </>;
}

function WishRow({ item, rank, total, queue, busy, locked, dragging, dropHint, onDragStart, onDragOver, onDrop, onDragEnd, onOpen, onMove, onBuy, onRemove }: {
  item: WishlistItem; rank: number; total: number; queue: boolean; busy: boolean; locked: boolean; dragging: boolean; dropHint: boolean;
  onDragStart: () => void; onDragOver: () => void; onDrop: () => void; onDragEnd: () => void;
  onOpen: () => void; onMove: (position: number) => void; onBuy: () => void; onRemove: () => void;
}) {
  return (
    <div
      role="listitem"
      draggable={!locked}
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; onDragStart(); }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); onDragOver(); }}
      onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(); }}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className={cn(
        'group/row relative flex cursor-pointer items-center gap-3 py-3.5 pl-4 pr-2.5 transition-colors hover:bg-accent/40 lg:pl-5 lg:pr-3',
        COLS,
        dragging && 'opacity-40',
        dropHint && 'bg-brand-soft/40 shadow-[inset_0_2px_0_0_var(--brand)]',
      )}
    >
      {queue && (
        <GripVertical className="pointer-events-none absolute left-1 size-3.5 text-muted-foreground/45 opacity-0 transition-opacity group-hover/row:opacity-100" aria-hidden />
      )}

      {/* 左侧圆圈：对应右栏已购的实心勾，点击即标记买到了 */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            disabled={locked}
            aria-label={`标记「${item.title}」为已购`}
            onClick={e => { e.stopPropagation(); onBuy(); }}
            className={cn(
              'group/check grid size-5 shrink-0 place-items-center rounded-full border text-transparent transition-colors outline-none hover:border-success hover:bg-success/15 hover:text-success focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
              rank === 1 && queue ? 'border-brand/60' : 'border-muted-foreground/45',
            )}
          >
            {busy ? <Spinner className="size-3 text-foreground" /> : <Check className="size-3 opacity-0 transition-opacity group-hover/check:opacity-100" />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">标记为已购</TooltipContent>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-normal">{item.title}</div>
        {item.note && <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.note}</p>}
      </div>

      <div className="hidden min-w-0 truncate text-sm lg:block">
        {item.brand ? <span className="text-foreground/75">{item.brand}</span> : <span className="text-xs text-muted-foreground/60">—</span>}
      </div>

      <div className="hidden text-xs tabular-nums lg:block">
        <div className="text-foreground/75">{dateLabel(item.createdAt)}</div>
        <div className="mt-0.5 text-muted-foreground">{waited(item.createdAt)}</div>
      </div>

      <span className={cn('shrink-0 text-right text-sm font-normal tabular-nums', item.amountCents === null ? 'text-xs text-muted-foreground' : 'text-foreground/85')}>
        {price(item)}
      </span>

      <div className="flex shrink-0 items-center">
        <div className="flex items-center" onClick={e => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-6 text-muted-foreground/60 opacity-0 transition-opacity group-hover/row:opacity-100 hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100" disabled={locked} aria-label={`${item.title} 的操作`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              {queue && <>
                <DropdownMenuItem disabled={rank === 1} onSelect={() => onMove(1)}><ArrowUp />移到首位</DropdownMenuItem>
                <DropdownMenuItem disabled={rank === 1} onSelect={() => onMove(rank - 1)}><ArrowUp />往前排</DropdownMenuItem>
                <DropdownMenuItem disabled={rank === total} onSelect={() => onMove(rank + 1)}><ArrowDown />往后排</DropdownMenuItem>
                <DropdownMenuSeparator />
              </>}
              <DropdownMenuItem onSelect={onOpen}><Pencil />编辑</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={onRemove}><Trash2 />移除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

/* 全部已购 / 已移除：在抽屉里查看，可移回想买或恢复 */
function ArchiveSheet({ status, onClose }: { status: 'purchased' | 'deleted'; onClose: () => void }) {
  const { revision, refresh, openWish } = useApp();
  const [page, setPage] = useState(1);
  const list = useResource<WishlistPage>(`/wishlist?status=${status}&page=${page}`, revision, { keepOnRefresh: true });
  const [busy, setBusy] = useState('');
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  async function act(item: WishlistItem) {
    if (busy) return;
    setBusy(item.id);
    try {
      if (status === 'deleted') await api(`/wishlist/${item.id}/restore`, { method: 'POST', body: { version: item.version } });
      else await api(`/wishlist/${item.id}/status`, { method: 'POST', body: { status: 'wanted', version: item.version } });
      toast.success(status === 'deleted' ? '心愿已恢复' : '已移回想买');
    } catch (cause) { toast.error(errorMessage(cause)); } finally { setBusy(''); refresh(); }
  }
  return (
    <Sheet open onOpenChange={o => !o && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto sm:max-w-md">
        <SheetHeader className="border-b"><SheetTitle>{status === 'deleted' ? '已移除的心愿' : '全部已购'}</SheetTitle>
          <SheetDescription>{status === 'deleted' ? '恢复后会回到原来的清单。' : '移回想买后会回到队列里原来的位置。'}</SheetDescription></SheetHeader>
        {!list.data ? <PageLoading /> : list.data.items.length ? <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
          {list.data.items.map(item => (
            <Item key={item.id} size="sm" className="rounded-none px-4">
              <ItemContent className="min-w-0 cursor-pointer" onClick={() => openWish(item)}><ItemTitle className="block truncate font-normal">{item.title}</ItemTitle>
                <ItemDescription className="text-xs">{status === 'deleted' ? item.deletedAt && `${dateLabel(item.deletedAt, true)} 移除` : item.purchasedAt && `${dateLabel(item.purchasedAt, true)} 买到`} · {price(item)}</ItemDescription></ItemContent>
              <ItemActions><Button variant="outline" size="sm" disabled={!!busy} onClick={() => act(item)}>{busy === item.id ? <Spinner /> : <RotateCcw />}{status === 'deleted' ? '恢复' : '移回想买'}</Button></ItemActions>
            </Item>
          ))}
        </ItemGroup> : <EmptyState icon={Gift} title={status === 'deleted' ? '没有已移除的心愿' : '还没有已购心愿'} />}
        {pages > 1 && <div className="flex items-center justify-center gap-2 border-t p-3 text-xs text-muted-foreground">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button><span className="tabular-nums">{page} / {pages}</span>
          <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</Button>
        </div>}
      </SheetContent>
    </Sheet>
  );
}
