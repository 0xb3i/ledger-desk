import { KIND_LABELS, type Transaction, type TransactionKind } from "../../shared/contracts";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
export function currentMonth(): string {
  return dayFormatter.format(new Date()).slice(0, 7);
}
export function dateInShanghai(value: string | Date): string {
  return dayFormatter.format(new Date(value));
}
export function dateTimeInput(value: string | Date = new Date()): string {
  const clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
  return `${dateInShanghai(value)}T${clock}`;
}
export function dateLabel(value: string, includeYear = false): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    ...(includeYear ? { year: "numeric" as const } : {}),
    month: "numeric",
    day: "numeric",
  }).format(new Date(value));
}
export function timeLabel(value: string): string {
  return timeFormatter.format(new Date(value));
}
export function monthLabel(value: string): string {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}
export function shiftMonth(value: string, amount: number): string {
  const [year, month] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function centsToDecimal(cents: number): string {
  return `${cents < 0 ? "-" : ""}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}
export function money(cents: number): string {
  const [whole, fraction] = centsToDecimal(cents).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}
export function signedMoney(cents: number, kind: TransactionKind): string {
  return `${kind === "expense" ? "−" : kind === "income" || kind === "refund" ? "+" : ""}${money(cents)}`;
}
export function shortMoney(cents: number): string {
  if (Math.abs(cents) >= 1_000_000)
    return `${Number((cents / 1_000_000).toFixed(1))}万`;
  return `${Number((cents / 100).toFixed(Math.abs(cents) < 10000 ? 2 : 0))}`;
}

export function transactionKindLabel(item: Pick<Transaction, "kind" | "transferDirection">): string {
  return item.kind === "transfer"
    ? item.transferDirection === "inflow" ? "转入" : item.transferDirection === "outflow" ? "转出" : "转账"
    : KIND_LABELS[item.kind];
}
