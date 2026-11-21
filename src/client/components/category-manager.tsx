import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { toast } from 'sonner';
import {
  CATEGORY_COLOR_OPTIONS, CATEGORY_ICON_OPTIONS, type Category, type CategoryDeletionPreview, type CategoryDeletionResult, type CategoryInput, type CategoryList,
} from '../../shared/contracts';
import { api, errorMessage, RequestError, useResource } from '@/lib/api';
import { CATEGORY_ICONS, CategoryDot, CategoryTile } from '@/lib/category';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ErrorState, PageLoading } from './states';

const KIND_LABEL: Record<Category['kind'], string> = { expense: '支出', income: '收入', both: '通用' };
const EMPTY: CategoryInput = { name: '', kind: 'expense', icon: 'other', color: 'slate' };
const norm = (v: string) => v.normalize('NFKC').trim().toLowerCase();

/* 新增 / 编辑类目：名称、适用范围、图标、颜色，带实时预览 */
export function CategoryEditor({ category, onClose, onSaved }: { category: Category | null; onClose: () => void; onSaved: () => void }) {
  const [current, setCurrent] = useState(category);
  const [draft, setDraft] = useState<CategoryInput>(category ? { name: category.name, kind: category.kind, icon: category.icon, color: category.color } : EMPTY);
  const [iconSearch, setIconSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const icons = CATEGORY_ICON_OPTIONS.filter(i => norm(`${i.label} ${i.value}`).includes(norm(iconSearch)));
  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || stale) return;
    setBusy(true); setError('');
    try {
      const saved = await api<Category>(current ? `/categories/${encodeURIComponent(current.id)}` : '/categories', {
        method: current ? 'PATCH' : 'POST', body: { ...draft, name: draft.name.trim(), ...(current ? { version: current.version } : {}) },
      });
      toast.success(`${saved.name}类目已${current ? '更新' : '添加'}`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setStale(cause instanceof RequestError && cause.code === 'CATEGORY_VERSION_CONFLICT');
      setBusy(false);
    }
  }
  async function refreshVersion() {
    if (!current) return;
    setBusy(true);
    try {
      const latest = (await api<CategoryList>('/categories')).items.find(c => c.id === current.id);
      if (!latest) setError('这个类目已不可用，请返回类目列表。'); else { setCurrent(latest); setStale(false); setError(''); }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader><DialogTitle>{current ? `编辑类目：${current.name}` : '新增类目'}</DialogTitle><DialogDescription>改名或换样式不影响已有账单。</DialogDescription></DialogHeader>
          <ErrorState message={error} />
          {stale && <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={refreshVersion}>刷新类目版本，保留当前输入</Button>}
          <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
            <CategoryTile category={draft} className="size-10 [&_svg]:size-5" />
            <div><div className="flex items-center gap-1.5 text-sm"><CategoryDot color={draft.color} />{draft.name.trim() || '新类目'}</div><div className="text-xs text-muted-foreground">{KIND_LABEL[draft.kind]}类目</div></div>
          </div>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="category-name">类目名称</FieldLabel>
              <Input id="category-name" autoFocus required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="例如：宠物" disabled={busy} />
            </Field>
            <Field>
              <FieldLabel>适用范围</FieldLabel>
              <ToggleGroup type="single" variant="outline" className="w-full" value={draft.kind} onValueChange={v => v && setDraft({ ...draft, kind: v as Category['kind'] })} disabled={busy}>
                <ToggleGroupItem value="expense" className="flex-1">支出</ToggleGroupItem>
                <ToggleGroupItem value="income" className="flex-1">收入</ToggleGroupItem>
                <ToggleGroupItem value="both" className="flex-1">支出和收入</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <Field>
              <div className="flex items-center"><FieldLabel>图标</FieldLabel>
                <InputGroup className="ml-auto h-7 w-44"><InputGroupInput value={iconSearch} onChange={e => setIconSearch(e.target.value)} placeholder="搜索图标，如宠物" aria-label="搜索图标" /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>
              </div>
              {icons.length ? <div className="grid grid-cols-10 gap-1">
                {icons.map(icon => {
                  const Icon = CATEGORY_ICONS[icon.value];
                  return <Button key={icon.value} type="button" variant={draft.icon === icon.value ? 'default' : 'ghost'} size="icon-sm" title={icon.label} aria-label={`选择${icon.label}图标`}
                    aria-pressed={draft.icon === icon.value} onClick={() => setDraft({ ...draft, icon: icon.value })} disabled={busy}><Icon /></Button>;
                })}
              </div> : <p className="text-sm text-muted-foreground">没有匹配的图标。</p>}
            </Field>
            <Field>
              <FieldLabel>颜色</FieldLabel>
              <div className="flex gap-2">
                {CATEGORY_COLOR_OPTIONS.map(color => (
                  <button key={color.value} type="button" title={color.label} aria-label={`选择${color.label}`} aria-pressed={draft.color === color.value} disabled={busy}
                    onClick={() => setDraft({ ...draft, color: color.value })}
                    className={cn('size-7 rounded-full border-2 border-transparent outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', draft.color === color.value && 'border-foreground/60')}
                    style={{ background: color.foreground, boxShadow: 'inset 0 0 0 3px var(--background)' }} />
                ))}
              </div>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || stale || !draft.name.trim()}>{busy && <Spinner />}保存类目</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* 删除类目：先看关联账单与规则；有引用时必须选一个接收类目，账单按手动分类迁过去 */
export function CategoryDeleteDialog({ category, onClose, onDeleted }: { category: Category; onClose: () => void; onDeleted: () => void }) {
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const preview = useResource<CategoryDeletionPreview>(
    `/categories/${encodeURIComponent(category.id)}/deletion-preview${replacement ? `?replacementCategoryId=${encodeURIComponent(replacement)}` : ''}`, retry, { keepOnRefresh: true });
  const data = preview.data;
  const referenced = Boolean(data && (data.transactionCount || data.ruleCount));
  const plan = data?.replacementCategoryId === replacement ? data.replacements.find(r => r.categoryId === replacement) : undefined;
  const extra = plan && data ? Math.max(0, plan.updatedTransactions - data.transactionCount) : 0;
  const ready = Boolean(data && !preview.loading && !preview.refreshing && !preview.error && data.replacementCategoryId === (referenced ? replacement || null : null) && (!referenced || plan));
  async function remove() {
    if (!data || !ready) return;
    setBusy(true); setError('');
    try {
      const result = await api<CategoryDeletionResult>(`/categories/${encodeURIComponent(category.id)}`, {
        method: 'DELETE', body: { snapshot: data.snapshot, ...(referenced ? { replacementCategoryId: replacement } : {}) },
      });
      const moved = [result.movedTransactions && `${result.movedTransactions} 笔账单`, result.movedRules && `${result.movedRules} 条规则`].filter(Boolean);
      toast.success(`已删除“${category.name}”${moved.length ? `，已转移 ${moved.join('和 ')}` : ''}`);
      onDeleted();
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof RequestError && cause.status === 409) setRetry(v => v + 1);
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>删除类目「{category.name}」</DialogTitle><DialogDescription>月度预算会并入接收账单的类目。</DialogDescription></DialogHeader>
        <ErrorState message={error || preview.error} retry={() => setRetry(v => v + 1)} />
        {preview.loading && !data ? <PageLoading label="正在检查关联账单与规则" /> : data && <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <div><dt className="text-xs text-muted-foreground">关联账单</dt><dd className="tabular-nums">{data.transactionCount} 笔{data.archivedTransactionCount ? `（含 ${data.archivedTransactionCount} 笔已删除）` : ''}</dd></div>
            <div><dt className="text-xs text-muted-foreground">关联规则</dt><dd className="tabular-nums">{data.ruleCount} 条</dd></div>
          </dl>
          {data.tagCount > 0 && <p className="text-sm text-muted-foreground">此类目的 {data.tagCount} 个二级标签及其 {data.tagRuleCount} 条规则会一并删除。</p>}
          {referenced ? data.candidates.length ? <Field>
            <FieldLabel>转移到</FieldLabel>
            <Select value={replacement} onValueChange={setReplacement} disabled={busy}>
              <SelectTrigger className="w-full"><SelectValue placeholder="选择接收账单与规则的类目" /></SelectTrigger>
              <SelectContent>{data.candidates.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">账单会保留，迁移后按手动分类保存，自动规则不会覆盖。{extra > 0 && `另有 ${extra} 笔账单会按更新后的规则重新分类。`}</p>
          </Field> : <p className="text-sm text-muted-foreground">没有可接收这些记录的类目。请先新增一个同样适用范围的类目，再回来删除。</p>
            : <p className="text-sm text-muted-foreground">此类目未关联账单或规则，可以直接删除。</p>}
          {(preview.loading || preview.refreshing) && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />正在检查迁移影响…</p>}
        </div>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>取消</Button>
          <Button variant="destructive" disabled={busy || !ready} onClick={remove}>{busy && <Spinner />}{referenced ? '迁移并删除' : '确认删除'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
