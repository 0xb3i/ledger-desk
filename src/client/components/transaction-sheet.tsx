import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, ChevronDown, ChevronRight, Tags } from 'lucide-react';
import { toast } from 'sonner';
import {
  KIND_LABELS, getTransactionCashflowKind, type Transaction, type TransactionInput, type TransactionKind, type TransferDirection,
} from '../../shared/contracts';
import { api, errorMessage } from '@/lib/api';
import { useApp } from '@/lib/app';
import { centsToDecimal, dateInShanghai, dateTimeInput, money, signedMoney, transactionKindLabel } from '@/lib/format';
import { TAG_ICONS, TransactionTile, categoryName } from '@/lib/category';
import { autoTag, byPosition, matchTag } from '../../shared/tags';
import type { TagOverride } from '../../shared/contracts';
import { cn } from '@/lib/utils';
import { transactionRuleDraft } from './transactionRuleDraft';
import { DatePicker } from './date-picker';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Spinner } from '@/components/ui/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { ErrorState } from './states';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

const SOURCE: Record<Transaction['source'], string> = { manual: '手动记录', shortcut: '快捷指令', import: '导入记录' };
const ORDER = ['housing', 'food', 'shopping', 'transport', 'leisure', 'health', 'learning', 'other', 'salary', 'other-income'];
const NONE = '__none__';

export function TransactionSheet({ transaction, onClose, onSaved, onOpen, onTagChange }: {
  transaction: Transaction | null; onClose: () => void; onSaved: () => void; onOpen: (item: Transaction) => void;
  onTagChange: (id: string, override?: TagOverride) => void;
}) {
  const [mode, setMode] = useState<'detail' | 'edit'>(transaction ? 'detail' : 'edit');
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const requestClose = () => { if (mode === 'edit' && dirty) setConfirmDiscard(true); else onClose(); };
  return (
    <Sheet open onOpenChange={open => !open && requestClose()}>
      <SheetContent className="gap-0 overflow-y-auto sm:max-w-md">
        {mode === 'detail' && transaction
          ? <Detail transaction={transaction} onEdit={() => setMode('edit')} onSaved={onSaved} onOpen={onOpen} onTagChange={onTagChange} />
          : <Editor transaction={transaction} onCancel={() => transaction ? (dirty ? setConfirmDiscard(true) : setMode('detail')) : requestClose()} onDirty={setDirty} onSaved={onSaved} />}
      </SheetContent>
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>有未保存的修改</AlertDialogTitle><AlertDialogDescription>放弃后，这次填写的内容不会保存。</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>继续编辑</AlertDialogCancel><AlertDialogAction onClick={onClose}>放弃修改</AlertDialogAction></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sheet>
  );
}

/* ---------- 详情 ---------- */
function Detail({ transaction: t, onEdit, onSaved, onOpen, onTagChange }: { transaction: Transaction; onEdit: () => void; onSaved: () => void; onOpen: (item: Transaction) => void; onTagChange: (id: string, override?: TagOverride) => void }) {
  const { bootstrap, openRule, refresh } = useApp();
  const [busy, setBusy] = useState('');
  // 二级分类：默认按规则自动推导，也可以对这一笔手动指定某个标签或「其他」，选中即保存
  const tagOverride = t.tagOverride;
  const categoryTags = t.categoryId ? (bootstrap.tags ?? []).filter(tag => tag.categoryId === t.categoryId).sort(byPosition) : [];
  const tag = matchTag({ ...t, tagOverride }, bootstrap.tags ?? [], bootstrap.tagRules ?? []);
  const automatic = autoTag(t, bootstrap.tags ?? [], bootstrap.tagRules ?? []);
  const manual = Boolean(tagOverride && tagOverride.categoryId === t.categoryId && (tagOverride.tagId === null || categoryTags.some(item => item.id === tagOverride.tagId)));
  async function pickTag(value: string) {
    if (busy) return;
    setBusy('tag'); setError('');
    try {
      if (value === 'auto') { await api(`/transactions/${encodeURIComponent(t.id)}/tag`, { method: 'DELETE', body: {} }); onTagChange(t.id); }
      else {
        const result = await api<{ tagOverride: TagOverride }>(`/transactions/${encodeURIComponent(t.id)}/tag`, { method: 'PUT', body: { tagId: value === 'none' ? null : value } });
        onTagChange(t.id, result.tagOverride);
      }
      toast.success(value === 'auto' ? '已恢复按规则自动细分' : '二级分类已修改');
      refresh();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const flow = getTransactionCashflowKind(t);
  const body = useRef<HTMLDivElement>(null);
  const selection = useRuleSelection(body);
  const ruleFallback = transactionRuleDraft(t, bootstrap.categories);

  async function status(action: 'archive' | 'restore' | 'confirm') {
    setBusy(action); setError('');
    try {
      await api<Transaction>(`/transactions/${t.id}/${action}`, { method: 'POST', body: { version: t.version } });
      toast.success(action === 'archive' ? '账单已删除，可在已删除账单中恢复' : action === 'restore' ? '账单已恢复' : '账单已确认，已计入收支');
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); setBusy(''); }
  }
  async function openRefundExpense() {
    setBusy('refund'); setError('');
    try { onOpen(await api<Transaction>(`/transactions/${encodeURIComponent(t.id)}/refund-expense`)); }
    catch (cause) { setError(errorMessage(cause)); setBusy(''); }
  }
  const rows: [string, React.ReactNode][] = [
    ['类型', <>{transactionKindLabel(t)}{t.kind === 'refund' && t.refundAdjustment && <Badge variant="outline" className="ml-2 border-success/40 text-success">已抵扣</Badge>}</>],
    ...((t.kind === 'expense' || t.kind === 'income') || t.categoryId ? [['分类', (
      // 二级分类与一级同行显示为「餐饮 › 外卖」；子分类是可点的文字，点开选择自动、某个标签或「其他」，选中即保存
      <span className="inline-flex flex-wrap items-center gap-x-1">
        {categoryName(bootstrap, t.categoryId)}
        {categoryTags.length > 0 && !t.deletedAt && <>
          <ChevronRight aria-hidden className="size-3.5 text-muted-foreground/50" />
          <Select value={manual ? tagOverride!.tagId ?? 'none' : 'auto'} onValueChange={pickTag} disabled={!!busy}>
            <SelectTrigger size="sm" aria-label="二级分类" title={manual ? '手动指定，点击修改' : '按规则自动细分，点击修改'}
              className="-mx-1 h-auto gap-0.5 rounded-md border-0 bg-transparent px-1 py-0 text-sm shadow-none hover:bg-accent focus-visible:ring-2 data-[size=sm]:h-6 dark:bg-transparent [&>svg]:size-3.5 [&>svg]:opacity-0 hover:[&>svg]:opacity-60 data-[state=open]:bg-accent data-[state=open]:[&>svg]:opacity-60">
              <SelectValue>{tag?.name ?? '其他'}</SelectValue>
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="auto">自动（{automatic?.name ?? '其他'}）</SelectItem>
              <SelectSeparator />
              {categoryTags.map(item => { const Icon = TAG_ICONS[item.icon]; return <SelectItem key={item.id} value={item.id}><Icon className="size-3.5" />{item.name}</SelectItem>; })}
              <SelectItem value="none">其他</SelectItem>
            </SelectContent>
          </Select>
          {busy === 'tag' && <Spinner className="size-3 text-muted-foreground" />}
        </>}
        {t.isFixed && <span className="text-muted-foreground">· 固定支出</span>}
      </span>
    )] as [string, React.ReactNode]] : []),
    ['日期', dateInShanghai(t.occurredAt)],
    ...(t.counterparty && t.counterparty !== t.description ? [['交易对方', <span data-rule-source="counterparty">{t.counterparty}</span>] as [string, React.ReactNode]] : []),
    ...(flow === 'expense' && t.refundAdjustment ? [['退款抵扣', `¥${money(t.refundAdjustment.refundedCents)}`], ['实际支出', `¥${money(t.refundAdjustment.netExpenseCents)}`]] as [string, React.ReactNode][] : []),
    ...(t.note ? [['备注', t.note] as [string, React.ReactNode]] : []),
  ];
  const extra: [string, string][] = [
    ['交易时间', dateTimeInput(t.occurredAt).replace('T', ' ')], ['来源', SOURCE[t.source]],
    ...(t.categorySource === 'manual' ? [['分类方式', '手动选择'] as [string, string]] : []),
    ...(t.categorySource === 'rule' ? [['分类方式', `自动匹配${t.categoryRuleKeyword ? `“${t.categoryRuleKeyword}”` : ''}`] as [string, string]] : []),
    ['状态', t.deletedAt ? '已删除' : t.reviewStatus === 'pending' ? '待核对' : '已确认'],
    ...(t.sourceDetails?.transactionType ? [['原交易类型', t.sourceDetails.transactionType] as [string, string]] : []),
    ...(t.sourceDetails?.transactionTimeRaw ? [['原交易时间', t.sourceDetails.transactionTimeRaw] as [string, string]] : []),
    ...(t.sourceDetails?.balance ? [['交易后余额', `¥${t.sourceDetails.balance}`] as [string, string]] : []),
  ];
  return <>
    <div ref={body} className="flex flex-col">
      <SheetHeader className="gap-3 border-b pb-5">
        <SheetDescription className="flex items-center gap-2">
          <TransactionTile item={t} bootstrap={bootstrap} className="size-7" />{dateTimeInput(t.occurredAt).replace('T', ' ').slice(0, 16)}
          {t.reviewStatus === 'pending' && !t.deletedAt && <Badge variant="outline" className="border-brand/40 text-brand">待核对</Badge>}
          {t.deletedAt && <Badge variant="secondary">已删除</Badge>}
        </SheetDescription>
        <SheetTitle className={cn('text-3xl font-medium tracking-tight tabular-nums', (flow === 'income' || flow === 'refund') && 'text-success')}>
          {signedMoney(t.amountCents, flow).replace(/^[+−]?/, '$&¥')}
        </SheetTitle>
        <div className="text-base" data-rule-source="description">{t.description || KIND_LABELS[t.kind]}</div>
      </SheetHeader>

      <div className="flex flex-col gap-5 p-4">
        {t.reviewStatus === 'pending' && !t.deletedAt && (
          <div className="flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft/50 p-3 text-sm">
            <span className="flex-1">这笔账单待核对，确认后才计入收支。</span>
            <Button size="sm" disabled={!!busy} onClick={() => status('confirm')}>{busy === 'confirm' && <Spinner />}确认入账</Button>
          </div>
        )}
        <dl className="grid grid-cols-[80px_1fr] gap-x-4 gap-y-3 text-sm">
          {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {t.kind === 'refund' && t.refundAdjustment?.refundExpenseId && (
          <Button variant="outline" size="sm" className="self-start" disabled={!!busy} onClick={openRefundExpense}>
            {busy === 'refund' ? <><Spinner />正在读取原支出</> : <>查看对应支出<ArrowRight /></>}
          </Button>
        )}
        {ruleFallback && (t.kind === 'expense' || t.kind === 'income') && !t.deletedAt && (
          <div className={cn('flex items-center gap-2.5 rounded-lg border px-3 py-2 text-xs transition-colors', selection ? 'border-brand/35 bg-brand-soft/40' : 'border-border/80 bg-muted/35')}>
            <Tags className={cn('size-3.5 shrink-0', selection ? 'text-brand' : 'text-muted-foreground')} />
            {selection ? <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">已划选 <span className="font-medium text-foreground">「{selection}」</span></span>
              <Button size="sm" variant="outline" className="h-7 shrink-0 bg-background px-2.5 text-xs shadow-none" onPointerDown={event => event.preventDefault()} onClick={() => { const d = transactionRuleDraft(t, bootstrap.categories, selection); if (d) { window.getSelection()?.removeAllRanges(); openRule(d); } }}>设为关键词</Button>
            </> : <>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">划选名称或对方文字可设关键词</span>
              <Button size="sm" variant="outline" className="h-7 shrink-0 bg-background px-2.5 text-xs shadow-none" onClick={() => openRule(ruleFallback)}>添加规则</Button>
            </>}
          </div>
        )}
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            更多信息<ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-3 grid grid-cols-[80px_1fr] gap-x-4 gap-y-3 text-sm">
              {extra.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>)}
            </dl>
          </CollapsibleContent>
        </Collapsible>
        <ErrorState message={error} />
      </div>
    </div>
    <SheetFooter className="mt-auto flex-row border-t">
      {t.deletedAt
        ? <Button className="ml-auto" disabled={!!busy} onClick={() => status('restore')}>{busy === 'restore' && <Spinner />}恢复账单</Button>
        : <>
          <Button variant="ghost" className="text-destructive hover:text-destructive" disabled={!!busy} onClick={() => setConfirmDelete(true)}>删除账单</Button>
          <Button className="ml-auto" disabled={!!busy} onClick={onEdit}>编辑账单</Button>
        </>}
    </SheetFooter>
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>删除这笔账单？</AlertDialogTitle><AlertDialogDescription>可在「已删除账单」中恢复。</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction onClick={() => status('archive')}>确认删除</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}

/** 只认同一字段（名称或交易对方）内的划选文字，最长 100 字 */
function useRuleSelection(container: React.RefObject<HTMLElement | null>) {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !container.current) return setValue(null);
      const range = selection.getRangeAt(0);
      const source = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('[data-rule-source]');
      const start = source(range.startContainer);
      if (!start || start !== source(range.endContainer) || !container.current.contains(start)) return setValue(null);
      const text = selection.toString().trim();
      setValue(text && text.length <= 100 ? text : null);
    };
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [container]);
  return value;
}

/* ---------- 编辑 / 记一笔 ---------- */
function Editor({ transaction: t, onCancel, onDirty, onSaved }: {
  transaction: Transaction | null; onCancel: () => void; onDirty: (dirty: boolean) => void; onSaved: () => void;
}) {
  const { bootstrap, location } = useApp();
  const [initial] = useState(() => {
    if (t) return dateTimeInput(t.occurredAt);
    const now = dateTimeInput(new Date()), month = location.month;
    if (month === now.slice(0, 7)) return now;
    return `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate()).padStart(2, '0')}T${now.slice(11)}`;
  });
  const start = {
    kind: t?.kind ?? 'expense' as TransactionKind, direction: (t?.transferDirection ?? t?.sourceDetails?.direction ?? '') as TransferDirection | '',
    categoryId: t?.categoryId ?? '', isFixed: t?.isFixed ?? false, date: initial.slice(0, 10), time: initial.slice(11),
    amount: t ? centsToDecimal(t.amountCents) : '', description: t?.description ?? '', note: t?.note ?? '', counterparty: t?.counterparty ?? '',
  };
  const [v, setV] = useState(start);
  const [categoryOverride, setCategoryOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submission = useRef({ key: crypto.randomUUID(), payload: '' });
  const dirty = JSON.stringify(v) !== JSON.stringify(start) || categoryOverride;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const set = (patch: Partial<typeof v>) => setV(current => ({ ...current, ...patch }));
  const flow = getTransactionCashflowKind({ kind: v.kind, transferDirection: v.kind === 'transfer' ? v.direction || null : null });
  const categories = bootstrap.categories.filter(c => c.kind === 'both' || c.kind === (flow === 'refund' ? 'expense' : flow))
    .sort((a, b) => (ORDER.indexOf(a.id) + 1 || 99) - (ORDER.indexOf(b.id) + 1 || 99));
  const account = t ? bootstrap.accounts.find(a => a.id === t.accountId) : bootstrap.accounts.find(a => !a.archived);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const time = v.time.length === 5 ? `${v.time}:00` : v.time;
    const ms = t && time === initial.slice(11) ? new Date(t.occurredAt).getUTCMilliseconds() : 0;
    // 只改备注等字段时保持原时间戳原样，保留导入的秒、毫秒与时区精度
    const occurredAt = t && v.date === initial.slice(0, 10) && time === initial.slice(11)
      ? t.occurredAt : `${v.date}T${time}${ms ? `.${String(ms).padStart(3, '0')}` : ''}+08:00`;
    const input: TransactionInput = {
      kind: v.kind, ...(v.kind === 'transfer' && v.direction ? { transferDirection: v.direction } : {}),
      amount: v.amount.trim(), description: v.description.trim(), occurredAt, counterparty: v.counterparty.trim(),
      accountId: t?.accountId ?? account?.id ?? '', categoryId: v.categoryId || null, ...(categoryOverride ? { categoryOverride: true } : {}),
      note: v.note.trim(), isFixed: v.kind === 'expense' && v.isFixed,
    };
    if (!/^\d+(\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0) return setError('请输入大于 0 的金额，最多保留两位小数。');
    if (!v.date) return setError('请选择有效日期。');
    if (!input.description) return setError('请输入账单名称。');
    if (v.kind === 'transfer' && !v.direction && t?.kind !== 'transfer') return setError('请选择转入或转出。');
    const serialized = JSON.stringify(input);
    if (submission.current.payload && submission.current.payload !== serialized) submission.current.key = crypto.randomUUID();
    submission.current.payload = serialized;
    setBusy(true);
    try {
      await api<Transaction>(t ? `/transactions/${t.id}` : '/transactions', {
        method: t ? 'PATCH' : 'POST', body: { ...input, ...(t ? { version: t.version } : {}) },
        ...(t ? {} : { headers: { 'Idempotency-Key': submission.current.key } }),
      });
      toast.success(t ? '账单已更新' : '账单已记下');
      onSaved();
    } catch (cause) { setError(errorMessage(cause)); setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col">
      <SheetHeader className="border-b"><SheetTitle>{t ? '编辑账单' : '记一笔'}</SheetTitle><SheetDescription>{t ? '修改后会保留编辑记录。' : '手动记录一笔收支。'}</SheetDescription></SheetHeader>
      <div className="flex flex-col gap-5 p-4">
        <ErrorState message={error} />
        <ToggleGroup type="single" variant="outline" className="w-full" value={v.kind} disabled={busy}
          onValueChange={value => value && value !== v.kind && (set({ kind: value as TransactionKind, categoryId: '', ...(value !== 'expense' ? { isFixed: false } : {}) }), setCategoryOverride(false))}>
          {(['expense', 'income', 'refund', 'transfer'] as TransactionKind[]).map(kind => <ToggleGroupItem key={kind} value={kind} className="flex-1">{kind === 'transfer' ? '转账' : KIND_LABELS[kind]}</ToggleGroupItem>)}
        </ToggleGroup>
        <FieldGroup className="gap-4">
          <Field>
            <FieldLabel htmlFor="tx-description">名称</FieldLabel>
            <Input id="tx-description" value={v.description} onChange={e => set({ description: e.target.value })} placeholder="例如：午餐、工资" maxLength={300} required disabled={busy} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="tx-amount">金额</FieldLabel>
              <InputGroup>
                <InputGroupAddon><InputGroupText>¥</InputGroupText></InputGroupAddon>
                <InputGroupInput id="tx-amount" inputMode="decimal" autoComplete="off" placeholder="0.00" className="tabular-nums" value={v.amount} onChange={e => set({ amount: e.target.value })} maxLength={15} autoFocus required disabled={busy} />
              </InputGroup>
            </Field>
            <Field>
              <FieldLabel htmlFor="tx-date">日期</FieldLabel>
              <DatePicker id="tx-date" value={v.date} onChange={date => set({ date })} min="1970-01-01" max="2199-12-31" disabled={busy} />
            </Field>
          </div>
          {v.kind === 'transfer' && (
            <Field>
              <FieldLabel>资金方向</FieldLabel>
              <Select value={v.direction} onValueChange={value => { set({ direction: value as TransferDirection, categoryId: '' }); setCategoryOverride(false); }} disabled={busy}>
                <SelectTrigger className="w-full"><SelectValue placeholder="选择转入或转出" /></SelectTrigger>
                <SelectContent><SelectItem value="inflow">转入，计入收入</SelectItem><SelectItem value="outflow">转出，计入支出</SelectItem></SelectContent>
              </Select>
            </Field>
          )}
          {(v.kind === 'expense' || v.kind === 'income') && (
            <Field>
              <FieldLabel>分类</FieldLabel>
              <Select value={v.categoryId || NONE} onValueChange={value => { set({ categoryId: value === NONE ? '' : value }); setCategoryOverride(true); }} disabled={busy}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>未分类</SelectItem>
                  {categories.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
          )}
          {v.kind === 'expense' && (
            <Field orientation="horizontal" className="rounded-lg border p-3">
              <div className="grid flex-1 gap-0.5"><FieldLabel htmlFor="tx-fixed">固定支出</FieldLabel><span className="text-xs text-muted-foreground">房租、会员等每月固定的花费，单独列出，不计入日常支出</span></div>
              <Switch id="tx-fixed" checked={v.isFixed} onCheckedChange={isFixed => set({ isFixed })} disabled={busy} />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="tx-note">备注</FieldLabel>
            <Input id="tx-note" value={v.note} onChange={e => set({ note: e.target.value })} placeholder="补充这笔账的细节" maxLength={2000} disabled={busy} />
          </Field>
          {t && (
            <Collapsible>
              <CollapsibleTrigger className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
                更多信息<ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 grid gap-4">
                <Field><FieldLabel htmlFor="tx-time">交易时间</FieldLabel><Input id="tx-time" type="time" step="1" value={v.time} onChange={e => set({ time: e.target.value })} disabled={busy} /></Field>
                <Field><FieldLabel htmlFor="tx-counterparty">交易对方</FieldLabel><Input id="tx-counterparty" value={v.counterparty} onChange={e => set({ counterparty: e.target.value })} maxLength={200} disabled={busy} /></Field>
              </CollapsibleContent>
            </Collapsible>
          )}
        </FieldGroup>
      </div>
      <SheetFooter className="mt-auto flex-row justify-end border-t">
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>取消</Button>
        <Button type="submit" disabled={busy || !account}>{busy && <Spinner />}{t ? '保存修改' : '保存账单'}</Button>
      </SheetFooter>
    </form>
  );
}
