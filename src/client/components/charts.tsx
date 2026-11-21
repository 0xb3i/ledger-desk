import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from 'recharts';
import type { DailyTotals } from '../../shared/contracts';
import { dateInShanghai, money } from '@/lib/format';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';

const yen = (cents: number) => { const v = cents / 100; return v >= 1000 ? `¥${(v / 1000).toFixed(1).replace('.0', '')}k` : `¥${Math.round(v)}`; };
const minBar = (value: unknown) => (Number(value) > 0 ? 3 : 0);
const dayLabel = (date: string) => `${Number(date.slice(5, 7))} 月 ${Number(date.slice(8))} 日`;
function ticksFor(days: DailyTotals[], today: string) {
  const n = days.length, t = days.findIndex(d => d.date === today) + 1;
  return [...new Set([1, 5, 10, 15, 20, 25, n, ...(t > 0 ? [t] : [])])].filter(d => d <= n && !(t > 0 && d !== t && Math.abs(d - t) < 2)).sort((a, b) => a - b);
}
function Row({ a, b }: { a: string; b: string }) {
  return <div className="flex w-full min-w-40 justify-between gap-4"><span className="text-muted-foreground">{a}</span><span className="text-foreground/75 tabular-nums">{b}</span></div>;
}

/* 每日日常支出（不含固定支出）；设了预算时未来日期画“每天可花”占位柱 */
const dailyConfig = { daily: { label: '日常支出', color: 'var(--chart-1)' }, future: { label: '每天可花', color: 'var(--muted)' } } satisfies ChartConfig;
export function DailyChart({ days, perDayCents, onPick }: { days: DailyTotals[]; perDayCents: number | null; onPick: (date: string) => void }) {
  const today = dateInShanghai(new Date());
  const data = days.map((d, i) => ({
    d: i + 1, date: d.date, daily: Math.max(0, d.expenseCents - d.fixedExpenseCents),
    future: d.date > today && perDayCents && perDayCents > 0 ? perDayCents : 0, isToday: d.date === today, isFuture: d.date > today, raw: d,
  }));
  const ticks = ticksFor(days, today), todayIndex = days.findIndex(d => d.date === today) + 1;
  return (
    <ChartContainer config={dailyConfig} className="aspect-auto h-[208px] w-full [&_*]:outline-none">
      <BarChart data={data} margin={{ top: 20, right: 4, left: 0, bottom: 0 }} barCategoryGap="16%">
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis dataKey="d" ticks={ticks} interval={0} tickFormatter={d => d === todayIndex ? '今天' : `${d} 日`} tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickMargin={8} />
        <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={yen} tickCount={4} />
        {perDayCents !== null && perDayCents > 0 && <ReferenceLine y={perDayCents} stroke="var(--muted-foreground)" strokeOpacity={.55} strokeDasharray="3 4"
          label={{ value: `每天可花 ¥${money(perDayCents).replace(/\.00$/, '')}`, position: 'insideBottomRight', offset: 6, fontSize: 11, fill: 'var(--muted-foreground)' }} />}
        <ChartTooltip cursor={{ fill: 'var(--muted)', opacity: .6 }} content={
          <ChartTooltipContent hideIndicator labelFormatter={(_, p) => dayLabel(p?.[0]?.payload?.date ?? '')}
            formatter={(_, name, item) => {
              const r = item.payload as typeof data[number];
              if (name === 'future') return r.isFuture && r.future ? <Row a="每天可花" b={`¥${money(r.future)}`} /> : null;
              if (r.isFuture && !r.daily) return null;
              return <div className="grid w-full gap-1">
                <Row a="日常支出" b={`¥${money(r.daily)}`} />
                {r.raw.fixedExpenseCents > 0 && <Row a="固定支出" b={`¥${money(r.raw.fixedExpenseCents)}`} />}
                {r.raw.incomeCents > 0 && <Row a="收入" b={`¥${money(r.raw.incomeCents)}`} />}
                <span className="mt-0.5 border-t pt-1 text-muted-foreground">点击查看当天账单</span>
              </div>;
            }} />
        } />
        <Bar dataKey="daily" stackId="a" radius={[4, 4, 0, 0]} maxBarSize={30} minPointSize={minBar}>
          {data.map(r => <Cell key={r.d} cursor={r.isFuture ? 'default' : 'pointer'} fill="var(--color-daily)" fillOpacity={r.isToday ? 1 : .45} onClick={() => !r.isFuture && onPick(r.date)} />)}
        </Bar>
        <Bar dataKey="future" stackId="a" radius={[4, 4, 0, 0]} maxBarSize={30} fill="var(--color-future)" fillOpacity={0.75} isAnimationActive={false} />
      </BarChart>
    </ChartContainer>
  );
}

/* 累计支出（含固定支出），对照预算与均匀节奏 */
const cumConfig = { spent: { label: '本月累计', color: 'var(--chart-1)' }, pace: { label: '预算节奏', color: 'var(--muted-foreground)' } } satisfies ChartConfig;
export function CumulativeChart({ days, budgetCents }: { days: DailyTotals[]; budgetCents: number }) {
  const today = dateInShanghai(new Date());
  let sum = 0;
  const data = days.map((d, i) => {
    sum += d.expenseCents;
    return { d: i + 1, date: d.date, spent: d.date <= today ? sum : null, pace: budgetCents ? Math.round(budgetCents * (i + 1) / days.length) : null };
  });
  const ticks = ticksFor(days, today), todayIndex = days.findIndex(d => d.date === today) + 1;
  return (
    <ChartContainer config={cumConfig} className="aspect-auto h-[200px] w-full">
      <ComposedChart data={data} margin={{ top: 16, right: 20, left: 0, bottom: 0 }}>
        <defs><linearGradient id="fill-spent" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-spent)" stopOpacity={.25} /><stop offset="95%" stopColor="var(--color-spent)" stopOpacity={0} /></linearGradient></defs>
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis dataKey="d" ticks={ticks} interval={0} tickFormatter={d => d === todayIndex ? '今天' : `${d} 日`} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis width={44} tickLine={false} axisLine={false} tickFormatter={yen} />
        {budgetCents > 0 && <ReferenceLine y={budgetCents} stroke="var(--muted-foreground)" strokeDasharray="3 4"
          label={{ value: `预算 ¥${money(budgetCents).replace(/\.00$/, '')}`, position: 'insideBottomLeft', offset: 6, fontSize: 11, fill: 'var(--muted-foreground)' }} />}
        <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(_, p) => dayLabel(p?.[0]?.payload?.date ?? '')}
          formatter={(value, name) => value == null ? null : <Row a={name === 'spent' ? '本月累计' : '预算节奏'} b={`¥${money(Number(value))}`} />} />} />
        {budgetCents > 0 && <Line dataKey="pace" stroke="var(--color-pace)" strokeWidth={1.2} strokeDasharray="1 4" dot={false} activeDot={false} />}
        <Area dataKey="spent" type="monotone" stroke="var(--color-spent)" strokeWidth={2} fill="url(#fill-spent)" dot={false} connectNulls={false} />
        {budgetCents > 0 && <ChartLegend content={<ChartLegendContent />} verticalAlign="top" align="right" wrapperStyle={{ top: -8 }} />}
      </ComposedChart>
    </ChartContainer>
  );
}

/* 账单页侧栏：迷你日柱图，点柱子按天筛选 */
export function MiniDailyChart({ days, selected, onPick }: { days: DailyTotals[]; selected: string; onPick: (date: string) => void }) {
  const today = dateInShanghai(new Date());
  const data = days.map((d, i) => ({ d: i + 1, date: d.date, v: Math.max(0, d.expenseCents - d.fixedExpenseCents), isToday: d.date === today, isFuture: d.date > today }));
  return (
    <ChartContainer
      config={dailyConfig}
      className="aspect-auto h-32 w-full [&_*]:outline-none [&_.recharts-bar-rectangle_path]:transition-[fill-opacity] [&_.recharts-bar-rectangle_path]:duration-150 [&_.recharts-bar-rectangle:hover_path]:fill-opacity-85"
    >
      <BarChart data={data} margin={{ top: 8, right: 12, left: 10, bottom: 0 }} barCategoryGap="10%">
        <CartesianGrid vertical={false} strokeDasharray="2 4" strokeOpacity={0.5} />
        <XAxis dataKey="d" ticks={[1, 10, 20, days.length]} interval={0} tickFormatter={d => `${d} 日`} tickLine={false} axisLine={{ stroke: 'var(--border)' }} tickMargin={6} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => dayLabel(p?.[0]?.payload?.date ?? '')}
          formatter={value => <Row a="日常支出" b={`¥${money(Number(value))}`} />} />} />
        <Bar dataKey="v" radius={[2, 2, 0, 0]} minPointSize={minBar} isAnimationActive={false}>
          {data.map(r => {
            const isPicked = selected === r.date;
            const opacity = isPicked ? 0.95 : selected ? 0.22 : r.isToday ? 0.92 : 0.45;
            return (
              <Cell
                key={r.d}
                cursor={r.isFuture ? 'default' : 'pointer'}
                onClick={() => !r.isFuture && onPick(r.date)}
                fill="var(--color-daily)"
                fillOpacity={opacity}
              />
            );
          })}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}
