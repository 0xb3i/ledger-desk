import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { currentMonth, shiftMonth } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/* 月份切换：左右步进 + 点中间弹出年份 / 月份网格 */
export function MonthStepper({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(Number(value.slice(0, 4)));
  const now = currentMonth();
  return (
    <ButtonGroup aria-label="选择月份">
      <Button variant="outline" size="icon" aria-label="上个月" onClick={() => onChange(shiftMonth(value, -1))}><ChevronLeft /></Button>
      <Popover open={open} onOpenChange={next => { setOpen(next); if (next) setYear(Number(value.slice(0, 4))); }}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="min-w-28 tabular-nums">{value.slice(0, 4)} 年 {Number(value.slice(5))} 月</Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="center">
          <div className="mb-2 flex items-center">
            <Button variant="ghost" size="icon-sm" aria-label="上一年" onClick={() => setYear(year - 1)}><ChevronLeft /></Button>
            <span className="flex-1 text-center text-sm tabular-nums">{year} 年</span>
            <Button variant="ghost" size="icon-sm" aria-label="下一年" onClick={() => setYear(year + 1)}><ChevronRight /></Button>
          </div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => {
              const month = `${year}-${String(i + 1).padStart(2, '0')}`;
              return <Button key={month} size="sm" variant={month === value ? 'default' : 'ghost'} className={cn(month === now && month !== value && 'text-brand')}
                onClick={() => { onChange(month); setOpen(false); }}>{i + 1} 月</Button>;
            })}
          </div>
          {value !== now && <Button variant="link" size="sm" className="mt-2 w-full" onClick={() => { onChange(now); setOpen(false); }}>回到本月</Button>}
        </PopoverContent>
      </Popover>
      <Button variant="outline" size="icon" aria-label="下个月" onClick={() => onChange(shiftMonth(value, 1))}><ChevronRight /></Button>
    </ButtonGroup>
  );
}
