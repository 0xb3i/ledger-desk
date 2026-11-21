import { LayoutGrid, ReceiptText, Heart, Tags, RefreshCw } from 'lucide-react';
import { PAGES, useApp, type PagePath } from '@/lib/app';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem,
} from '@/components/ui/sidebar';

const ICONS: Record<PagePath, typeof Heart> = {
  '/overview': LayoutGrid, '/transactions': ReceiptText, '/wishlist': Heart, '/categories': Tags, '/settings': RefreshCw,
};
const muted = '[&>svg]:text-muted-foreground data-[active=true]:font-medium data-[active=true]:[&>svg]:text-foreground';

/* 应用标记：与应用图标、favicon 同一图形——实心石墨「页面」镂出两行，右下橙色句点呼应「轻记.」；按 32 像素网格对齐，小尺寸也清晰 */
function AppMark({ className }: { className?: string }) {
  return (
    <svg viewBox="3 2 28 29" aria-hidden className={className}>
      <defs>
        <mask id="app-mark-cut"><rect width="32" height="32" fill="#fff" /><rect x="8" y="9" width="11" height="3" rx="1.5" fill="#000" /><rect x="8" y="15" width="7" height="3" rx="1.5" fill="#000" /><circle cx="24" cy="25" r="7" fill="#000" /></mask>
      </defs>
      <rect x="4" y="3" width="19" height="25" rx="4.5" fill="currentColor" mask="url(#app-mark-cut)" />
      <circle cx="24" cy="25" r="5" fill="var(--brand)" />
    </svg>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { location, navigate, sync } = useApp();
  const issues = sync.data?.issues?.length ?? 0;
  const go = (path: PagePath) => (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault(); navigate(path);
  };
  const item = (path: PagePath) => {
    const page = PAGES.find(p => p.path === path)!, Icon = ICONS[path];
    return (
      <SidebarMenuItem key={path}>
        <SidebarMenuButton isActive={location.path === path} tooltip={page.label} className={muted} asChild>
          <a href={path} onClick={go(path)}><Icon /><span>{page.label}</span></a>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  };
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader className="pb-1">
        <a href="/overview" onClick={go('/overview')} className="flex items-center gap-2 rounded-md px-2 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <AppMark className="size-5 text-foreground" />
          <span className="text-[17px] font-medium tracking-tight">轻记</span>
        </a>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{(['/overview', '/transactions', '/wishlist', '/categories'] as PagePath[]).map(item)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* 同步状态在顶栏右上角已有，这里只在出问题时给个角标 */}
            <SidebarMenuButton isActive={location.path === '/settings'} tooltip="同步与备份" className={muted} asChild>
              <a href="/settings" onClick={go('/settings')}><RefreshCw /><span>同步与备份</span></a>
            </SidebarMenuButton>
            {(issues > 0 || sync.data?.lastError) && <SidebarMenuBadge className="text-brand">{issues || '!'}</SidebarMenuBadge>}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
