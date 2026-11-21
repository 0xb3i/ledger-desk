import { useRef, useState, type FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { WishlistInput, WishlistItem } from '../../shared/contracts';
import { api, errorMessage, RequestError } from '@/lib/api';
import { centsToDecimal } from '@/lib/format';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@/components/ui/input-group';
import { ErrorState } from './states';

const values = (item: WishlistItem | null) => ({
  title: item?.title ?? '', brand: item?.brand ?? '', amount: item?.amountCents == null ? '' : centsToDecimal(item.amountCents), note: item?.note ?? '',
});

/* 心愿：添加、编辑、移除与恢复；版本冲突时可读取最新版本 */
export function WishDialog({ item, onClose, onSaved }: { item: WishlistItem | null; onClose: () => void; onSaved: () => void }) {
  const [current, setCurrent] = useState(item);
  const [draft, setDraft] = useState(() => values(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [removing, setRemoving] = useState(false);
  const createId = useRef(crypto.randomUUID());
  const dirty = JSON.stringify(draft) !== JSON.stringify(values(current));
  const deleted = Boolean(current?.deletedAt);

  function failed(cause: unknown) {
    setError(errorMessage(cause));
    setConflict(cause instanceof RequestError && cause.status === 409);
  }
  async function run(task: () => Promise<string>) {
    if (busy) return;
    setBusy(true); setError(''); setConflict(false);
    try { toast.success(await task()); onSaved(); } catch (cause) { failed(cause); } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try {
      const latest = await api<WishlistItem>(`/wishlist/${current?.id ?? createId.current}`);
      setCurrent(latest); setDraft(values(latest)); setConflict(false); setError(''); setRemoving(false);
    } catch (cause) { failed(cause); } finally { setBusy(false); }
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (busy || deleted) return;
    const input: WishlistInput = { ...draft, amount: draft.amount.trim() || null };
    if (input.amount !== null && (!/^\d+(\.\d{1,2})?$/.test(input.amount) || Number(input.amount) <= 0)) {
      setError('请输入大于 0 的估价，最多保留两位小数。');
      return;
    }
    void run(async () => {
      await api<WishlistItem>(current ? `/wishlist/${current.id}` : '/wishlist', {
        method: current ? 'PUT' : 'POST', body: { ...input, ...(current ? { version: current.version } : { id: createId.current }) },
      });
      return current ? '心愿已更新' : '心愿已添加';
    });
  };
  const removeOrRestore = () => current && run(async () => {
    await api<WishlistItem>(`/wishlist/${current.id}${deleted ? '/restore' : ''}`, { method: deleted ? 'POST' : 'DELETE', body: { version: current.version } });
    return deleted ? '心愿已恢复' : '心愿已移除，可在已移除中恢复';
  });
  const reloadButton = conflict && <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void reload()}>读取最新版本</Button>;

  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        {removing ? <>
          <DialogHeader><DialogTitle>移除「{current?.title}」？</DialogTitle><DialogDescription>移除后仍可在「已移除」中恢复。</DialogDescription></DialogHeader>
          <ErrorState message={error} />{reloadButton}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => { setRemoving(false); setError(''); }}>保留心愿</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void removeOrRestore()}>{busy && <Spinner />}确认移除</Button>
          </DialogFooter>
        </> : <form onSubmit={save} className="grid gap-5">
          <DialogHeader>
            <DialogTitle>{deleted ? '已移除的心愿' : current ? '编辑心愿' : '添加心愿'}</DialogTitle>
            <DialogDescription>{deleted ? '恢复后会回到原来的清单。' : '想买的先记下来，过几天再看还想不想要。'}</DialogDescription>
          </DialogHeader>
          <ErrorState message={error} />{reloadButton}
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="wish-title">想买什么</FieldLabel>
              <Input id="wish-title" autoFocus required maxLength={200} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} placeholder="商品名称" disabled={busy || deleted} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor="wish-brand">品牌（选填）</FieldLabel>
              <Input id="wish-brand" maxLength={100} value={draft.brand} onChange={e => setDraft({ ...draft, brand: e.target.value })} placeholder="例如 Charles & Keith" disabled={busy || deleted} />
            </Field>
            <Field>
              <FieldLabel htmlFor="wish-amount">预计价格（选填）</FieldLabel>
              <InputGroup>
                <InputGroupAddon><InputGroupText>¥</InputGroupText></InputGroupAddon>
                <InputGroupInput id="wish-amount" inputMode="decimal" maxLength={14} pattern="(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?" title="填写大于零的金额，最多两位小数"
                  className="tabular-nums" value={draft.amount} onChange={e => setDraft({ ...draft, amount: e.target.value })} disabled={busy || deleted} />
              </InputGroup>
            </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="wish-note">备注（选填）</FieldLabel>
              <Textarea id="wish-note" rows={4} maxLength={2000} value={draft.note} onChange={e => setDraft({ ...draft, note: e.target.value })} placeholder="喜欢的原因、型号或想等的价格" disabled={busy || deleted} />
              <FieldDescription>记下为什么想要，过几天回来看会很有用。</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="sm:justify-between">
            {current && !deleted ? <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => setRemoving(true)}><Trash2 />移除</Button> : <span />}
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
              {deleted ? <Button type="button" disabled={busy} onClick={() => void removeOrRestore()}>{busy && <Spinner />}恢复心愿</Button>
                : <Button type="submit" disabled={busy || !draft.title.trim() || Boolean(current && !dirty)}>{busy && <Spinner />}{current ? '保存修改' : '添加心愿'}</Button>}
            </div>
          </DialogFooter>
        </form>}
      </DialogContent>
    </Dialog>
  );
}
