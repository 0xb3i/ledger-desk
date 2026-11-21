import { useState } from 'react';
import { CalendarDays, X } from 'lucide-react';
import { zhCN } from 'react-day-picker/locale';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const toDate = (value: string) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); };
const toValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/* 日期选择：值为 YYYY-MM-DD；可限定范围，可清除 */
export function DatePicker({ value, onChange, placeholder = '选择日期', min, max, clearable, className, id, disabled }: {
  value: string; onChange: (value: string) => void; placeholder?: string; min?: string; max?: string;
  clearable?: boolean; className?: string; id?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selected = value ? toDate(value) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className={cn('relative', className)}>
        <PopoverTrigger asChild>
          <Button id={id} variant="outline" disabled={disabled} className={cn('w-full justify-start gap-2 bg-card font-normal text-foreground tabular-nums', value && 'border-foreground/25 bg-accent/50', clearable && value && 'pr-8 has-[>svg]:pr-8')}>
            <CalendarDays className="text-muted-foreground" />{value ? value.replaceAll('-', '/') : placeholder}
          </Button>
        </PopoverTrigger>
        {clearable && value && <Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-1.5 size-6 -translate-y-1/2 rounded-full text-muted-foreground hover:text-foreground" aria-label="清除日期" onClick={() => onChange('')}><X /></Button>}
      </div>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar mode="single" locale={zhCN} selected={selected} defaultMonth={selected ?? (min ? toDate(min) : undefined)}
          disabled={[...(min ? [{ before: toDate(min) }] : []), ...(max ? [{ after: toDate(max) }] : [])]}
          onSelect={date => { if (date) { onChange(toValue(date)); setOpen(false); } }} />
      </PopoverContent>
    </Popover>
  );
}
