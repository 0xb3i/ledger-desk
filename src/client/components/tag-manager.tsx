import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { TAG_ICON_OPTIONS, type Category, type Tag, type TagIcon, type TagRule } from '../../shared/contracts';
import { api, errorMessage } from '@/lib/api';
import { useApp } from '@/lib/app';
import { TAG_ICONS, TagTile } from '@/lib/category';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { HelpHint } from '@/components/help-hint';
import { byPosition } from '../../shared/tags';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/* 二级标签：挂在当前类目下，关键词命中账单名称或对方时细分到该标签；从上到下匹配，靠上的优先 */
export function TagManager({ category }: { category: Category }) {
  const { bootstrap, refresh } = useApp();
  const tags = (bootstrap.tags ?? []).filter(t => t.categoryId === category.id).sort(byPosition);
  const rules = bootstrap.tagRules ?? [];
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Tag | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(task: () => Promise<unknown>, message?: string) {
    if (busy) return false;
    setBusy(true);
    try { await task(); if (message) toast.success(message); refresh(); return true; }
    catch (cause) { toast.error(errorMessage(cause)); return false; }
    finally { setBusy(false); }
  }

  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b px-4 py-3.5 [.border-b]:pb-3.5">
        <CardTitle className="flex items-center gap-2 text-base">二级标签<Badge variant="secondary" className="tabular-nums">{tags.length}</Badge>
          <HelpHint>「{category.name}」的账单名称包含关键词时细分到对应标签。同时命中多个时，更具体的关键词优先（如「美团App团购」优先于「美团App」），其余以排在上面的为准；没命中的归入「其他」。单笔账单可在详情里手动改。</HelpHint>
        </CardTitle>
        <CardAction>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" disabled={busy} onClick={() => setAdding(true)}><Plus />添加标签</Button>
        </CardAction>
      </CardHeader>
      {adding && (
        <InlineInput placeholder="标签名称，例如 外卖" busy={busy} onCancel={() => setAdding(false)}
          onSubmit={name => run(() => api('/tags', { method: 'POST', body: { name, categoryId: category.id } }), `已添加标签「${name}」`).then(ok => ok && setAdding(false))} />
      )}
      {tags.length ? (
        <div role="list" className="divide-y divide-border">
          {tags.map((tag, index) => <TagRow key={tag.id} tag={tag} rules={rules.filter(r => r.tagId === tag.id)} busy={busy} run={run} onRemove={() => setRemoving(tag)}
            first={index === 0} last={index === tags.length - 1}
            onMove={direction => run(() => api(`/tags/${encodeURIComponent(tag.id)}/move`, { method: 'POST', body: { direction } }))} />)}
        </div>
      ) : !adding && (
        <p className="px-4 py-4 text-xs leading-relaxed text-muted-foreground">还没有二级标签。比如在「餐饮」下添加「外卖」，再填上 饿了么、美团App 等关键词。</p>
      )}
      <AlertDialog open={!!removing} onOpenChange={o => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除标签「{removing?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>它的关键词会一起删除。账单本身不受影响，只是不再显示这个标签。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => removing && run(() => api(`/tags/${encodeURIComponent(removing.id)}`, { method: 'DELETE', body: { version: removing.version } }), '标签已删除')}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function TagRow({ tag, rules, busy, run, onRemove, onMove, first, last }: {
  tag: Tag; rules: TagRule[]; busy: boolean; run: (task: () => Promise<unknown>, message?: string) => Promise<boolean>; onRemove: () => void;
  onMove: (direction: 'up' | 'down') => void; first: boolean; last: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const PREVIEW = 8, shown = expanded || adding ? rules : rules.slice(0, PREVIEW);
  if (renaming) return <InlineInput initial={tag.name} placeholder="标签名称" busy={busy} onCancel={() => setRenaming(false)}
    onSubmit={name => run(() => api(`/tags/${encodeURIComponent(tag.id)}`, { method: 'PATCH', body: { name, version: tag.version } }), '标签已改名').then(ok => ok && setRenaming(false))} />;
  return (
    <div role="listitem" className="group/row px-4 py-3">
      <div className="flex items-center gap-1">
        <IconPicker value={tag.icon} disabled={busy} label={tag.name}
          onChange={icon => run(() => api(`/tags/${encodeURIComponent(tag.id)}`, { method: 'PATCH', body: { icon, version: tag.version } }))} />
        <span className="ml-1.5 text-sm">{tag.name}</span>
        <div className="ml-auto flex items-center gap-0.5 opacity-50 transition-opacity group-hover/row:opacity-100">
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`上移标签：${tag.name}`} disabled={busy || first} onClick={() => onMove('up')}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`下移标签：${tag.name}`} disabled={busy || last} onClick={() => onMove('down')}><ArrowDown /></Button>
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`重命名标签：${tag.name}`} disabled={busy} onClick={() => setRenaming(true)}><Pencil /></Button>
          <Button variant="ghost" size="icon-sm" className="size-7" aria-label={`删除标签：${tag.name}`} disabled={busy} onClick={onRemove}><Trash2 /></Button>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {shown.map(rule => (
          <span key={rule.id} className="group/kw inline-flex h-6 items-center gap-0.5 rounded-md bg-muted pl-2 pr-1 text-[13px] text-foreground/80">
            {rule.keyword}{rule.matchType === 'exact' && <span className="text-xs text-muted-foreground">（完全一致）</span>}
            <button type="button" aria-label={`删除关键词：${rule.keyword}`} disabled={busy}
              onClick={() => run(() => api(`/tag-rules/${encodeURIComponent(rule.id)}`, { method: 'DELETE', body: { version: rule.version } }))}
              className="grid size-4 place-items-center rounded text-muted-foreground/60 transition-colors hover:bg-background hover:text-foreground">
              <X className="size-3" />
            </button>
          </span>
        ))}
        {rules.length > PREVIEW && (
          <button type="button" onClick={() => setExpanded(!expanded)}
            className="inline-flex h-6 items-center rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {expanded ? '收起' : `+${rules.length - PREVIEW}`}
          </button>
        )}
        {adding ? (
          <KeywordInput busy={busy} onCancel={() => setAdding(false)}
            onSubmit={keyword => run(() => api('/tag-rules', { method: 'POST', body: { tagId: tag.id, keyword } })).then(ok => ok && setAdding(false))} />
        ) : (
          <button type="button" disabled={busy} onClick={() => setAdding(true)}
            className="inline-flex h-6 items-center gap-0.5 rounded-md border border-dashed px-2 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground">
            <Plus className="size-3" />关键词
          </button>
        )}
      </div>
    </div>
  );
}

/* 点标签图标弹出图标网格，可按名称搜索；选中即保存 */
function IconPicker({ value, label, disabled, onChange }: { value: TagIcon; label: string; disabled: boolean; onChange: (icon: TagIcon) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const icons = TAG_ICON_OPTIONS.filter(icon => !query.trim() || `${icon.label} ${icon.value}`.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setQuery(''); }}>
      <PopoverTrigger asChild>
        <button type="button" disabled={disabled} aria-label={`更换「${label}」的图标`} title="更换图标"
          className="rounded-md outline-none transition-shadow hover:ring-2 hover:ring-ring/30 focus-visible:ring-2 focus-visible:ring-ring/50">
          <TagTile tag={{ icon: value }} className="size-7 [&_svg]:size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索图标，如水果" aria-label="搜索图标" className="mb-2 h-8 text-sm" />
        {icons.length ? <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto">
          {icons.map(icon => {
            const Icon = TAG_ICONS[icon.value];
            return <Button key={icon.value} type="button" variant={value === icon.value ? 'default' : 'ghost'} size="icon-sm" title={icon.label} aria-label={`选择${icon.label}图标`}
              aria-pressed={value === icon.value} onClick={() => { setOpen(false); if (icon.value !== value) onChange(icon.value); }}><Icon /></Button>;
          })}
        </div> : <p className="px-1 py-2 text-xs text-muted-foreground">没有匹配的图标。</p>}
      </PopoverContent>
    </Popover>
  );
}

function KeywordInput({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); };
  return (
    <form onSubmit={submit} className="inline-flex">
      <Input autoFocus value={value} maxLength={100} disabled={busy} placeholder="关键词，回车保存" aria-label="新关键词"
        onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Escape' && onCancel()} onBlur={() => !value.trim() && onCancel()}
        className="h-6 w-36 px-2 text-[13px]" />
    </form>
  );
}

function InlineInput({ initial = '', placeholder, busy, onSubmit, onCancel }: {
  initial?: string; placeholder: string; busy: boolean; onSubmit: (value: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const submit = (event: FormEvent) => { event.preventDefault(); if (value.trim()) onSubmit(value.trim()); };
  return (
    <form onSubmit={submit} className="flex items-center gap-2 border-b px-4 py-2.5 last:border-b-0">
      <Input autoFocus value={value} maxLength={30} disabled={busy} placeholder={placeholder} aria-label={placeholder}
        onChange={e => setValue(e.target.value)} onKeyDown={e => e.key === 'Escape' && onCancel()} className="h-8 flex-1 text-sm" />
      <Button type="button" variant="ghost" size="sm" className="h-8" disabled={busy} onClick={onCancel}>取消</Button>
      <Button type="submit" size="sm" className="h-8" disabled={busy || !value.trim()}>保存</Button>
    </form>
  );
}
