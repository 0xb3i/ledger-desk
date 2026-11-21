import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  getTransactionCashflowKind, type CategoryApplyResult, type CategoryPreview, type CategoryRule,
  type CategoryRuleDraftPreview, type CategoryRuleInput, type CategoryRuleMutationResult,
} from '../../shared/contracts';
import { api, errorMessage, RequestError, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { categoryName } from '@/lib/category';
import { dateInShanghai, signedMoney, transactionKindLabel } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ErrorState, PageLoading } from './states';

export const EMPTY_RULE: CategoryRuleInput = { keyword: '', matchType: 'contains', kind: 'expense', categoryId: '', enabled: true };
const PREVIEW_LIMIT = 30;
export const builtin = (rule: CategoryRule) => rule.id.startsWith('builtin:');
export const resultText = (message: string, updated: number) => updated ? `${message}，已更新 ${updated} 笔历史账单` : `${message}，历史账单无需更新`;

/* 规则编辑：输入时实时预览会改变哪些历史账单 */
export function RuleEditor({ rule, initial, onClose, onSaved }: { rule: CategoryRule | null; initial: CategoryRuleInput; onClose: () => void; onSaved: () => void }) {
  const { bootstrap } = useApp();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ key: string; data: CategoryRuleDraftPreview | null; error: string }>({ key: '', data: null, error: '' });
  const [retry, setRetry] = useState(0);
  const categories = bootstrap.categories.filter(c => c.kind === draft.kind || c.kind === 'both');
  const key = draft.keyword.trim() && draft.categoryId ? JSON.stringify({ ...draft, keyword: draft.keyword.trim(), ...(rule ? { editing: { id: rule.id, version: rule.version } } : {}) }) : '';
  const ready = Boolean(key && preview.key === key && preview.data && !preview.error);
  useEffect(() => {
    if (!key) { setPreview({ key: '', data: null, error: '' }); return; }
    const controller = new AbortController();
    setPreview({ key, data: null, error: '' });
    const timer = window.setTimeout(() => {
      api<CategoryRuleDraftPreview>('/category-rules/preview', { method: 'POST', body: JSON.parse(key), signal: controller.signal })
        .then(data => !controller.signal.aborted && setPreview({ key, data, error: '' }))
        .catch(cause => !controller.signal.aborted && setPreview({ key, data: null, error: errorMessage(cause) }));
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [key, retry]);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true); setError('');
    try {
      const result = await api<CategoryRuleMutationResult>(rule ? `/category-rules/${encodeURIComponent(rule.id)}` : '/category-rules', {
        method: rule ? 'PATCH' : 'POST', body: { ...draft, keyword: draft.keyword.trim(), ...(rule ? { version: rule.version } : {}) },
      });
      toast.success(resultText(rule ? '分类规则已更新' : '分类规则已添加', result.updatedTransactions));
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader><DialogTitle>{rule ? '编辑分类规则' : '新增分类规则'}</DialogTitle><DialogDescription>保存后会同时更新符合条件的历史账单。</DialogDescription></DialogHeader>
          <ErrorState message={error} />
          <FieldGroup className="gap-4">
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <Field>
                <FieldLabel htmlFor="rule-keyword">关键词</FieldLabel>
                <Input id="rule-keyword" autoFocus required maxLength={100} value={draft.keyword} onChange={e => setDraft({ ...draft, keyword: e.target.value })} placeholder="例如：拼豆" disabled={busy} />
              </Field>
              <Field>
                <FieldLabel>匹配方式</FieldLabel>
                <ToggleGroup type="single" variant="outline" value={draft.matchType} onValueChange={v => v && setDraft({ ...draft, matchType: v as CategoryRuleInput['matchType'] })} disabled={busy}>
                  <ToggleGroupItem value="contains" className="px-3">包含</ToggleGroupItem><ToggleGroupItem value="exact" className="px-3">完全一致</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-3">
              <Field>
                <FieldLabel>适用账单</FieldLabel>
                <ToggleGroup type="single" variant="outline" value={draft.kind} onValueChange={v => v && setDraft({ ...draft, kind: v as CategoryRuleInput['kind'], categoryId: '' })} disabled={busy}>
                  <ToggleGroupItem value="expense" className="px-3">支出</ToggleGroupItem><ToggleGroupItem value="income" className="px-3">收入</ToggleGroupItem>
                </ToggleGroup>
              </Field>
              <Field>
                <FieldLabel>分到哪一类</FieldLabel>
                <Select value={draft.categoryId} onValueChange={categoryId => setDraft({ ...draft, categoryId })} disabled={busy}>
                  <SelectTrigger className="w-full"><SelectValue placeholder="选择分类" /></SelectTrigger>
                  <SelectContent>{categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
            </div>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="rule-enabled" className="flex-1">启用这条规则</FieldLabel>
              <Switch id="rule-enabled" checked={draft.enabled} onCheckedChange={enabled => setDraft({ ...draft, enabled })} disabled={busy} />
            </Field>
          </FieldGroup>
          {key && <section className="rounded-lg border" aria-live="polite" aria-label="保存影响预览">
            {preview.key !== key || (!preview.data && !preview.error) ? <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Spinner />正在预览历史账单…</p>
              : preview.error ? <p className="flex items-center gap-2 p-3 text-sm text-destructive">暂时无法预览：{preview.error}<Button type="button" variant="outline" size="sm" className="ml-auto h-7" onClick={() => setRetry(v => v + 1)}>重试</Button></p>
              : <>
                <p className="border-b px-3 py-2 text-sm">{preview.data!.changedCount ? `预计 ${preview.data!.changedCount} 笔账单改变类目` : '现有账单的类目无需变化'}
                  {preview.data!.conflictCount > 0 && <span className="ml-2 text-brand">{preview.data!.conflictCount} 笔存在规则冲突，无法自动确定类目。</span>}</p>
                {preview.data!.items.length > 0 && <ul className="max-h-48 divide-y overflow-y-auto text-xs">
                  {preview.data!.items.map(item => <li key={item.transactionId} className="flex items-center gap-2 px-3 py-2">
                    <span className="w-10 text-muted-foreground tabular-nums">{dateInShanghai(item.occurredAt).slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate">{item.description || transactionKindLabel(item)}</span>
                    <span className="text-muted-foreground">{categoryName(bootstrap, item.previousCategoryId)} → {categoryName(bootstrap, item.categoryId)}</span>
                    <span className="w-20 text-right tabular-nums">{signedMoney(item.amountCents, getTransactionCashflowKind(item))}</span>
                  </li>)}
                </ul>}
              </>}
          </section>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || !ready}>{busy && <Spinner />}保存规则</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* 重新匹配历史账单：先看会改变哪些，再确认应用 */
export function RematchDialog({ onClose, onApplied }: { onClose: () => void; onApplied: () => void }) {
  const { bootstrap } = useApp();
  const [retry, setRetry] = useState(0);
  const preview = useResource<CategoryPreview>('/category-rules/preview', retry);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const data = preview.data;
  async function apply() {
    if (!data || busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<CategoryApplyResult>('/category-rules/apply', { method: 'POST', body: { snapshot: data.snapshot } });
      toast.success(result.updated ? `已更新 ${result.updated} 笔历史账单分类` : '没有需要更新的账单');
      onApplied();
    } catch (cause) { setError(errorMessage(cause)); setStale(cause instanceof RequestError && cause.status === 409); setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>重新匹配历史账单</DialogTitle><DialogDescription>只处理未分类和按规则分类的账单，手动选择的分类保持不变。</DialogDescription></DialogHeader>
        <ErrorState message={error || preview.error} />
        {preview.loading ? <PageLoading label="正在匹配" /> : data && <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{data.matchedCount ? `${data.matchedCount} 笔分类将更新` : '历史账单分类已是最新'}</span>
            {data.unmatchedCount > 0 && <Badge variant="secondary">{data.unmatchedCount} 笔未匹配到规则</Badge>}
            {data.conflictCount > 0 && <Badge variant="outline" className="border-brand/40 text-brand">{data.conflictCount} 笔命中不同分类，留待手工选择</Badge>}
          </div>
          {data.items.length > 0 && <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-xs">
            {data.items.slice(0, PREVIEW_LIMIT).map(item => <li key={item.transactionId} className="grid gap-0.5 px-3 py-2">
              <div className="flex gap-2"><span className="min-w-0 flex-1 truncate text-sm">{item.description}</span><span className="tabular-nums">{signedMoney(item.amountCents, getTransactionCashflowKind(item))}</span></div>
              <div className="flex gap-2 text-muted-foreground"><span className="tabular-nums">{dateInShanghai(item.occurredAt)}</span>{item.keyword && <span>匹配“{item.keyword}”</span>}
                <span className="ml-auto">{categoryName(bootstrap, item.previousCategoryId)} → {categoryName(bootstrap, item.categoryId)}</span></div>
            </li>)}
          </ul>}
          {data.matchedCount > PREVIEW_LIMIT && <p className="text-xs text-muted-foreground">这里展示前 {PREVIEW_LIMIT} 笔，确认后会更新全部 {data.matchedCount} 笔分类。</p>}
        </div>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>返回规则</Button>
          {stale ? <Button onClick={() => { setStale(false); setError(''); setRetry(v => v + 1); }}>重新预览</Button>
            : <Button disabled={busy || !data?.matchedCount} onClick={apply}>{busy && <Spinner />}更新 {data?.matchedCount ?? 0} 笔账单分类</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
