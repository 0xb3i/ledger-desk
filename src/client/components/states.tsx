import { CircleAlert, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

/* 统一的加载、错误与空状态 */
export function PageLoading({ label = '正在读取' }: { label?: string }) {
  return <div className="flex min-h-40 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner />{label}</div>;
}
export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  if (!message) return null;
  return (
    <Alert variant="destructive" className="items-center">
      <CircleAlert />
      <AlertDescription className="flex items-center gap-3">{message}{retry && <Button variant="outline" size="sm" className="ml-auto h-7" onClick={retry}>重试</Button>}</AlertDescription>
    </Alert>
  );
}
export function EmptyState({ icon: Icon, title, description, children }: { icon: LucideIcon; title: string; description?: string; children?: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><Icon strokeWidth={1.75} /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}
