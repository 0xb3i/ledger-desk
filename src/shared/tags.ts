import type { Tag, TagOverride, TagRule } from './contracts';

const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
/** 同一分类下的标签按 position 从上到下排列，前面的优先 */
export const byPosition = (a: Tag, b: Tag) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 二级标签：手动指定优先（账单仍属指定时的分类才生效）；否则只在账单当前一级分类下的标签里找：
 * 更具体的关键词优先，其余按标签顺序从上到下。例如「美团App百果园」同时命中「水果」与「外卖」，两个关键词
 * 互不包含，水果排在外卖之前，所以归为水果。前后端共用这一个匹配器，保证展示、筛选与统计一致。
 */
export function matchTag(transaction: { categoryId: string | null; description: string; counterparty: string; tagOverride?: TagOverride | null },
  tags: readonly Tag[], rules: readonly TagRule[]): Tag | null {
  if (!transaction.categoryId) return null;
  const scoped = tags.filter(tag => tag.categoryId === transaction.categoryId).sort(byPosition);
  if (!scoped.length) return null;
  const manual = transaction.tagOverride;
  if (manual && manual.categoryId === transaction.categoryId) {
    if (manual.tagId === null) return null;
    const tag = scoped.find(item => item.id === manual.tagId);
    if (tag) return tag;
  }
  return autoTag(transaction, scoped, rules);
}
/**
 * 只按关键词规则推导（忽略手动指定）：先去掉被更具体关键词包含的命中（「美团App团购」压过「美团App」），
 * 再按标签顺序取最靠前的。也用于在详情里提示「自动会归为哪个」。
 */
export function autoTag(transaction: { categoryId: string | null; description: string; counterparty: string }, tags: readonly Tag[], rules: readonly TagRule[]): Tag | null {
  if (!transaction.categoryId) return null;
  const scoped = tags.filter(tag => tag.categoryId === transaction.categoryId).sort(byPosition);
  if (!scoped.length) return null;
  const ids = new Set(scoped.map(tag => tag.id));
  const texts = [normalize(transaction.description), normalize(transaction.counterparty)];
  const hits = rules.flatMap(rule => {
    if (!ids.has(rule.tagId)) return [];
    const keyword = normalize(rule.keyword);
    return keyword.length > 0 && texts.some(text => rule.matchType === 'exact' ? text === keyword : text.includes(keyword)) ? [{ tagId: rule.tagId, keyword }] : [];
  });
  const specific = hits.filter(hit => !hits.some(other => other.keyword.length > hit.keyword.length && other.keyword.includes(hit.keyword)));
  return scoped.find(tag => specific.some(hit => hit.tagId === tag.id)) ?? null;
}
