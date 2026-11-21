import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, CalendarRange, Check, CircleAlert, Eye, Mail, RefreshCw, Settings2, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import {
  getTransactionCashflowKind,
  KIND_LABELS,
  TRANSACTION_KINDS,
  type Backup,
  type BackupRestoreResult,
  type MailIssueDetail,
  type MailSyncIssue,
  type MailSyncStatus,
  type Transaction,
  type TransactionKind,
  type TransferDirection,
} from '../../shared/contracts';
import { api, errorMessage, useResource } from '@/lib/api';
import { useApp } from '@/lib/app';
import { dateInShanghai, money } from '@/lib/format';
import { CategoryDot } from '@/lib/category';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { PageHeader } from '@/components/page-header';
import { syncNow } from '@/components/site-header';
import { ErrorState, PageLoading } from '@/components/states';

const syncTime = (value: string) => new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai' }).format(new Date(value));
const BACKUP_VERSIONS = [1, 2, 3, 4, 5, 6, 7];

function shiftIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export default function Settings() {
  return <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
    <PageHeader title="同步与备份" desc="从 QQ 邮箱自动同步招行账单，并管理本机数据备份。" />
    <MailSyncCard />
    <BackupCard />
  </div>;
}

/* ---------- QQ 邮箱账单同步 ---------- */
function MailSyncCard() {
  const { sync, refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [dismissingKey, setDismissingKey] = useState('');
  const [dismissAllOpen, setDismissAllOpen] = useState(false);
  const [dismissAllBusy, setDismissAllBusy] = useState(false);
  const [activeIssue, setActiveIssue] = useState<MailSyncIssue | null>(null);
  const [error, setError] = useState('');
  const [configOpen, setConfigOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const status = sync.data;

  async function runSync() {
    setBusy(true); setError('');
    try {
      const result = await syncNow();
      refresh();
      if (result.lastError) setError(result.lastError);
      else toast.success(result.syncing ? '正在从 QQ 邮箱同步账单。' : 'QQ 邮箱账单已同步。');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  async function dismissIssue(issue: MailSyncIssue) {
    const key = `${issue.uidValidity}:${issue.uid}`;
    setDismissingKey(key); setError('');
    try {
      await api<MailSyncStatus>(`/integrations/mail/issues/${issue.uidValidity}/${issue.uid}/dismiss`, { method: 'POST', body: {} });
      refresh();
      toast.success('已忽略该邮件提醒。');
    } catch (cause) { setError(errorMessage(cause)); } finally { setDismissingKey(''); }
  }

  async function dismissAllIssues() {
    setDismissAllBusy(true); setError('');
    try {
      await api<MailSyncStatus>('/integrations/mail/issues/dismiss-all', { method: 'POST', body: {} });
      setDismissAllOpen(false);
      refresh();
      toast.success('已忽略全部待处理邮件提醒。');
    } catch (cause) { setError(errorMessage(cause)); } finally { setDismissAllBusy(false); }
  }

  const syncing = busy || status?.syncing;
  const progress = status?.progress;
  const Icon = syncing ? Spinner : status?.lastError || !status?.configured ? Mail : status?.lastSuccessAt ? Check : RefreshCw;
  const title = !status?.configured
    ? '尚未连接 QQ 邮箱'
    : syncing ? (progress && progress.total > 0 ? `正在读取招行邮件（${progress.processed}/${progress.total}）` : '正在读取招行邮件')
      : status.lastError ? '同步需要处理'
        : `已连接 ${status.email}`;
  const subtitle = syncing
    ? (progress && progress.total > 0 ? `已入账 ${progress.imported} 笔，每批拉取后实时写入本地账本…` : '正在检索招行提醒邮件，请稍候…')
    : status?.lastError || (status?.lastSuccessAt ? `上次同步成功于 ${syncTime(status.lastSuccessAt)}` : '');

  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="border-b pb-4 [.border-b]:pb-4">
        <CardTitle>QQ 邮箱同步</CardTitle>
        <CardDescription>每 5 分钟只读检查招行提醒邮件，不改变邮件已读状态。</CardDescription>
        {status?.configured && <CardAction className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={Boolean(syncing)} onClick={() => setBackfillOpen(true)}><CalendarRange />按日期补扫</Button>
          <Button variant="outline" size="sm" disabled={Boolean(syncing)} onClick={() => setConfigOpen(true)}><Settings2 />配置</Button>
          <Button size="sm" disabled={Boolean(syncing)} onClick={runSync}>{syncing ? <Spinner /> : <RefreshCw />}{syncing ? '正在同步' : '立即同步'}</Button>
        </CardAction>}
      </CardHeader>
      {sync.loading && !status ? <PageLoading label="正在读取同步状态" /> : sync.error ? <div className="p-4"><ErrorState message={sync.error} retry={refresh} /></div> : status && <>
        <CardContent className="grid gap-5 py-5">
          <div className="flex items-center gap-3">
            <span className={cn('grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5', status.lastError && 'bg-brand-soft text-brand', !status.lastError && status.lastSuccessAt && 'bg-success/10 text-success')}><Icon /></span>
            <div className="grid gap-0.5">
              <span className="text-base">{title}</span>
              {subtitle && <span className={cn('text-sm text-muted-foreground', !syncing && status.lastError && 'text-brand')}>
                {subtitle}
              </span>}
            </div>
          </div>

          {!status.configured ? (
            <InlineMailSetup status={status} onConnected={() => { refresh(); toast.success('QQ 邮箱已连接并完成首次同步。'); }} />
          ) : (
            <dl className="grid grid-cols-2 gap-3 rounded-lg bg-[#fafafb] p-3 text-sm sm:grid-cols-3">
              <div><dt className="text-xs text-muted-foreground">已导入账单</dt><dd className="tabular-nums">{status.recordCount} 笔</dd></div>
              <div><dt className="text-xs text-muted-foreground">同步起点</dt><dd className="tabular-nums">{status.syncStartDate}</dd></div>
              <div>
                <dt className="text-xs text-muted-foreground">{status.lastError && status.lastSyncAt ? '最近尝试' : '已跳过重复'}</dt>
                <dd className="tabular-nums">{status.lastError && status.lastSyncAt ? syncTime(status.lastSyncAt) : `${status.skippedExistingCount} 笔`}</dd>
              </div>
            </dl>
          )}

          <ErrorState message={error} />
        </CardContent>

        {Boolean(status.issues?.length) && <section aria-label="待处理邮件">
          <div className="flex items-center gap-2 border-y bg-[#fafafb] px-6 py-2 text-xs text-muted-foreground">
            <span>待核对邮件</span>
            <Badge variant="secondary" className="bg-brand-soft text-brand tabular-nums">{status.issues.length} 封</Badge>
            <span className="hidden text-muted-foreground/80 sm:inline">核对一封后，其余同类邮件会自动入账</span>
            {status.issues.length > 1 && <Button variant="ghost" size="sm" className="ml-auto h-7 px-2 text-xs text-muted-foreground" disabled={Boolean(syncing || dismissAllBusy)} onClick={() => setDismissAllOpen(true)}>全部忽略</Button>}
          </div>
          <ItemGroup className="[&>*]:border-b [&>*]:border-b-border">
            {status.issues.map(issue => {
              const key = `${issue.uidValidity}:${issue.uid}`;
              const busyItem = dismissingKey === key;
              return (
                <Item key={key} size="sm" className="rounded-none px-6">
                  <ItemMedia variant="icon" className="border-brand/20 bg-brand-soft text-brand"><CircleAlert /></ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle className="flex flex-wrap items-center gap-2">
                      <span>{issue.subject}</span>
                      {issue.mailDate && <span className="text-xs font-normal text-muted-foreground tabular-nums">{syncTime(issue.mailDate)}</span>}
                    </ItemTitle>
                    <ItemDescription className="text-xs">{issue.message}</ItemDescription>
                  </ItemContent>
                  <ItemActions className="flex gap-1.5">
                    <Button variant="outline" size="sm" disabled={Boolean(busyItem || syncing)} onClick={() => setActiveIssue(issue)}>
                      <Eye />核对
                    </Button>
                    <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={Boolean(busyItem || syncing)} onClick={() => dismissIssue(issue)}>
                      {busyItem && <Spinner />}忽略
                    </Button>
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </section>}
      </>}
      {status && configOpen && <MailConfigDialog status={status} onClose={() => setConfigOpen(false)} onUpdated={() => { setConfigOpen(false); refresh(); }} />}
      {status && backfillOpen && <BackfillDialog status={status} onClose={() => setBackfillOpen(false)} onCompleted={() => { setBackfillOpen(false); refresh(); }} />}
      {status && activeIssue && <MailIssueDialog key={`${activeIssue.uidValidity}:${activeIssue.uid}`} issue={activeIssue} accountId={status.accountId}
        onClose={() => setActiveIssue(null)}
        onResolved={message => { setActiveIssue(null); refresh(); toast.success(message); }} />}
      <Dialog open={dismissAllOpen} onOpenChange={open => !open && !dismissAllBusy && setDismissAllOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>忽略全部待处理邮件？</DialogTitle>
            <DialogDescription>将忽略当前 {status?.issues.length ?? 0} 封未能自动解析的邮件提醒，不会删除 QQ 邮箱原邮件；以后仍可通过「按日期补扫」重新检查。</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={dismissAllBusy} onClick={() => setDismissAllOpen(false)}>取消</Button>
            <Button disabled={dismissAllBusy} onClick={dismissAllIssues}>{dismissAllBusy && <Spinner />}全部忽略</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function MailIssueDialog({ issue, accountId, onClose, onResolved }: {
  issue: MailSyncIssue; accountId: string; onClose: () => void; onResolved: (message: string) => void;
}) {
  const { bootstrap } = useApp();
  const [revision, setRevision] = useState(0);
  const detail = useResource<MailIssueDetail>(`/integrations/mail/issues/${issue.uidValidity}/${issue.uid}`, revision, { keepOnRefresh: true });
  const [initialized, setInitialized] = useState(false);
  const [kind, setKind] = useState<TransactionKind>('expense');
  const [direction, setDirection] = useState<TransferDirection | ''>('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(dateInShanghai(issue.mailDate ? new Date(issue.mailDate) : new Date()));
  const [time, setTime] = useState('12:00');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const data = detail.data;
    if (!data || initialized) return;
    setInitialized(true);
    setKind(data.draft.kind);
    setDirection(data.draft.transferDirection ?? '');
    setAmount(data.draft.amount ?? '');
    setDescription(data.draft.description);
    if (data.draft.occurredAt) {
      setDate(data.draft.occurredAt.slice(0, 10));
      setTime(data.draft.occurredAt.slice(11, 16));
    }
  }, [detail.data, initialized]);

  const flow = getTransactionCashflowKind({ kind, transferDirection: kind === 'transfer' ? direction || null : null });
  const categoryKind = flow === 'refund' ? 'expense' : flow;
  const categories = bootstrap.categories.filter(c => c.kind === 'both' || c.kind === categoryKind);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (kind === 'transfer' && !direction) { setError('请选择转账方向（转入或转出）。'); return; }
    setBusy('save'); setError('');
    try {
      const res = await api<{ transaction: Transaction; autoResolvedCount?: number; status: MailSyncStatus }>(`/integrations/mail/issues/${issue.uidValidity}/${issue.uid}/record`, {
        method: 'POST',
        body: {
          accountId,
          kind,
          ...(kind === 'transfer' && direction ? { transferDirection: direction } : {}),
          amount: amount.trim(),
          occurredAt: `${date}T${time.length === 5 ? time : '12:00'}:00+08:00`,
          description: description.trim(),
          categoryId: categoryId || null,
          ...(categoryId ? { categoryOverride: true } : {}),
          note: note.trim(),
        },
      });
      onResolved(res.autoResolvedCount ? `已确认入账，并自动处理其余 ${res.autoResolvedCount} 封同类邮件` : '已确认入账');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(null); }
  }

  async function dismiss() {
    setBusy('dismiss'); setError('');
    try {
      await api<MailSyncStatus>(`/integrations/mail/issues/${issue.uidValidity}/${issue.uid}/dismiss`, { method: 'POST', body: {} });
      onResolved('已忽略这封邮件提醒');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(null); }
  }

  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>核对邮件账单</DialogTitle>
          <DialogDescription>
            {issue.mailDate ? `${syncTime(issue.mailDate)} · ` : ''}确认一次后，其余同类待核对邮件将自动入账
          </DialogDescription>
        </DialogHeader>
        {detail.loading && !detail.data ? <PageLoading label="正在读取邮件原文…" /> : detail.error ? (
          <ErrorState message={detail.error} retry={() => setRevision(v => v + 1)} />
        ) : detail.data && (
          <form className="grid gap-4" onSubmit={save}>
            <div className="max-h-36 overflow-y-auto rounded-lg border border-border/80 bg-[#fafafb] px-3.5 py-2.5 text-xs leading-relaxed text-foreground/80 whitespace-pre-wrap select-text">
              {detail.data.body}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Tabs value={kind} onValueChange={v => {
                if (!v) return;
                const next = v as TransactionKind;
                setKind(next);
                setCategoryId('');
                if (next !== 'transfer') setDirection('');
              }}>
                <TabsList>
                  {TRANSACTION_KINDS.map(item => <TabsTrigger key={item} value={item}>{KIND_LABELS[item]}</TabsTrigger>)}
                </TabsList>
              </Tabs>
              {kind === 'transfer' && (
                <Tabs value={direction} onValueChange={v => v && setDirection(v as TransferDirection)}>
                  <TabsList>
                    <TabsTrigger value="outflow">转出</TabsTrigger>
                    <TabsTrigger value="inflow">转入</TabsTrigger>
                  </TabsList>
                </Tabs>
              )}
            </div>

            <div className="grid gap-3.5 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label htmlFor="issue-desc">名称</Label>
                <Input id="issue-desc" required value={description} onChange={e => setDescription(e.target.value)} disabled={Boolean(busy)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="issue-amount">金额</Label>
                <Input id="issue-amount" required placeholder="0.00" className="tabular-nums" value={amount} onChange={e => setAmount(e.target.value)} disabled={Boolean(busy)} />
              </div>
              {(kind === 'expense' || kind === 'income') && (
                <div className="grid gap-1.5">
                  <Label>分类</Label>
                  <Select value={categoryId || '__none__'} onValueChange={v => setCategoryId(v === '__none__' ? '' : v)} disabled={Boolean(busy)}>
                    <SelectTrigger className="w-full"><SelectValue placeholder="未分类" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">未分类</SelectItem>
                      {categories.map(c => (
                        <SelectItem key={c.id} value={c.id}>
                          <span className="flex items-center gap-2"><CategoryDot color={c.color} className="size-1.5" />{c.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className={cn('grid gap-1.5', (kind === 'transfer' || kind === 'refund') && 'sm:col-span-2')}>
                <Label htmlFor="issue-note">备注</Label>
                <Input id="issue-note" placeholder="选填" value={note} onChange={e => setNote(e.target.value)} disabled={Boolean(busy)} />
              </div>
            </div>

            <ErrorState message={error} />
            <DialogFooter className="flex-col gap-2 pt-1 sm:flex-row sm:justify-between">
              <Button type="button" variant="ghost" className="text-muted-foreground" disabled={Boolean(busy)} onClick={dismiss}>
                {busy === 'dismiss' && <Spinner />}忽略此邮件
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={onClose}>取消</Button>
                <Button type="submit" disabled={Boolean(busy) || !amount.trim() || !description.trim()}>
                  {busy === 'save' && <Spinner />}确认入账
                </Button>
              </div>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function InlineMailSetup({ status, onConnected }: { status: MailSyncStatus; onConnected: () => void }) {
  const [email, setEmail] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [syncStartDate, setSyncStartDate] = useState(status.suggestedStartDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setSyncStartDate(prev => prev || status.suggestedStartDate);
  }, [status.suggestedStartDate]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await api<MailSyncStatus>('/integrations/mail/config', {
        method: 'POST',
        body: { email: email.trim(), authCode: authCode.trim(), syncStartDate },
      });
      setAuthCode('');
      onConnected();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <p className="rounded-lg bg-[#fafafb] px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
        在 QQ 邮箱网页版「设置 → 账号」开启 IMAP 服务获取 16 位授权码（非登录密码），授权码仅保存在 macOS 钥匙串。
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="qq-email">QQ 邮箱</Label>
          <Input id="qq-email" type="email" required placeholder="例如 name@qq.com" value={email} onChange={e => setEmail(e.target.value)} disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="qq-auth-code">16 位授权码</Label>
          <Input id="qq-auth-code" type="password" required autoComplete="off" placeholder="粘贴授权码" value={authCode} onChange={e => setAuthCode(e.target.value)} disabled={busy} />
        </div>
      </div>
      <div className="grid gap-1.5 sm:max-w-xs">
        <Label htmlFor="qq-start-date">同步起点</Label>
        <Input id="qq-start-date" type="date" required value={syncStartDate} onChange={e => setSyncStartDate(e.target.value)} disabled={busy} />
        <p className="text-xs text-muted-foreground">已有账单会自动去重，不会重复入账。</p>
      </div>
      <ErrorState message={error} />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || !email.trim() || !authCode.trim()}>
          {busy ? <Spinner /> : <Mail />}{busy ? '正在连接…' : '连接 QQ 邮箱'}
        </Button>
      </div>
    </form>
  );
}

function MailConfigDialog({ status, onClose, onUpdated }: { status: MailSyncStatus; onClose: () => void; onUpdated: () => void }) {
  const [email, setEmail] = useState(status.email ?? '');
  const [authCode, setAuthCode] = useState('');
  const [syncStartDate, setSyncStartDate] = useState(status.syncStartDate ?? status.suggestedStartDate);
  const [busy, setBusy] = useState<'save' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy('save'); setError('');
    try {
      const body: Record<string, string> = { email: email.trim(), syncStartDate };
      if (authCode.trim()) body.authCode = authCode.trim();
      await api<MailSyncStatus>('/integrations/mail/config', { method: 'POST', body });
      toast.success('QQ 邮箱配置已更新。');
      onUpdated();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(null); }
  }

  async function disconnect() {
    if (busy) return;
    setBusy('disconnect'); setError('');
    try {
      await api<MailSyncStatus>('/integrations/mail/config', { method: 'DELETE' });
      toast.success('已断开 QQ 邮箱连接，并移除钥匙串授权码；本地账目已保留。');
      onUpdated();
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(null); }
  }

  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>QQ 邮箱同步配置</DialogTitle>
          <DialogDescription>只读读取收件箱，授权码仅存放在 macOS 钥匙串。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={save}>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-qq-email">QQ 邮箱</Label>
            <Input id="edit-qq-email" type="email" required value={email} onChange={e => setEmail(e.target.value)} disabled={Boolean(busy)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-qq-auth">新授权码（留空则保持不变）</Label>
            <Input id="edit-qq-auth" type="password" autoComplete="off" placeholder="需要更换时再填写" value={authCode} onChange={e => setAuthCode(e.target.value)} disabled={Boolean(busy)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-qq-start">同步起点</Label>
            <Input id="edit-qq-start" type="date" required value={syncStartDate} onChange={e => setSyncStartDate(e.target.value)} disabled={Boolean(busy)} />
          </div>
          <ErrorState message={error} />
          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
            <Button type="button" variant="ghost" className="text-destructive hover:text-destructive" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}>
              {busy === 'disconnect' ? <Spinner /> : <Unplug />}断开邮箱
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={onClose}>取消</Button>
              <Button type="submit" disabled={Boolean(busy)}>{busy === 'save' && <Spinner />}保存并测试</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
      <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>断开 QQ 邮箱？</AlertDialogTitle>
            <AlertDialogDescription>断开后会停止同步并移除已保存的授权码。已入账的记录会保留。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={Boolean(busy)} onClick={disconnect}>确认断开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function BackfillDialog({ status, onClose, onCompleted }: { status: MailSyncStatus; onClose: () => void; onCompleted: () => void }) {
  const today = dateInShanghai(new Date());
  const [startDate, setStartDate] = useState(status.syncStartDate ?? shiftIsoDate(today, -7));
  const [endDate, setEndDate] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const result = await syncNow({ startDate, endDate });
      if (result.lastError) setError(result.lastError);
      else {
        toast.success(`已完成 ${startDate} 至 ${endDate} 的招行邮件补扫。`);
        onCompleted();
      }
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={open => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>按日期补扫邮件</DialogTitle>
          <DialogDescription>重新扫描选定日期的招行邮件，已入账记录会自动跳过。</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={run}>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="backfill-start">开始日期</Label>
              <Input id="backfill-start" type="date" required value={startDate} onChange={e => setStartDate(e.target.value)} disabled={busy} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="backfill-end">结束日期</Label>
              <Input id="backfill-end" type="date" required value={endDate} onChange={e => setEndDate(e.target.value)} disabled={busy} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">若超过 30 天未扫到，请先在 QQ 邮箱中将收取范围设为「全部」。</p>
          <ErrorState message={error} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>取消</Button>
            <Button type="submit" disabled={busy || !startDate || !endDate}>{busy ? <Spinner /> : <CalendarRange />}{busy ? '正在补扫…' : '开始补扫'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- 数据与备份 ---------- */
function BackupCard() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [restore, setRestore] = useState<Backup | null>(null);
  const file = useRef<HTMLInputElement>(null);
  async function download() {
    setBusy('export'); setError('');
    try {
      const data = await api<Backup>('/backup');
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `轻记备份-${dateInShanghai(new Date())}.json`; a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('备份已导出。');
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  async function choose(selected?: File) {
    setError('');
    if (!selected) return;
    try {
      if (selected.size > 8 * 1024 * 1024) throw new Error('备份文件超过 8 MB，请使用本地数据库备份恢复。');
      const data = JSON.parse(await selected.text()) as Record<string, unknown>;
      const ok = data && typeof data === 'object' && data.format === 'personal-dashboard' && BACKUP_VERSIONS.includes(Number(data.schemaVersion))
        && Array.isArray(data.transactions) && Array.isArray(data.accounts) && Array.isArray(data.categories)
        && (Number(data.schemaVersion) < 6 || Array.isArray(data.wishlistItems)) && (Number(data.schemaVersion) < 7 || 'budget' in data);
      if (!ok) throw new Error('请选择从轻记导出的有效备份。');
      setRestore(data as unknown as Backup);
    } catch (cause) { setError(cause instanceof SyntaxError ? '文件不是有效的 JSON 备份。' : errorMessage(cause)); }
    if (file.current) file.current.value = '';
  }
  async function run() {
    if (!restore) return;
    setBusy('restore'); setError('');
    try {
      const r = await api<BackupRestoreResult>('/backup/restore', { method: 'POST', body: restore });
      setRestore(null); refresh();
      const added = [r.inserted && `${r.inserted} 笔账目`, r.wishlistInserted && `${r.wishlistInserted} 项心愿`, r.budgetRestored && '月度预算'].filter(Boolean);
      const kept = [r.skipped && `${r.skipped} 笔账目`, r.wishlistSkipped && `${r.wishlistSkipped} 项心愿`].filter(Boolean);
      toast.success(`恢复完成${added.length ? `，新增 ${added.join('、')}` : ''}${kept.length ? `，保留已有的 ${kept.join('、')}` : ''}。`);
    } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(''); }
  }
  const counts = restore ? [
    restore.transactions.length && `${restore.transactions.length} 笔账目`,
    'wishlistItems' in restore && restore.wishlistItems.length && `${restore.wishlistItems.length} 项心愿`,
    'budget' in restore && restore.budget && `月度预算 ¥${money(restore.budget.amountCents)}`,
  ].filter(Boolean) : [];
  return (
    <Card className="gap-0 pb-0">
      <CardHeader className="border-b pb-4 [.border-b]:pb-4"><CardTitle>数据与备份</CardTitle><CardDescription>数据仅保存在本机，建议定期导出备份。</CardDescription></CardHeader>
      {error && !restore && <div className="px-6 pt-4"><ErrorState message={error} /></div>}
      <ItemGroup className="[&>*+*]:border-t [&>*+*]:border-t-border">
        <Item className="rounded-none px-6">
          <ItemContent><ItemTitle>导出备份</ItemTitle><ItemDescription>包含全部账单、分类、规则、预算与心愿单（不含邮箱授权码）。</ItemDescription></ItemContent>
          <ItemActions><Button size="sm" disabled={Boolean(busy)} onClick={download}>{busy === 'export' ? <Spinner /> : <ArrowDownToLine />}导出备份</Button></ItemActions>
        </Item>
        <Item className="rounded-none px-6">
          <ItemContent><ItemTitle>恢复备份</ItemTitle><ItemDescription>仅补入缺失记录，不覆盖现有数据。</ItemDescription></ItemContent>
          <ItemActions>
            <Button variant="outline" size="sm" disabled={Boolean(busy)} onClick={() => file.current?.click()}><ArrowUpFromLine />选择文件</Button>
            <input ref={file} type="file" className="sr-only" accept=".json,application/json" aria-label="选择轻记备份文件" onChange={e => choose(e.target.files?.[0])} />
          </ItemActions>
        </Item>
      </ItemGroup>
      <Dialog open={!!restore} onOpenChange={open => !open && !busy && (setRestore(null), setError(''))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>恢复数据备份</DialogTitle>
            <DialogDescription>{counts.length ? `此备份包含 ${counts.join('、')}。` : '此备份没有账目、心愿或预算记录。'}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">已有且内容一致的记录会跳过；如与当前记录冲突，会停止恢复并保留现状。</p>
          <ErrorState message={error} />
          <DialogFooter>
            <Button variant="outline" disabled={Boolean(busy)} onClick={() => { setRestore(null); setError(''); }}>取消</Button>
            <Button disabled={Boolean(busy)} onClick={run}>{busy === 'restore' && <Spinner />}恢复缺失记录</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
