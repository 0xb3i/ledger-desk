import { AppWindow, CircleEllipsis, Crown, House, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { SubscriptionCategory, SubscriptionReminders } from '../../shared/subscriptions';
import { useResource } from './api';
import { useApp } from './app';

/* 订阅类别：图标统一灰色；颜色只用于构成条和色点，避开表示「需要留意」的句点橙 */
export const SUBSCRIPTION_ICONS: Record<SubscriptionCategory, LucideIcon> = {
  housing: House, software: AppWindow, membership: Crown, utility: Zap, insurance: ShieldCheck, other: CircleEllipsis,
};
export const SUBSCRIPTION_COLORS: Record<SubscriptionCategory, string> = {
  housing: 'var(--chart-2)',
  software: 'var(--chart-5)',
  membership: 'var(--chart-4)',
  utility: 'var(--chart-3)',
  insurance: 'color-mix(in srgb, var(--chart-2) 55%, var(--foreground))',
  other: 'color-mix(in srgb, var(--muted-foreground) 55%, var(--card))',
};

/** 右上角铃铛用：进入提醒窗口或已过期的项目，随账本一起刷新 */
export function useSubscriptionReminders() {
  const { revision } = useApp();
  return useResource<SubscriptionReminders>('/subscriptions/reminders', revision, { keepOnRefresh: true });
}
