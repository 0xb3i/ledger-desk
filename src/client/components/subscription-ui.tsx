import type { LucideIcon } from 'lucide-react';
import { addCycles, daysBetween, needsReminder, type Subscription, type SubscriptionCategory } from '../../shared/subscriptions';
import { SUBSCRIPTION_COLORS, SUBSCRIPTION_ICONS } from '@/lib/subscription';
import { cn } from '@/lib/utils';

/* 订阅清单的小部件：灰色图标瓦片、倒计时胶囊与周期进度条。颜色只承载含义：类别（进度条）、需要你付款（句点橙） */

/** 图标瓦片：统一灰色，与全站类目图标一致 */
export function SubscriptionTile({ category, className }: { category: SubscriptionCategory; className?: string }) {
  const Icon = SUBSCRIPTION_ICONS[category];
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground [&_svg]:size-4', className)}>
      <Icon />
    </span>
  );
}

/** 胶囊标签：圆角满、12px、500 字重；tone 决定配色 */
const PILL_TONES = {
  neutral: 'bg-[#f0f0f2] text-[#5f6068]',
  attention: 'bg-brand-soft text-[#a9441d]',
} as const;
export function Pill({ tone, icon: Icon, children, className }: { tone: keyof typeof PILL_TONES; icon?: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-xs leading-none font-medium whitespace-nowrap tabular-nums', PILL_TONES[tone], className)}>
      {Icon && <Icon className="size-3" aria-hidden />}{children}
    </span>
  );
}

/** 扣款方式：纯文字，不加底色与边框 */
export const paymentLabel = (item: Pick<Subscription, 'autoRenew' | 'state'>) =>
  item.state === 'ending' ? '不再续费' : item.autoRenew ? '自动扣款' : '手动付款';

/** 本期已过去多少：上一期到这一期之间的进度。需要你付款的用句点橙，其余用类别色 */
export function PeriodBar({ item, className }: { item: Subscription; className?: string }) {
  const previous = addCycles(item.dueDate, item.cycle, -1);
  const length = Math.max(1, daysBetween(previous, item.dueDate));
  const elapsed = Math.min(1, Math.max(0, 1 - item.daysLeft / length));
  const color = needsReminder(item) ? 'var(--brand)' : SUBSCRIPTION_COLORS[item.category];
  return (
    <span className={cn('block h-1 overflow-hidden rounded-full bg-[#ececef]', className)} role="img" aria-label={`本期已过去 ${Math.round(elapsed * 100)}%`}>
      <span className="block h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.max(elapsed * 100, 4)}%`, background: color }} />
    </span>
  );
}
