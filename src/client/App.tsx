import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { Bootstrap, CategoryRuleInput, MailSyncStatus, Transaction, WishlistItem } from '../shared/contracts';
import { api, errorMessage, useResource } from '@/lib/api';
import { AppContext, PAGES, locationUrl, readLocation, type AppContextValue, type Filters, type Location, type PagePath } from '@/lib/app';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { AppSidebar } from '@/components/app-sidebar';
import { SiteHeader } from '@/components/site-header';
import { ErrorState, PageLoading } from '@/components/states';
import { TransactionSheet } from '@/components/transaction-sheet';
import { WishDialog } from '@/components/wish-dialog';
import { RuleEditor } from '@/components/rule-manager';
const VIEWS = {
  '/overview': lazy(() => import('@/pages/overview')),
  '/transactions': lazy(() => import('@/pages/transactions')),
  '/wishlist': lazy(() => import('@/pages/wishlist')),
  '/categories': lazy(() => import('@/pages/categories')),
  '/settings': lazy(() => import('@/pages/settings')),
} satisfies Record<PagePath, React.ElementType>;

export default function App() {
  const [session, setSession] = useState<{ authenticated: boolean } | null>(null);
  const [sessionError, setSessionError] = useState('');
  useEffect(() => {
    api<{ authenticated: boolean }>('/session').then(setSession).catch(error => setSessionError(errorMessage(error)));
    const expired = () => setSession({ authenticated: false });
    window.addEventListener('session-expired', expired);
    return () => window.removeEventListener('session-expired', expired);
  }, []);
  if (!session?.authenticated) return <SessionGate error={sessionError} expired={Boolean(session)} />;
  return <Workspace />;
}

/* 本机会话：由启动器打开 /local/open 建立；过期时引导重新打开 */
function SessionGate({ error, expired }: { error: string; expired: boolean }) {
  return (
    <div className="grid min-h-screen place-items-center bg-sidebar">
      <div className="grid justify-items-center gap-4 text-center">
        <span className="text-2xl font-medium tracking-tight">轻记<span className="text-brand">.</span></span>
        {error || expired ? <>
          <p className="text-sm text-muted-foreground">{error || '本地连接已过期，请重新打开轻记。'}</p>
          <Button asChild><a href="/local/open">重新打开轻记</a></Button>
        </> : <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />正在打开轻记</p>}
      </div>
    </div>
  );
}

function Workspace() {
  const [location, setLocation] = useState<Location>(readLocation);
  const [revision, setRevision] = useState(0);
  const [syncRevision, setSyncRevision] = useState(0);
  const [transaction, setTransaction] = useState<{ item: Transaction | null } | null>(null);
  const [wish, setWish] = useState<{ item: WishlistItem | null } | null>(null);
  const [ruleDraft, setRuleDraft] = useState<CategoryRuleInput | null>(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const bootstrap = useResource<Bootstrap>('/bootstrap', revision, { keepOnRefresh: true });
  const sync = useResource<MailSyncStatus>('/integrations/mail/status', syncRevision + revision, { keepOnRefresh: true });

  const isSyncing = Boolean(sync.data?.syncing);
  useEffect(() => {
    const onPop = () => setLocation(readLocation());
    const onFocus = () => refresh();
    const timer = window.setInterval(() => setSyncRevision(value => value + 1), isSyncing ? 2_000 : 15_000);
    window.addEventListener('popstate', onPop);
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('popstate', onPop); window.removeEventListener('focus', onFocus); window.clearInterval(timer); };
  }, [refresh, isSyncing]);
  // 后台同步完成后刷新账本数据
  const completion = sync.data && !sync.data.syncing ? `${sync.data.lastSyncAt}:${sync.data.recordCount}` : null;
  const [lastCompletion, setLastCompletion] = useState<string | null>(null);
  useEffect(() => {
    if (!completion || completion === lastCompletion) return;
    if (lastCompletion !== null) refresh();
    setLastCompletion(completion);
  }, [completion, lastCompletion, refresh]);

  const locationRef = useRef(location);
  locationRef.current = location;
  const navigate = useCallback((path: PagePath, filters: Filters = {}, month?: string, replace = false) => {
    const current = locationRef.current, next = { path, month: month ?? current.month, filters };
    window.history[replace ? 'replaceState' : 'pushState']({}, '', locationUrl(next));
    if (path !== current.path) window.scrollTo({ top: 0 });
    setLocation(next);
  }, []);

  if (!bootstrap.data) return bootstrap.error
    ? <div className="p-10"><ErrorState message={bootstrap.error} retry={refresh} /></div>
    : <PageLoading label="正在读取账本" />;

  const value: AppContextValue = {
    location, navigate, bootstrap: bootstrap.data, revision, refresh,
    sync: { data: sync.data, loading: sync.loading, error: sync.error },
    openTransaction: item => setTransaction({ item }),
    openWish: item => setWish({ item }),
    openRule: draft => { setTransaction(null); setRuleDraft(draft); },
  };
  const View = VIEWS[location.path];
  return (
    <AppContext.Provider value={value}>
      <TooltipProvider delayDuration={200}>
        <SidebarProvider style={{ '--sidebar-width': '14.5rem' } as React.CSSProperties}>
          <AppSidebar />
          <SidebarInset className="bg-background">
            <SiteHeader title={PAGES.find(p => p.path === location.path)!.title} />
            <div key={location.path} className="animate-in fade-in-0 slide-in-from-bottom-2 mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 px-6 py-7 duration-300 lg:px-8">
              <Suspense fallback={<PageLoading />}><View /></Suspense>
            </div>
          </SidebarInset>
        </SidebarProvider>
        {transaction && <TransactionSheet key={transaction.item?.id ?? 'new'} transaction={transaction.item}
          onClose={() => setTransaction(null)} onSaved={() => { setTransaction(null); refresh(); }} onOpen={item => setTransaction({ item })}
          onTagChange={(id, tagOverride) => setTransaction(current => current?.item?.id === id ? { item: { ...current.item, tagOverride } } : current)} />}
        {wish && <WishDialog key={wish.item?.id ?? 'new'} item={wish.item} onClose={() => setWish(null)} onSaved={() => { setWish(null); refresh(); }} />}
        {ruleDraft && <RuleEditor rule={null} initial={ruleDraft} onClose={() => setRuleDraft(null)} onSaved={() => { setRuleDraft(null); refresh(); }} />}
        <Toaster position="bottom-center" />
      </TooltipProvider>
    </AppContext.Provider>
  );
}
