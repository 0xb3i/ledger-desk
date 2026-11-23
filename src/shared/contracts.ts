import type { SubscriptionRecord } from './subscriptions';
export type * from './subscriptions';
export const TRANSACTION_KINDS = ['expense', 'income', 'refund', 'transfer'] as const;
export type TransactionKind = typeof TRANSACTION_KINDS[number];
export type TransferDirection = 'inflow' | 'outflow';
export function getTransactionCashflowKind(transaction: Pick<Transaction, 'kind' | 'transferDirection'>): TransactionKind {
  if (transaction.kind !== 'transfer') return transaction.kind;
  return transaction.transferDirection === 'inflow' ? 'income' : transaction.transferDirection === 'outflow' ? 'expense' : 'transfer';
}
export const KIND_LABELS: Record<TransactionKind, string> = { expense: '支出', income: '收入', refund: '退款', transfer: '转账' };
export type ReviewStatus = 'confirmed' | 'pending';
export interface Account { id: string; name: string; bank: string; currency: 'CNY'; archived: boolean }
export const CATEGORY_ICON_OPTIONS = [
  { value: 'home', label: '居住' }, { value: 'food', label: '餐饮' }, { value: 'bag', label: '购物' },
  { value: 'train', label: '交通' }, { value: 'ticket', label: '休闲' }, { value: 'health', label: '健康' },
  { value: 'learning', label: '学习' }, { value: 'salary', label: '工作' }, { value: 'wallet', label: '钱包' },
  { value: 'other', label: '其他' }, { value: 'cup', label: '咖啡' }, { value: 'plane', label: '旅行' },
  { value: 'car', label: '汽车' }, { value: 'bike', label: '骑行' }, { value: 'gift', label: '礼物' },
  { value: 'pet', label: '宠物' }, { value: 'dumbbell', label: '健身' }, { value: 'game', label: '游戏' },
  { value: 'music', label: '音乐' }, { value: 'camera', label: '摄影' }, { value: 'tree', label: '植物' },
  { value: 'tools', label: '维修' }, { value: 'smartphone', label: '手机' }, { value: 'laptop', label: '电脑' },
  { value: 'shirt', label: '服饰' }, { value: 'baby', label: '育儿' }, { value: 'beauty', label: '美容' },
  { value: 'pizza', label: '美食' }, { value: 'savings', label: '储蓄' }, { value: 'charity', label: '公益' },
] as const;
export type CategoryIcon = typeof CATEGORY_ICON_OPTIONS[number]['value'];
/** 二级标签可用图标：全部分类图标，再加更细的子分类专用图形（分类表有 CHECK 约束，不混入分类图标） */
export const TAG_EXTRA_ICON_OPTIONS = [
  { value: 'takeout', label: '外卖' }, { value: 'discount', label: '团购' }, { value: 'apple', label: '水果' },
  { value: 'basket', label: '买菜' }, { value: 'store', label: '便利店' }, { value: 'soda', label: '饮品' },
  { value: 'utensils', label: '正餐' }, { value: 'tram', label: '地铁' }, { value: 'taxi', label: '打车' },
  { value: 'rail', label: '火车' }, { value: 'parking', label: '停车' }, { value: 'fuel', label: '加油' },
  { value: 'hospital', label: '医院' }, { value: 'pill', label: '药品' }, { value: 'package', label: '快递' },
  { value: 'toy', label: '潮玩' }, { value: 'cart', label: '网购' }, { value: 'film', label: '演出' },
  { value: 'landmark', label: '展览' }, { value: 'puzzle', label: '密室' }, { value: 'wine', label: '酒吧' },
  { value: 'key', label: '房租' }, { value: 'bolt', label: '水电' }, { value: 'wifi', label: '网络' }, { value: 'book', label: '书籍' },
] as const;
export const TAG_ICON_OPTIONS = [...CATEGORY_ICON_OPTIONS, ...TAG_EXTRA_ICON_OPTIONS] as const;
export type TagIcon = typeof TAG_ICON_OPTIONS[number]['value'];
export const CATEGORY_COLOR_OPTIONS = [
  { value: 'sage', label: '雾蓝', foreground: '#7d98a6', background: '#eaf1f4' },
  { value: 'amber', label: '柔陶', foreground: '#cc8b6b', background: '#f8efe9' },
  { value: 'sand', label: '暖沙', foreground: '#ad9b7b', background: '#f4f0e8' },
  { value: 'olive', label: '苔绿', foreground: '#849379', background: '#eff1ed' },
  { value: 'green', label: '青雾', foreground: '#6f9779', background: '#edf4ee' },
  { value: 'clay', label: '灰玫', foreground: '#b08a85', background: '#f9eeed' },
  { value: 'slate', label: '雾紫', foreground: '#9689ad', background: '#f0edf7' },
] as const;
export type CategoryColor = typeof CATEGORY_COLOR_OPTIONS[number]['value'];
export interface CategoryInput { name: string; kind: 'expense' | 'income' | 'both'; icon: CategoryIcon; color: CategoryColor }
export interface Category extends CategoryInput { id: string; version: number }
export interface CategoryList { items: Category[] }
export interface CategoryDeletionPreview {
  category: Category; transactionCount: number; archivedTransactionCount: number; ruleCount: number; tagCount: number; tagRuleCount: number;
  candidates: Category[]; replacementCategoryId: string | null;
  replacements: { categoryId: string; updatedTransactions: number }[]; snapshot: string;
}
export interface CategoryDeletionResult {
  deleted: true; movedTransactions: number; movedRules: number; updatedTransactions: number;
}
export function defaultCategoryAppearance(id: string): Pick<Category, 'icon' | 'color'> {
  const defaults: Record<string, Pick<Category, 'icon' | 'color'>> = {
    food: { icon: 'food', color: 'amber' }, shopping: { icon: 'bag', color: 'sand' },
    transport: { icon: 'train', color: 'sage' }, housing: { icon: 'home', color: 'olive' },
    health: { icon: 'health', color: 'green' }, leisure: { icon: 'ticket', color: 'clay' },
    learning: { icon: 'learning', color: 'sand' }, salary: { icon: 'salary', color: 'green' },
    'other-income': { icon: 'wallet', color: 'green' }, other: { icon: 'other', color: 'slate' },
  };
  return defaults[id] ?? { icon: 'other', color: 'slate' };
}
export type CategorySource = 'unclassified' | 'manual' | 'rule';
export interface CategoryRuleInput {
  keyword: string; matchType: 'contains' | 'exact'; kind: 'expense' | 'income'; categoryId: string; enabled: boolean;
}
export interface CategoryRule extends CategoryRuleInput { id: string; source: 'builtin' | 'user'; version: number }
export type CategoryRuleMutationResult = CategoryRule & { updatedTransactions: number };
export interface CategoryRuleDeleteResult { deleted: true; updatedTransactions: number }
export interface CategoryRuleList { items: CategoryRule[] }
export interface CategoryPreviewItem {
  transactionId: string; version: number; description: string; kind: TransactionKind; amountCents: number; occurredAt: string;
  transferDirection: TransferDirection | null; previousCategoryId: string | null; categoryId: string | null; ruleId: string | null; keyword: string | null;
}
export interface CategoryPreview {
  snapshot: string; items: CategoryPreviewItem[]; matchedCount: number; unmatchedCount: number; conflictCount: number;
}
export interface CategoryRuleDraftPreview {
  changedCount: number; conflictCount: number; items: CategoryPreviewItem[];
}
export interface CategoryApplyResult { updated: number }
export interface SourceDetails {
  transactionType: string; direction: 'inflow' | 'outflow'; parserVersion: string;
  transactionTimeRaw?: string; balance?: string;
}
export interface RefundAdjustment { refundedCents: number; netExpenseCents: number; refundExpenseId: string | null }
export interface Transaction {
  id: string; occurredAt: string; kind: TransactionKind; amountCents: number; currency: 'CNY';
  description: string; counterparty: string; categoryId: string | null; accountId: string;
  source: 'manual' | 'shortcut' | 'import'; fingerprint: string | null; sourceDetails: SourceDetails | null;
  reviewStatus: ReviewStatus; note: string; createdAt: string; updatedAt: string;
  deletedAt: string | null; version: number; isFixed: boolean;
  transferDirection: TransferDirection | null; categorySource: CategorySource; categoryRuleId: string | null; categoryRuleKeyword: string | null;
  refundAdjustment?: RefundAdjustment;
  /** 手动指定的二级标签（tagId 为 null 表示归入「其他」）；仅在账单仍属 categoryId 时生效，缺省按规则推导 */
  tagOverride?: TagOverride;
}
export interface TransactionInput {
  occurredAt: string; kind: TransactionKind; amount: string; description: string;
  counterparty?: string; categoryId?: string | null; accountId: string; note?: string; isFixed?: boolean;
  categoryOverride?: boolean; transferDirection?: TransferDirection;
}
export interface DailyTotals {
  date: string; expenseCents: number; incomeCents: number; refundCents: number; fixedExpenseCents: number;
}
export interface TransactionPage {
  items: Transaction[]; total: number; page: number; pageSize: number;
  summary: {
    expenseCents: number; incomeCents: number; refundCents: number; transferCents: number;
    grossExpenseCents: number; matchedRefundCents: number; unmatchedRefundCents: number;
    transferInCents: number; transferOutCents: number; unknownTransferCents: number;
    transferInCount: number; transferOutCount: number; unknownTransferCount: number;
    expenseCount: number; incomeCount: number; refundCount: number; transferCount: number;
    netExpenseCents: number; netIncomeCents: number;
  };
  daily: DailyTotals[];
  /** 当前筛选范围内的实际支出，按「分类 × 二级标签」细分，金额降序；tagId 为 null 表示该分类下未细分 */
  breakdown?: { categoryId: string | null; categoryName: string; tagId: string | null; tagName: string | null; amountCents: number; count: number }[];
}
export interface Summary {
  month: string; expenseCents: number; incomeCents: number; refundCents: number; transferCents: number;
  averageDays: number; dailyAverageExpenseCents: number | null;
  grossExpenseCents: number; matchedRefundCents: number; unmatchedRefundCents: number;
    transferInCents: number; transferOutCents: number; unknownTransferCents: number;
    transferInCount: number; transferOutCount: number; unknownTransferCount: number;
  netExpenseCents: number; netIncomeCents: number; count: number; pendingCount: number; uncategorizedCount: number;
  previous: {
    // Amounts and counts use the indicated comparison window, not always the full previous month.
    expenseCents: number; incomeCents: number; refundCents: number;
    month: string; period: 'same-period' | 'full-month'; startDate: string; endDate: string;
    currentEndDate: string; currentExpenseCents: number; recordCount: number; currentRecordCount: number;
    /** 同一比较窗口下的结余与本期收入，用于总览收入、结余卡的同期对比 */
    netIncomeCents?: number; currentIncomeCents?: number; currentNetIncomeCents?: number;
    // Records establish a comparison baseline; this does not certify that all bank activity was imported.
    comparable: boolean;
  };
  daily: DailyTotals[];
  categories: { categoryId: string | null; name: string; amountCents: number; count: number;
    /** 该分类下各二级标签的金额，按金额降序；未命中任何标签的不列出 */
    tags?: { tagId: string; name: string; amountCents: number; count: number }[] }[];
  incomeCategories: Summary['categories'];
  fixedExpenses: Transaction[];
}
export interface Device {
  id: string; name: string; accountId: string; prefix: string; createdAt: string;
  lastUsedAt: string | null; revokedAt: string | null;
}
/** 二级标签：挂在一级分类下，由关键词规则在读取时推导，不写入账单 */
export interface Tag { id: string; name: string; categoryId: string; icon: TagIcon; position: number; version: number }
export interface TagRule { id: string; tagId: string; keyword: string; matchType: 'contains' | 'exact'; version: number }
export interface TagList { tags: Tag[]; rules: TagRule[] }
export interface TagOverride { categoryId: string; tagId: string | null }
export interface Bootstrap {
  accounts: Account[]; categories: Category[]; tags: Tag[]; tagRules: TagRule[];
  bankBalance?: { amountCents: number; asOf: string } | null;
}
export interface FeishuSyncStatus {
  sourceUrl?: string;
  configured: boolean; lastSyncAt: string | null; lastSuccessAt: string | null;
  lastError: string | null; recordCount: number; syncing: boolean;
  issues?: FeishuSyncIssue[];
}
export interface FeishuSyncIssue {
  recordId: string; message: string; recordUrl?: string; kind?: 'changed' | 'invalid';
  transactionId?: string; description?: string; occurredAt?: string; amountCents?: number;
}
export interface FeishuIssueDetail {
  recordId: string; recordUrl?: string; snapshot: string; localTransaction: Transaction;
  changes: { field: string; label: string; localValue: string; remoteValue: string }[];
  baselineAvailable: boolean; canApplyRemote: boolean; applyRemoteBlockedReason?: string;
}
export interface MailSyncIssue {
  uidValidity: number;
  uid: number;
  subject: string;
  mailDate: string | null;
  message: string;
}
export interface MailIssueDraft {
  occurredAt: string | null;
  amount: string | null;
  description: string;
  kind: TransactionKind;
  transferDirection?: TransferDirection;
}
export interface MailIssueDetail extends MailSyncIssue {
  body: string;
  draft: MailIssueDraft;
}
export interface MailSyncProgress {
  total: number;
  processed: number;
  imported: number;
}
export interface MailSyncStatus {
  configured: boolean;
  provider: 'qq';
  email: string | null;
  mailbox: string;
  accountId: string;
  syncStartDate: string | null;
  suggestedStartDate: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  recordCount: number;
  skippedExistingCount: number;
  issueCount: number;
  dismissedIssueCount: number;
  syncing: boolean;
  progress?: MailSyncProgress | null;
  issues: MailSyncIssue[];
}
/** 月度总预算：每个月都按这个金额计算；amountCents 为 null 表示未设置 */
export interface MonthlyBudget { amountCents: number | null; version: number }
export interface MonthlyBudgetInput { amount: string | null; version: number }
export interface ApiErrorBody { error: { code: string; message: string; requestId?: string } }
export interface ApiResult<T> { data: T }
export type WishlistStatus = 'wanted' | 'purchased';
export interface WishlistInput { title: string; brand: string; amount: string | null; url?: string; note: string }
export interface WishlistItem {
  id: string; title: string; brand: string; amountCents: number | null; url: string; note: string; status: WishlistStatus;
  createdAt: string; updatedAt: string; purchasedAt: string | null; deletedAt: string | null; version: number;
  /** 排队顺序，越小越靠前；旧备份恢复的心愿可能为 null，排在最后 */
  position: number | null;
}
export interface WishlistPage {
  items: WishlistItem[]; total: number; page: number; pageSize: number;
  counts: { wanted: number; purchased: number; deleted: number };
  totalAmountCents: number; pricedCount: number;
}
export interface IngestResult { status: 'created' | 'duplicate' | 'needs_review'; transactionId: string; message: string }
export interface RequestReceipt { transactionId: string; scope: string; key: string; payloadHash: string }
export interface CurrentBackup {
  format: 'personal-dashboard'; schemaVersion: 7; exportedAt: string;
  accounts: Account[]; categories: Category[]; transactions: (Transaction & { fixedAutoExcluded?: boolean })[]; receipts: RequestReceipt[];
  categoryRules: CategoryRule[]; wishlistItems: WishlistItem[]; budget: { amountCents: number } | null;
  /** 二级标签；较早的第 7 版备份可能缺少标签配置，恢复时保留目标库的默认标签 */
  tags?: Tag[]; tagRules?: TagRule[]; transactionTags?: ({ transactionId: string } & TagOverride)[];
  /** 订阅；较早的第 7 版备份没有这一项 */
  subscriptions?: SubscriptionRecord[];
}
export interface BackupRestoreResult {
  inserted: number; skipped: number; wishlistInserted: number; wishlistSkipped: number;
  subscriptionsInserted: number; subscriptionsSkipped: number; budgetRestored: boolean;
}
type LegacyTransactionWithCategory = Omit<Transaction, 'transferDirection'>;
type LegacyTransaction = Omit<Transaction, 'transferDirection' | 'categorySource' | 'categoryRuleId' | 'categoryRuleKeyword'>;
export interface LegacyBackupV6 extends Omit<CurrentBackup, 'schemaVersion' | 'budget'> {
  schemaVersion: 6;
}
export interface LegacyBackupV5 extends Omit<LegacyBackupV6, 'schemaVersion' | 'wishlistItems'> {
  schemaVersion: 5;
}
export interface LegacyBackupV4 extends Omit<LegacyBackupV5, 'schemaVersion' | 'transactions'> {
  schemaVersion: 4; transactions: LegacyTransactionWithCategory[];
}
export interface LegacyBackupV3 extends Omit<LegacyBackupV4, 'schemaVersion' | 'categories'> {
  schemaVersion: 3; categories: Pick<Category, 'id' | 'name' | 'kind'>[];
}
export interface LegacyBackupV2 extends Omit<LegacyBackupV3, 'schemaVersion' | 'transactions' | 'categoryRules'> {
  schemaVersion: 2; transactions: LegacyTransaction[];
}
export interface LegacyBackup extends Omit<LegacyBackupV2, 'schemaVersion' | 'transactions'> {
  schemaVersion: 1; transactions: (Omit<LegacyTransaction, 'isFixed'> & { isFixed?: false })[];
}
export type Backup = CurrentBackup | LegacyBackupV6 | LegacyBackupV5 | LegacyBackupV4 | LegacyBackupV3 | LegacyBackupV2 | LegacyBackup;
