import { createContext, useContext } from 'react';
import { useResource } from './api';
import type { Bootstrap, MonthlyBudget, Summary, CategoryRuleInput, MailSyncStatus, Transaction, WishlistItem } from '../../shared/contracts';
import { currentMonth } from './format';

/* 路由：地址栏即状态（路径 + 月份 + 筛选），刷新和前进后退都能还原 */
export type Filters = Record<string, string>;
export const PAGES = [
  { path: '/overview', label: '总览', title: '收支总览' },
  { path: '/transactions', label: '账单', title: '收支明细' },
  { path: '/subscriptions', label: '订阅', title: '订阅' },
  { path: '/wishlist', label: '心愿单', title: '心愿单' },
  { path: '/categories', label: '分类与规则', title: '分类与规则' },
  { path: '/settings', label: '同步与备份', title: '同步与备份' },
] as const;
export type PagePath = typeof PAGES[number]['path'];
const FILTER_KEYS = ['search', 'kind', 'status', 'page', 'deleted', 'categoryId', 'tagId', 'spendCategory', 'date', 'sort', 'tab'];
export function spendFilters(categoryId: string, tagId = ''): Filters {
  return { kind: 'expense', spendCategory: categoryId, ...(tagId ? { tagId } : {}) };
}

const MONTHLY: PagePath[] = ['/overview', '/transactions'];

export type Location = { path: PagePath; month: string; filters: Filters };
export function readLocation(): Location {
  const params = new URLSearchParams(window.location.search);
  const filters: Filters = {};
  for (const key of FILTER_KEYS) { const value = params.get(key); if (value) filters[key] = value; }
  const month = params.get('month');
  const path = (PAGES.find(p => p.path === window.location.pathname)?.path ?? '/overview') as PagePath;
  return { path, month: month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : currentMonth(), filters };
}
export function locationUrl({ path, month, filters }: Location): string {
  const params = new URLSearchParams();
  if (MONTHLY.includes(path)) params.set('month', month);
  for (const [key, value] of Object.entries(filters)) if (FILTER_KEYS.includes(key) && value) params.set(key, value);
  return `${path}${params.size ? `?${params}` : ''}`;
}

export type SyncState = { data: MailSyncStatus | null; loading: boolean; error: string };
export type AppContextValue = {
  location: Location;
  navigate: (path: PagePath, filters?: Filters, month?: string, replace?: boolean) => void;
  bootstrap: Bootstrap;
  sync: SyncState;
  currentSummaryMonth: string;
  currentSummary: ReturnType<typeof useResource<Summary>>;
  budget: ReturnType<typeof useResource<MonthlyBudget>>;
  revision: number;
  refresh: () => void;
  openTransaction: (transaction: Transaction | null) => void;
  openWish: (item: WishlistItem | null) => void;
  /** 从账单划选文字建规则：在当前页直接弹出规则编辑框，保存后留在原页面 */
  openRule: (draft: CategoryRuleInput) => void;
};
export const AppContext = createContext<AppContextValue | null>(null);
export const useApp = () => useContext(AppContext)!;

export function useMonthlySummary(month: string) {
  const { currentSummary, currentSummaryMonth, revision } = useApp();
  const current = month === currentSummaryMonth;
  const historical = useResource<Summary>(current ? null : `/summary?month=${month}`, revision, { keepOnRefresh: true });
  return current ? currentSummary : historical;
}
