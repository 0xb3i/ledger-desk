import { AppWindow, CircleEllipsis, Crown, House, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { SubscriptionCategory, SubscriptionReminders } from '../../shared/subscriptions';
import { useResource } from './api';
import { useApp } from './app';

/* 订阅类别：图标统一灰色。类别色沿用类目的低饱和色板（暖沙、雾蓝、雾紫、苔绿、灰玫），只用于构成条、色点和周期进度，避开表示「需要留意」的句点橙 */
export const SUBSCRIPTION_ICONS: Record<SubscriptionCategory, LucideIcon> = {
  housing: House, software: AppWindow, membership: Crown, utility: Zap, insurance: ShieldCheck, other: CircleEllipsis,
};
export const SUBSCRIPTION_COLORS: Record<SubscriptionCategory, string> = {
  housing: '#ad9b7b', software: '#7d98a6', membership: '#9689ad', utility: '#849379', insurance: '#b08a85', other: '#a3a4ab',
};

/** 右上角铃铛用：进入提醒窗口或已过期的项目，随账本一起刷新 */
export function useSubscriptionReminders() {
  const { revision } = useApp();
  return useResource<SubscriptionReminders>('/subscriptions/reminders', revision, { keepOnRefresh: true });
}
