import { CircleHelp } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/* 标题旁的说明：平时只露一个问号，悬停或聚焦时显示文字，替代占位的说明段落 */
export function HelpHint({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="说明" className="inline-grid size-5 place-items-center rounded text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50">
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 text-xs leading-relaxed font-normal">{children}</TooltipContent>
    </Tooltip>
  );
}
