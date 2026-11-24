import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  CYCLE_LABELS, REMIND_DAY_OPTIONS, SUBSCRIPTION_CATEGORIES, SUBSCRIPTION_CATEGORY_LABELS, SUBSCRIPTION_CYCLES,
  type Subscription, type SubscriptionCategory, type SubscriptionCycle, type SubscriptionInput,
} from '../../shared/subscriptions';
import { api, errorMessage, RequestError } from '@/lib/api';
import { centsToDecimal, dateLabel } from '@/lib/format';
import { SUBSCRIPTION_ICONS } from '@/lib/subscription';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { DatePicker } from './date-picker';
import { HelpHint } from './help-hint';
import { ErrorState } from './states';

const remindLabel = (days: number) => days === 0 ? '当天' : `提前 ${days} 天`;
const values = (item: Subscription | null) => ({
  name: item?.name ?? '', category: item?.category ?? 'other' as SubscriptionCategory,
  amount: item ? centsToDecimal(item.amountCents).replace(/\.00$/, '') : '', cycle: item?.cycle ?? 'monthly' as SubscriptionCycle,
  date: item?.dueDate ?? '', endDate: item?.endDate ?? '', autoRenew: item?.autoRenew ?? true, remindDays: String(item?.remindDays ?? 7), note: item?.note ?? '', url: item?.url ?? '',
});

/* 订阅：添加、编辑，用「到期日」表示不再续费；版本冲突时可读取最新版本 */
export function SubscriptionDialog({ item, onClose, onSaved }: { item: Subscription | null; onClose: () => void; onSaved: () => void }) {
  const [current, setCurrent] = useState(item);
  const [draft, setDraft] = useState(() => values(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const createId = useRef(crypto.randomUUID());
  const ended = Boolean(current?.endedAt), finished = current?.state === 'finished';
  const dirty = JSON.stringify(draft) !== JSON.stringify(values(current));
  const set = (patch: Partial<typeof draft>) => setDraft(previous => ({ ...previous, ...patch }));
  // 自定义的提醒天数（备份恢复或旧数据）也要能显示
  const remindOptions = [...new Set([...REMIND_DAY_OPTIONS, Number(draft.remindDays)])].sort((a, b) => a - b);

  async function run(task: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setConflict(false);
    try { toast.success(await task()); onSaved(); } catch (cause) {
      setError(errorMessage(cause));
      setConflict(cause instanceof RequestError && cause.status === 409);
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const latest = await api<Subscription>(`/subscriptions/${current?.id ?? createId.current}`);
      setCurrent(latest); setDraft(values(latest)); setConflict(false); setError('');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (busy || ended) return;
    const amount = draft.amount.trim();
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) { setError('请输入大于 0 的金额，最多保留两位小数。'); return; }
    if (!draft.date) { setError('请选择下次扣费日。'); return; }
    if (draft.url.trim() && !/^https?:\/\/\S+$/i.test(draft.url.trim())) { setError('链接需以 http:// 或 https:// 开头。'); return; }
    // 没改日期时保留原锚定日，避免按月推算时把 31 号悄悄改成 30 号
    const nextDueDate = current && draft.date === current.dueDate ? current.nextDueDate : draft.date;
    const input: SubscriptionInput = { name: draft.name.trim(), category: draft.category, amount, cycle: draft.cycle, nextDueDate,
      endDate: draft.endDate || null, autoRenew: draft.autoRenew, remindDays: Number(draft.remindDays), note: draft.note.trim(), url: draft.url.trim() };
    void run(async () => {
      await api<Subscription>(current ? `/subscriptions/${current.id}` : '/subscriptions', {
        method: current ? 'PUT' : 'POST', body: { ...input, ...(current ? { version: current.version } : { id: createId.current }) },
      });
      return current ? `「${input.name}」已更新` : `已添加「${input.name}」`;
    });
  };
  // 旧版本手动结束的项目：恢复续费后才能编辑
  const restore = () => current && run(async () => {
    await api<Subscription>(`/subscriptions/${current.id}/restore`, { method: 'POST', body: { version: current.version } });
    return `「${current.name}」已恢复续费`;
  });
  const disabled = busy || ended;

  const description = ended ? '已停止扣费。'
    : finished ? `已于 ${dateLabel(current!.dueDate, true)} 到期。`
    : current?.state === 'ending' ? `用到 ${dateLabel(current.dueDate, true)} 为止，不再续费。`
    : draft.autoRenew ? '自动扣款的订阅只在这里列出，不提醒。' : '付款日前会在右上角铃铛提醒。';

  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{ended ? '已到期的订阅' : current ? '编辑订阅' : '添加订阅'}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <ErrorState message={error} />
          {conflict && <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void reload()}>读取最新版本</Button>}
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="sub-name">名称</FieldLabel>
              <Input id="sub-name" autoFocus required maxLength={100} value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="房租、iCloud+ 等" disabled={disabled} />
            </Field>
            <Field>
              <FieldLabel htmlFor="sub-url">链接</FieldLabel>
              <Input id="sub-url" type="url" inputMode="url" maxLength={2000} value={draft.url} onChange={e => set({ url: e.target.value })} placeholder="选填，续费或管理页面" disabled={disabled} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel>类别</FieldLabel>
                <Select value={draft.category} onValueChange={value => set({ category: value as SubscriptionCategory })} disabled={disabled}>
                  <SelectTrigger className="w-full" aria-label="类别"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SUBSCRIPTION_CATEGORIES.map(category => {
                      const Icon = SUBSCRIPTION_ICONS[category];
                      return <SelectItem key={category} value={category}><Icon className="text-muted-foreground" />{SUBSCRIPTION_CATEGORY_LABELS[category]}</SelectItem>;
                    })}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-amount">每期金额</FieldLabel>
                <InputGroup>
                  <InputGroupAddon><InputGroupText>¥</InputGroupText></InputGroupAddon>
                  <InputGroupInput id="sub-amount" inputMode="decimal" required maxLength={14} className="tabular-nums" value={draft.amount}
                    onChange={e => set({ amount: e.target.value })} placeholder="0" disabled={disabled} />
                </InputGroup>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel>周期</FieldLabel>
                <Select value={draft.cycle} onValueChange={value => set({ cycle: value as SubscriptionCycle })} disabled={disabled}>
                  <SelectTrigger className="w-full" aria-label="周期"><SelectValue /></SelectTrigger>
                  <SelectContent>{SUBSCRIPTION_CYCLES.map(cycle => <SelectItem key={cycle} value={cycle}>{CYCLE_LABELS[cycle]}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="sub-date">{draft.autoRenew ? '下次扣费日' : '下次付款日'}</FieldLabel>
                <DatePicker id="sub-date" value={draft.date} onChange={date => set({ date })} placeholder="选择日期" max="2199-12-31" disabled={disabled} />
              </Field>
            </div>
            <Field>
              <div className="flex items-center gap-1">
                <FieldLabel>扣款方式</FieldLabel>
                <HelpHint className="max-w-none">
                  <span className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
                    <span className="font-medium">自动扣款</span><span>到日子自动扣，只在这里列出，不提醒</span>
                    <span className="font-medium">手动付款</span><span>到日子前在铃铛提醒，付完点「已付款」</span>
                  </span>
                </HelpHint>
              </div>
              <ToggleGroup type="single" variant="outline" className="w-full" value={draft.autoRenew ? 'auto' : 'manual'} disabled={disabled}
                onValueChange={value => value && set({ autoRenew: value === 'auto' })}>
                <ToggleGroupItem value="auto" className="flex-1">自动扣款</ToggleGroupItem>
                <ToggleGroupItem value="manual" className="flex-1">手动付款</ToggleGroupItem>
              </ToggleGroup>
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <div className="flex items-center gap-1">
                  <FieldLabel htmlFor="sub-end">到期日</FieldLabel>
                  <HelpHint className="max-w-none">
                    <span className="block">用到这天为止，这天及以后不再扣费。</span>
                    <span className="block">例：房租交到 6/30，就填 6/30。</span>
                    <span className="block opacity-70">不填表示一直续。</span>
                  </HelpHint>
                </div>
                <DatePicker id="sub-end" value={draft.endDate} onChange={endDate => set({ endDate })} placeholder="一直续" defaultMonth={draft.date || undefined} max="2199-12-31" clearable disabled={disabled} />
              </Field>
              <Field>
                <FieldLabel>提醒</FieldLabel>
                {draft.autoRenew
                  ? <div className="flex h-9 items-center rounded-md border border-dashed px-3 text-sm text-muted-foreground">自动扣款，不提醒</div>
                  : <Select value={draft.remindDays} onValueChange={remindDays => set({ remindDays })} disabled={disabled}>
                    <SelectTrigger className="w-full" aria-label="提醒"><SelectValue /></SelectTrigger>
                    <SelectContent>{remindOptions.map(days => <SelectItem key={days} value={String(days)}>{remindLabel(days)}</SelectItem>)}</SelectContent>
                  </Select>}
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="sub-note">备注</FieldLabel>
              <Textarea id="sub-note" rows={2} maxLength={500} value={draft.note} onChange={e => set({ note: e.target.value })} placeholder="选填" disabled={disabled} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            {ended ? <Button type="button" disabled={busy} onClick={() => void restore()}>{busy && <Spinner />}恢复续费</Button>
              : <Button type="submit" disabled={busy || !draft.name.trim() || Boolean(current && !dirty)}>{busy && <Spinner />}{current ? '保存' : '添加'}</Button>}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
