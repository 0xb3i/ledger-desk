import { useState } from 'react';
import { ChevronRight, CircleHelp, MoreHorizontal, Pencil, Plus, Shapes, Trash2, Wand2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { Category, CategoryList, CategoryRule, CategoryRuleDeleteResult, CategoryRuleList, CategoryRuleMutationResult, Summary, TransactionPage } from '../../shared/contracts';
import { api, errorMessage, RequestError, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { CategoryDot, CategoryTile } from '@/lib/category';
import { currentMonth } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Kbd } from '@/components/ui/kbd';
import { Switch } from '@/components/ui/switch';
import { ItemGroup } from '@/components/ui/item';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageHeader } from '@/components/page-header';
import { TransactionItem } from '@/components/transaction-item';
import { CategoryDeleteDialog, CategoryEditor } from '@/components/category-manager';
import { EMPTY_RULE, RematchDialog, RuleEditor, builtin, resultText } from '@/components/rule-manager';
import { EmptyState, ErrorState, PageLoading } from '@/components/states';
import { TagManager } from '@/components/tag-manager';
import { HelpHint } from '@/components/help-hint';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

const KIND_DESC: Record<Category['kind'], string> = { expense: '支出类目', income: '收入类目', both: '支出和收入通用' };
const norm = (v: string) => v.normalize('NFKC').trim().toLowerCase();
type RuleDraft = { rule: CategoryRule | null; draft: typeof EMPTY_RULE };

/* 分类与规则：顶部类目选择卡 + 下方「左账单详情 + 右 340px 规则栏」统一双栏格局 */
export default function Categories() {
  const { location, revision, refresh, navigate } = useApp();
  const [local, setLocal] = useState(0);
  const month = currentMonth();
  const search = location.filters.search ?? '';
  const categories = useResource<CategoryList>('/categories', revision + local, { keepOnRefresh: true });
  const rules = useResource<CategoryRuleList>('/category-rules', revision + local, { keepOnRefresh: true });
  const summary = useResource<Summary>(`/summary?month=${month}`, revision + local, { keepOnRefresh: true });
  // 从总览「设置标签」跳转时带上 categoryId，直接选中该类目
  const [selectedId, setSelectedId] = useState<string | null>(location.filters.categoryId ?? null);
  const [creating, setCreating] = useState(false);
  const [editor, setEditor] = useState<RuleDraft | null>(null);
  const [rematch, setRematch] = useState(false);
  const changed = () => { setLocal(v => v + 1); refresh(); };

  const items = categories.data?.items ?? [];
  const allRules = rules.data?.items ?? [];
  const rulesOf = (id: string) => allRules.filter(r => r.categoryId === id);
  const q = norm(search);

  const matchedKeywords = (id: string) => q ? rulesOf(id).filter(r => norm(r.keyword).includes(q)) : [];
  const visibleItems = q
    ? items.filter(c => norm(c.name).includes(q) || matchedKeywords(c.id).length > 0)
    : items;

  const selected = visibleItems.find(c => c.id === selectedId) ?? visibleItems[0] ?? null;
  const uncategorized = summary.data?.uncategorizedCount ?? 0;

  const expenseItems = visibleItems.filter(c => c.kind === 'expense');
  const incomeItems = visibleItems.filter(c => c.kind === 'income');
  const bothItems = visibleItems.filter(c => c.kind === 'both');

  const chip = (c: Category) => {
    const active = selected?.id === c.id;
    const enabledCount = rulesOf(c.id).filter(r => r.enabled).length;
    const hit = q ? matchedKeywords(c.id) : [];
    return (
      <button
        key={c.id}
        type="button"
        aria-pressed={active}
        title={enabledCount > 0 ? `${c.name}（${enabledCount} 条已启用自动规则）` : c.name}
        onClick={() => setSelectedId(c.id)}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          active
            ? 'bg-muted font-medium text-foreground shadow-2xs ring-1 ring-border/70'
            : 'text-foreground/75 hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <CategoryDot color={c.color} />
        <span>{c.name}</span>
        {hit.length > 0 ? (
          <span className="rounded bg-brand-soft px-1 text-xs font-normal text-foreground">{hit[0].keyword}</span>
        ) : enabledCount > 0 ? (
          <span className="text-xs text-muted-foreground tabular-nums">{enabledCount}</span>
        ) : null}
      </button>
    );
  };

  return <>
    <PageHeader title="分类与规则" desc="管理收支类目与关键词自动归类规则。">
      <Button variant="outline" onClick={() => setRematch(true)} disabled={!rules.data}><Wand2 />重新匹配历史账单</Button>
      <Button onClick={() => setCreating(true)}><Plus />新增类目</Button>
    </PageHeader>

    {search && (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        搜索“{search}”的结果
        <Button variant="ghost" size="sm" className="h-7" onClick={() => navigate('/categories', {})}><X />清除搜索</Button>
      </div>
    )}

    {uncategorized > 0 && (
      <button onClick={() => navigate('/transactions', { categoryId: 'uncategorized', status: 'confirmed' }, month)}
        className="flex items-center gap-2.5 rounded-xl border border-brand/20 bg-brand-soft/75 px-4 py-2.5 text-left text-sm transition-colors hover:bg-brand-soft">
        <CircleHelp className="size-4 shrink-0 text-brand" />
        <span>本月有 <span className="font-medium tabular-nums">{uncategorized}</span> 笔账单未分类 <span className="text-muted-foreground">去账单页归类，或在详情中划选文字添加关键词</span></span>
        <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
      </button>
    )}

    {categories.error || rules.error ? <ErrorState message={categories.error || rules.error} retry={changed} />
      : !categories.data ? <PageLoading label="正在读取类目" />
      : visibleItems.length ? (
        <div className="flex flex-col gap-5">
          {/* 顶部类目选择卡：白底卡片浮于暖石画布之上 */}
          <Card className="gap-2 px-4 py-3">
            <nav aria-label="选择类目" className="flex flex-col gap-2">
              {expenseItems.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 w-8 shrink-0 text-xs text-muted-foreground">支出</span>
                  {expenseItems.map(chip)}
                </div>
              )}
              {(incomeItems.length > 0 || bothItems.length > 0) && (
                <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-1.5', expenseItems.length > 0 && 'border-t border-border/60 pt-2')}>
                  {incomeItems.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 w-8 shrink-0 text-xs text-muted-foreground">收入</span>
                      {incomeItems.map(chip)}
                    </div>
                  )}
                  {bothItems.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 w-8 shrink-0 text-xs text-muted-foreground">通用</span>
                      {bothItems.map(chip)}
                    </div>
                  )}
                </div>
              )}
            </nav>
          </Card>

          {selected && (
            <CategoryWorkspace
              key={selected.id}
              category={selected}
              rules={rulesOf(selected.id)}
              highlightQuery={q}
              onChanged={changed}
              onDeleted={() => setSelectedId(null)}
              onEditRule={setEditor}
            />
          )}
        </div>
      ) : (
        <Card className="py-6">
          <EmptyState icon={Shapes} title={q ? `没有匹配「${search}」的类目或规则` : '还没有类目'}
            description={q ? '换个关键词试试，或清除搜索查看全部类目。' : '先创建一个支出或收入类目。'}>
            {q ? <Button variant="outline" size="sm" onClick={() => navigate('/categories', {})}>清除搜索</Button>
              : <Button size="sm" onClick={() => setCreating(true)}><Plus />新增类目</Button>}
          </EmptyState>
        </Card>
      )}

    {creating && <CategoryEditor category={null} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); changed(); }} />}
    {editor && <RuleEditor rule={editor.rule} initial={editor.draft} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); changed(); }} />}
    {rematch && <RematchDialog onClose={() => setRematch(false)} onApplied={() => { setRematch(false); changed(); }} />}
  </>;
}

/* 规则分组：标题行可折叠；搜索命中该组关键词时自动展开 */
function RuleSection({ title, rules, defaultOpen, highlight, render }: {
  title: string; rules: CategoryRule[]; defaultOpen: boolean; highlight: string; render: (r: CategoryRule) => React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const shown = open || Boolean(highlight && rules.some(r => norm(r.keyword).includes(highlight)));
  return <>
    <button type="button" aria-expanded={shown} onClick={() => setOpen(!shown)}
      className="flex w-full items-center gap-1 border-b bg-[#fafafb] px-4 py-2 text-left text-xs text-muted-foreground transition-colors last:border-b-0 hover:text-foreground">
      {title} · <span className="tabular-nums">{rules.length}</span>
      <ChevronRight className={cn('ml-auto size-3.5 transition-transform', shown && 'rotate-90')} />
    </button>
    {shown && <div role="list" className="divide-y divide-border border-b last:border-b-0">{rules.map(render)}</div>}
  </>;
}

/* 类目工作区：左卡合并类目头与本月账单（压缩顶部层级），右 340px 栏紧凑管理规则 */
function CategoryWorkspace({ category: c, rules, highlightQuery, onChanged, onDeleted, onEditRule }: {
  category: Category; rules: CategoryRule[]; highlightQuery: string;
  onChanged: () => void; onDeleted: () => void; onEditRule: (d: RuleDraft) => void;
}) {
  const { bootstrap, navigate, openTransaction, revision, location } = useApp();
  const month = currentMonth();
  const recent = useResource<TransactionPage>(`/transactions?${new URLSearchParams({ month, categoryId: c.id, pageSize: '8', page: '1' })}`, revision);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeRule, setRemoveRule] = useState<CategoryRule | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const custom = rules.filter(r => !builtin(r)), builtins = rules.filter(builtin);
  // 从总览「设置标签」跳转时带 tab=tags，直接打开二级标签
  const [panel, setPanel] = useState<'rules' | 'tags'>(location.filters.tab === 'tags' ? 'tags' : 'rules');
  const tagCount = (bootstrap.tags ?? []).filter(t => t.categoryId === c.id).length;
  const ruleKind = c.kind === 'income' ? 'income' : 'expense';

  async function toggle(rule: CategoryRule) {
    if (busy) return;
    setBusy(rule.id); setError('');
    try {
      const result = await api<CategoryRuleMutationResult>(`/category-rules/${encodeURIComponent(rule.id)}`, {
        method: 'PATCH', body: { keyword: rule.keyword, matchType: rule.matchType, kind: rule.kind, categoryId: rule.categoryId, enabled: !rule.enabled, version: rule.version },
      });
      toast.success(resultText(rule.enabled ? '规则已停用' : '规则已启用', result.updatedTransactions));
      onChanged();
    } catch (cause) { setError(errorMessage(cause)); if (cause instanceof RequestError && cause.status === 409) onChanged(); } finally { setBusy(''); }
  }
  async function remove(rule: CategoryRule) {
    if (busy) return;
    setBusy(rule.id); setError('');
    try {
      const result = await api<CategoryRuleDeleteResult>(`/category-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE', body: { version: rule.version } });
      toast.success(resultText('分类规则已删除', result.updatedTransactions));
      onChanged();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); setRemoveRule(null); }
  }

  const ruleRow = (r: CategoryRule) => {
    const matched = Boolean(highlightQuery && norm(r.keyword).includes(highlightQuery));
    const meta = [
      r.matchType === 'exact' && '完全一致',
      r.kind === 'income' && '收入',
      builtin(r) && r.source === 'user' && '已调整',
      !r.enabled && '已停用',
    ].filter(Boolean).join(' · ');
    return (
      <div key={r.id} role="listitem" className={cn('group/row flex items-center gap-2 px-4 py-2.5 transition-colors hover:bg-accent/40', !r.enabled && 'opacity-55', matched && 'bg-brand-soft/50')}>
        <Kbd className="h-6 shrink-0 px-2 font-sans text-[13px]">{r.keyword}</Kbd>
        {meta ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta}</span> : <span className="flex-1" />}
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" className="size-7 opacity-50 group-hover/row:opacity-100" aria-label={`编辑规则：${r.keyword}`} disabled={!!busy}
            onClick={() => onEditRule({ rule: r, draft: { keyword: r.keyword, matchType: r.matchType, kind: r.kind, categoryId: r.categoryId, enabled: r.enabled } })}><Pencil /></Button>
          {!builtin(r) && <Button variant="ghost" size="icon-sm" className="size-7 opacity-50 group-hover/row:opacity-100" aria-label={`删除规则：${r.keyword}`} disabled={!!busy} onClick={() => setRemoveRule(r)}><Trash2 /></Button>}
          <Switch className="ml-0.5 scale-85 origin-right" checked={r.enabled} disabled={!!busy} aria-label={`启用规则：${r.keyword}`} onCheckedChange={() => toggle(r)} />
        </div>
      </div>
    );
  };

  return <>
    {error && <ErrorState message={error} />}

    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* 左栏：合并类目身份头 + 本月账单，减少顶部堆叠 */}
      <Card className="gap-0 overflow-hidden py-0">
        <header className="flex flex-wrap items-center gap-3 border-b px-5 py-4">
          <CategoryTile category={c} className="size-9 border-0 bg-muted/80 [&_svg]:size-4" />
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-medium"><CategoryDot color={c.color} />{c.name}</h2>
            <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{KIND_DESC[c.kind]} · {rules.filter(r => r.enabled).length} 条启用规则</div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="ml-auto text-muted-foreground hover:text-foreground" aria-label={`${c.name} 的操作`}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onSelect={() => setEditing(true)}><Pencil />编辑类目</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}><Trash2 />删除类目</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </header>

        {recent.loading ? <PageLoading /> : recent.data?.items.length ? (
          <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
            {recent.data.items.map(t => <TransactionItem key={t.id} item={t} bootstrap={bootstrap} onOpen={openTransaction} showDate />)}
          </ItemGroup>
        ) : (
          <CardContent className="py-10 text-center text-xs text-muted-foreground">本月还没有「{c.name}」类目的账单</CardContent>
        )}
        {recent.data && recent.data.total > 0 && (
          <CardFooter className="border-t !py-3 text-sm text-muted-foreground">
            <span className="tabular-nums">本月 {recent.data.total} 笔</span>
            <Button variant="ghost" size="sm" className="ml-auto h-7" onClick={() => navigate('/transactions', { categoryId: c.id }, month)}>查看全部<ChevronRight /></Button>
          </CardFooter>
        )}
      </Card>

      {/* 右栏：顶部切换「归类规则 / 二级标签」，两块内容都可能很长，切换比上下堆叠更容易找到 */}
      <div className="flex flex-col gap-3">
      <Tabs value={panel} onValueChange={value => setPanel(value as 'rules' | 'tags')}>
        <TabsList className="h-8 w-full">
          <TabsTrigger value="rules" className="text-xs">归类规则<span className="text-muted-foreground tabular-nums">{rules.length}</span></TabsTrigger>
          <TabsTrigger value="tags" className="text-xs">二级标签<span className="text-muted-foreground tabular-nums">{tagCount}</span></TabsTrigger>
        </TabsList>
      </Tabs>
      {panel === 'rules' ? <Card className="gap-0 overflow-hidden py-0">
        <CardHeader className="border-b px-4 py-3.5 [.border-b]:pb-3.5">
          <CardTitle className="flex items-center gap-2 text-base">
            自动归类规则<Badge variant="secondary" className="tabular-nums">{rules.length}</Badge>
            <HelpHint>账单名称或对方包含关键词时自动归入「{c.name}」。多条命中时更具体的关键词优先，比如「美团骑行」优先于「美团」。</HelpHint>
          </CardTitle>
          <CardAction>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onEditRule({ rule: null, draft: { ...EMPTY_RULE, kind: ruleKind, categoryId: c.id } })}>
              <Plus />添加规则
            </Button>
          </CardAction>
        </CardHeader>


        {custom.length ? (
          <RuleSection title="自定义规则" rules={custom} defaultOpen={false} highlight={highlightQuery} render={ruleRow} />
        ) : (
          <p className="border-b px-4 py-4 text-xs leading-relaxed text-muted-foreground last:border-b-0">还没有自定义关键词，点右上角「添加规则」，或在账单详情里划选文字添加。</p>
        )}

        {builtins.length > 0 && <RuleSection title="内置规则" rules={builtins} defaultOpen={false} highlight={highlightQuery} render={ruleRow} />}
      </Card> : <TagManager category={c} />}
      </div>
    </div>

    {editing && <CategoryEditor category={c} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }} />}
    {deleting && <CategoryDeleteDialog category={c} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onDeleted(); onChanged(); }} />}
    <AlertDialog open={!!removeRule} onOpenChange={o => !o && setRemoveRule(null)}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>删除关键词「{removeRule?.keyword}」？</AlertDialogTitle><AlertDialogDescription>由这条规则分类的历史账单会按剩余规则重新分类。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction disabled={!!busy} onClick={() => removeRule && remove(removeRule)}>确认删除</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
