import {
  Apple, BadgePercent, BookOpen, CarTaxiFront, Clapperboard, CupSoda, Fuel, HandPlatter, Hospital, KeyRound, Landmark,
  Package, ParkingMeter, Pill, Puzzle, ShoppingBasket, ShoppingCart, Store, ToyBrick, TrainFront, TramFront, Utensils, Wifi, Wine, Zap,
  ArrowLeftRight, Baby, Bike, Briefcase, Camera, Car, CarFront, CircleEllipsis, Coffee, Dumbbell, Gamepad2, Gift,
  GraduationCap, HandHeart, HeartPulse, House, Laptop, Music, PawPrint, PiggyBank, Pizza, Plane, ReceiptText,
  Shirt, ShoppingBag, Smartphone, Soup, Sparkles, Ticket, TreePine, Wallet, Wrench, type LucideIcon,
} from 'lucide-react';
import { CATEGORY_COLOR_OPTIONS, type Bootstrap, type Category, type CategoryColor, type CategoryIcon as IconName, type Tag, type TagIcon, type Transaction } from '../../shared/contracts';
import { cn } from './utils';
import { matchTag } from '../../shared/tags';

/** 账单的二级标签：用当前分类与关键词规则实时推导，与后端统计、筛选同一个匹配器 */
export const tagOf = (bootstrap: Bootstrap, item: Pick<Transaction, 'categoryId' | 'description' | 'counterparty'>) =>
  matchTag(item, bootstrap.tags ?? [], bootstrap.tagRules ?? []);

/* 类目图标：键名来自后端 CATEGORY_ICON_OPTIONS；这里选在 16px 下轮廓清晰的 lucide 图形 */
export const CATEGORY_ICONS: Record<IconName, LucideIcon> = {
  home: House, food: Soup, bag: ShoppingBag, train: CarFront, ticket: Ticket, health: HeartPulse,
  learning: GraduationCap, salary: Briefcase, wallet: Wallet, other: CircleEllipsis, cup: Coffee, plane: Plane,
  car: Car, bike: Bike, gift: Gift, pet: PawPrint, dumbbell: Dumbbell, game: Gamepad2, music: Music,
  camera: Camera, tree: TreePine, tools: Wrench, smartphone: Smartphone, laptop: Laptop, shirt: Shirt, baby: Baby,
  beauty: Sparkles, pizza: Pizza, savings: PiggyBank, charity: HandHeart,
};
export const categoryColor = (color: CategoryColor) =>
  CATEGORY_COLOR_OPTIONS.find(option => option.value === color) ?? CATEGORY_COLOR_OPTIONS[CATEGORY_COLOR_OPTIONS.length - 1];

/* 图标统一灰色；类目颜色只在需要区分类目的地方用（色点、占比色块） */
const tile = 'grid shrink-0 place-items-center rounded-md border border-border/60 bg-muted/50 text-muted-foreground [&_svg]:size-4';
export function CategoryTile({ category, className }: { category: Pick<Category, 'icon' | 'color'>; className?: string }) {
  const Icon = CATEGORY_ICONS[category.icon] ?? CircleEllipsis;
  return <span className={cn(tile, 'size-8', className)}><Icon /></span>;
}
/* 二级标签图标：分类图标之外再加更细的子分类图形，与 TAG_ICON_OPTIONS 一一对应 */
export const TAG_ICONS: Record<TagIcon, LucideIcon> = {
  ...CATEGORY_ICONS, takeout: HandPlatter, discount: BadgePercent, apple: Apple, basket: ShoppingBasket, store: Store, soda: CupSoda,
  utensils: Utensils, tram: TramFront, taxi: CarTaxiFront, rail: TrainFront, parking: ParkingMeter, fuel: Fuel, hospital: Hospital,
  pill: Pill, package: Package, toy: ToyBrick, cart: ShoppingCart, film: Clapperboard, landmark: Landmark, puzzle: Puzzle,
  wine: Wine, key: KeyRound, bolt: Zap, wifi: Wifi, book: BookOpen,
};
export function TagTile({ tag, className }: { tag: Pick<Tag, 'icon'>; className?: string }) {
  const Icon = TAG_ICONS[tag.icon] ?? CircleEllipsis;
  return <span className={cn(tile, 'size-8', className)}><Icon /></span>;
}
export function CategoryDot({ color, className }: { color: CategoryColor; className?: string }) {
  return <span className={cn('inline-block size-2 shrink-0 rounded-full', className)} style={{ background: categoryColor(color).foreground }} />;
}
export function TransactionTile({ item, bootstrap, className }: { item: Transaction; bootstrap: Bootstrap; className?: string }) {
  const category = bootstrap.categories.find(c => c.id === item.categoryId);
  // 命中二级标签时显示更具体的子分类图标，例如 餐饮 · 水果 显示苹果
  const tag = category ? tagOf(bootstrap, item) : null;
  if (tag) return <TagTile tag={tag} className={className} />;
  if (category) return <CategoryTile category={category} className={className} />;
  const Icon = item.kind === 'transfer' ? ArrowLeftRight : item.kind === 'income' ? Wallet : ReceiptText;
  return <span className={cn(tile, 'size-8', className)}><Icon /></span>;
}
export const categoryName = (bootstrap: Bootstrap, id: string | null) =>
  id === null || id === 'uncategorized' ? '未分类' : bootstrap.categories.find(c => c.id === id)?.name ?? '分类已不可用';
