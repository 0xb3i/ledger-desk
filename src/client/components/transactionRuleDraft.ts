import {
  getTransactionCashflowKind,
  type Category,
  type CategoryRuleInput,
  type Transaction,
} from "../../shared/contracts";

/** Carry the selected text and compatible transaction context into the existing rule editor. */
export function transactionRuleDraft(
  transaction: Transaction,
  categories: Category[],
  keyword?: string,
): CategoryRuleInput | null {
  const flow = getTransactionCashflowKind(transaction);
  if (transaction.deletedAt || flow === "transfer") return null;
  const kind = flow === "refund" ? "expense" : flow;
  let value = (keyword ?? (transaction.counterparty.trim() || transaction.description)).trim();
  if (keyword !== undefined && (!value || value.length > 100)) return null;
  // A long source name is not a usable suggestion; let the user choose a phrase instead of truncating it.
  if (value.length > 100) value = "";
  const category = categories.find(item => item.id === transaction.categoryId && (item.kind === kind || item.kind === "both"));
  return { keyword: value, matchType: "contains", kind, categoryId: category?.id ?? "", enabled: true };
}
