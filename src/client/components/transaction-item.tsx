import { ChevronRight } from 'lucide-react';
import { getTransactionCashflowKind, type Bootstrap, type Transaction } from '../../shared/contracts';
import { dateInShanghai, money, signedMoney, transactionKindLabel } from '@/lib/format';
import { CategoryDot, TransactionTile, categoryName, tagOf } from '@/lib/category';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';

const warn = 'bg-brand-soft text-brand';
/* 一笔账单：分类图标、名称、状态标记与金额；退款全额抵扣时金额划掉 */
export function TransactionItem({ item, bootstrap, onOpen, showDate, compact }: {
  item: Transaction; bootstrap: Bootstrap; onOpen: (item: Transaction) => void; showDate?: boolean; compact?: boolean;
}) {
  const flow = getTransactionCashflowKind(item), label = transactionKindLabel(item), refund = item.refundAdjustment;
  const category = item.categoryId ? bootstrap.categories.find(c => c.id === item.categoryId) : undefined;
  const tag = tagOf(bootstrap, item);
  const fullyRefunded = flow === 'expense' && refund?.netExpenseCents === 0;
  const positive = flow === 'income' || flow === 'refund';
  return (
    <Item size="sm" asChild className={cn('flex-nowrap rounded-none px-4 lg:px-5', item.reviewStatus === 'pending' && !item.deletedAt && 'bg-brand-soft/30', item.deletedAt && 'opacity-60')}>
      <button onClick={() => onOpen(item)} className="w-full text-left hover:bg-accent/60"
        aria-label={`查看${item.description || label}，${label} ${money(item.amountCents)}元`}>
        <ItemMedia><TransactionTile item={item} bootstrap={bootstrap} /></ItemMedia>
        <ItemContent className="min-w-0 gap-0.5">
          <ItemTitle className="block w-full truncate">{item.description || label}</ItemTitle>
          <ItemDescription className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            {showDate && <span className="tabular-nums">{dateInShanghai(item.occurredAt).slice(5).replace('-', '/')}</span>}
            {((item.kind === 'expense' || item.kind === 'income') || item.categoryId) && (
              <span className="inline-flex items-center gap-1.5">
                {category && <CategoryDot color={category.color} className="size-1.5" />}
                {categoryName(bootstrap, item.categoryId)}
                {/* 二级分类用 › 表示从属，和总览面包屑一致；「·」留给同一行里不同字段之间的分隔 */}
                {tag && <><ChevronRight aria-hidden className="-mx-0.5 size-3 text-muted-foreground/50" /><span>{tag.name}</span></>}
              </span>
            )}
            {(item.kind === 'refund' || item.kind === 'transfer') && <span>{label}</span>}
            {item.isFixed && <span>固定支出</span>}
            {flow === 'expense' && refund && <Badge variant="secondary">{fullyRefunded ? '已全额退款' : '已部分退款'}</Badge>}
            {item.kind === 'refund' && refund && <Badge variant="secondary" className="bg-success/12 text-success">已抵扣</Badge>}
            {item.kind === 'transfer' && !item.transferDirection && <Badge variant="secondary" className={warn}>方向待确认</Badge>}
            {item.reviewStatus === 'pending' && !item.deletedAt && <Badge variant="secondary" className={warn}>待核对</Badge>}
            {item.deletedAt && <Badge variant="secondary" className="text-muted-foreground">已删除</Badge>}
            {/* 备注前用一条细竖线分隔：两侧间距都取整行的 gap，比「·」对称，也比图标轻 */}
            {!compact && item.note && <><span aria-hidden className="h-2.5 w-px shrink-0 bg-border" /><span className="min-w-0 truncate">{item.note}</span></>}
          </ItemDescription>
        </ItemContent>
        <ItemActions className={cn('tabular-nums text-foreground/80', positive && 'text-success/80')}>
          {fullyRefunded ? <del className="text-muted-foreground">{signedMoney(item.amountCents, flow)}</del> : signedMoney(item.amountCents, flow)}
        </ItemActions>
      </button>
    </Item>
  );
}
