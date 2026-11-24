---
name: 轻记
description: 本机运行的个人账本：安静的中性纸面，数字对齐，一颗橙色句点只在需要判断时出现。
colors:
  ember-period: "#e56332"
  ember-muted: "#e6845a"
  ember-wash: "#fff2ea"
  ledger-green: "#4d8061"
  brick-red: "#c84b31"
  graphite: "#26272a"
  ink: "#232426"
  ink-muted: "#71727a"
  paper-canvas: "#f6f6f7"
  paper-white: "#ffffff"
  sidebar-paper: "#fdfdfd"
  footer-tint: "#fafafb"
  wash-secondary: "#f2f2f4"
  wash-muted: "#f0f0f2"
  wash-accent: "#efeff1"
  hairline: "#eaeaee"
  hairline-inner: "#f1f1f4"
  input-stroke: "#e2e2e7"
  focus-ring: "#b4b5bd"
  chart-ember: "#e87a4d"
  chart-slate: "#7d98a6"
  chart-sage: "#839278"
  chart-sand: "#ad9b7b"
  chart-lilac: "#9689ad"
typography:
  display:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "-0.025em"
  amount:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "2.25rem"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
    fontFeature: "tnum"
  title:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1
  body:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Inter, PingFang SC, -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.33
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  row-y: "14px"
  row-x: "20px"
  card: "24px"
  section: "24px"
  page-x: "32px"
  page-y: "28px"
  header: "52px"
  sidebar: "232px"
  rail: "340px"
  page-max: "1600px"
components:
  button-primary:
    backgroundColor: "{colors.graphite}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-outline:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "36px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.wash-accent}"
  button-destructive:
    backgroundColor: "{colors.brick-red}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
    height: "36px"
  card:
    backgroundColor: "{colors.paper-white}"
    rounded: "{rounded.xl}"
    padding: "24px"
  card-footer-tint:
    backgroundColor: "{colors.footer-tint}"
    padding: "14px 24px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "36px"
  badge-count:
    backgroundColor: "{colors.wash-secondary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  badge-alert:
    backgroundColor: "{colors.ember-period}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.full}"
    height: "14px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px"
    height: "32px"
  nav-item-active:
    backgroundColor: "#efeff0"
    textColor: "{colors.ink}"
  list-row:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.ink}"
    padding: "14px 20px"
  icon-tile:
    backgroundColor: "{colors.wash-muted}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    size: "32px"
  attention-tile:
    backgroundColor: "{colors.ember-wash}"
    textColor: "{colors.ember-period}"
    rounded: "{rounded.md}"
    size: "32px"
---

# Design System: 轻记

## Overview

**Creative North Star: "安静的账页"**

轻记像摊在桌面上的一页干净账本：中性偏冷的纸面画布（paper-canvas）上浮着纯白卡片，卡片之间只靠一像素发丝线和留白分层，数字统一等宽对齐。品牌的全部个性压缩在一个符号里，就是「轻记.」右下角那颗暖橙句点。橙色在页面上出现得像句点一样少，只用来标出结论、提醒和越界。

气质是 **克制、轻盈、可信**。克制体现在几乎没有阴影、没有渐变、没有装饰插画，图标线宽统一调细到 1.5，标题只用 500 字重。轻盈来自充足的行高、行内 14px 的上下留白，以及低饱和的灰阶层次。可信来自数字：金额全部用 tabular-nums，人民币符号和小数部分降一档灰色，让整数先被读到，读的人能一眼对齐、核对。

这是一个 Operate 型桌面工具：只有本人在 Mac 上使用，所以信息密度可以略高于移动端，但每一屏只回答一个问题。技术状态（同步、解析异常）平时收进右上角，需要处理时才浮上来。

**Key Characteristics:**
- 中性冷灰纸面 + 纯白浮卡，靠发丝线和色阶分层，几乎不用阴影。
- 单一暖橙点色（Ember Period），只承担「需要你判断」的语义。
- 金额等宽对齐，¥ 符号与小数降灰，整数优先。
- 细线图标（lucide，stroke 1.5），统一灰色，不按类目上色。
- 列表行悬停才显露次要操作，静止时界面保持安静。

## Colors

整体是一套低饱和中性灰阶，外加一颗暖橙和一抹沉稳的账本绿，它们分别代表「需要留意」和「已完成或健康」。

### Primary
- **句点橙 Ember Period**：品牌句点、提醒角标、超出预算、待核对入口、拖放落点高亮。它表达的是「这里需要你看一眼」，不是「主要操作」。主要操作按钮用石墨色。
- **橙雾 Ember Wash**：橙色语义的底色，用于提醒项的图标底、超支涨幅徽章、拖放提示行背景。
- **柔橙 Ember Muted**：节奏超前时的进度条，比句点橙低一档，表示「偏快」但还不算出错。

### Secondary
- **账本绿 Ledger Green**：同步正常的状态点、已购勾选、支出下降徽章（用 10% 透明度做底）。只表达「好的、已完成」，不用于按钮。

### Tertiary
- **砖红 Brick Red**：仅用于破坏性操作（移除、删除确认）和错误提示，与句点橙严格区分，不用来表示「提醒」。

### Neutral
- **石墨 Graphite**：主按钮底色、侧栏主色、应用图标的纸页主体。
- **墨色 Ink**：正文与标题文字。
- **灰墨 Ink Muted**：说明文字、列头、次要数字、¥ 符号与小数部分、图标默认色。
- **纸面画布 Paper Canvas**：页面背景，冷灰偏中性。
- **纸白 Paper White**：卡片、弹层、输入框所在的表面。
- **侧栏纸 Sidebar Paper**：侧栏背景，比卡片略灰，几乎看不出差别。
- **页脚浅灰 Footer Tint**：卡片底部附属信息条（如固定支出、待核对快捷条）的底色。
- **发丝线 Hairline / Inner Hairline**：外框分割线用 Hairline；卡片内部的分割线再浅一档，用 Inner Hairline。
- **洗灰 Wash（secondary / muted / accent）**：计数徽章、悬停底、图标方块底，三档非常接近，只制造触感，不制造对比。

### Named Rules
**The Period Rule.** 句点橙只表达「需要留意」：提醒、越界、待处理。单屏出现的橙色面积不超过 5%，主按钮永远不用橙色。

**The Two Reds Rule.** 橙色表示提醒，砖红表示破坏。提醒不能用砖红，删除不能用橙色。

**The Grey Icons Rule.** 图标一律用灰墨，图标瓦片不上色。类目柔色（暖沙、雾蓝、雾紫、苔绿、灰玫）只用于需要区分类目的色点、占比色块和周期进度条。

## Typography

**Display Font:** Inter（本地内置 400 / 500 / 600 三档，中文回退 PingFang SC）
**Body Font:** 同上，单一字族
**Label/Mono Font:** 不使用等宽字体，数字靠 `tabular-nums` 对齐

**Character:** Inter 的冷静几何感负责数字和拉丁字符，苹方负责中文。两者都只用 400 和 500，用字号与灰度建立层级，不靠字重。

### Hierarchy
- **Display**（500, 30px, 1.2, -0.025em）：总览页问候语或月份标题，每个应用只出现在首屏。
- **Headline**（500, 24px, 1.33, -0.025em）：二级页面标题（PageHeader），下方跟一行 14px 灰色说明。
- **Amount**（500, 36px 主金额 / 30px 次金额, 1, tabular-nums）：关键金额。¥ 符号和小数部分降为 20px / 18px 的 400 字重灰墨。
- **Title**（500, 16px, 1）：卡片标题、列表分区标题，常与计数徽章并排。
- **Body**（400, 14px, 1.43）：列表行标题、表单、正文。列表行标题保持 400 字重。
- **Label**（400, 12px）：列头、行内副信息、指标卡脚注、日期。

### Named Rules
**The No-Bold Rule.** 界面文字不超过 500 字重。层级只靠字号、灰度和留白，不靠加粗。

**The Tabular Rule.** 所有金额、计数、日期、百分比都加 `tabular-nums`，列内数字右对齐。

## Layout

桌面优先的「侧栏 + 内容」布局。侧栏宽 232px（14.5rem），可整体收起（offcanvas）。顶栏高 52px，吸顶，左侧是「轻记 / 页面标题」面包屑，右侧依次是搜索（⌘K）、同步状态、提醒铃铛。

内容区最大宽 1600px，水平内边距 24px（≥lg 为 32px），顶部 28px，区块间距统一 24px。常用的两栏结构是「主列 + 340px 右栏」：主列放可操作的清单，右栏放小计、次级队列和归档入口，在 lg / xl 以上并排，右栏吸顶（top 64px）。

列表行内边距为上下 14px、左右 16–20px。列表视图在 lg 以上把行变成 CSS Grid，标题行兼作列头，列名用 12px 灰墨并与下方各列对齐；窄屏时次要列直接隐藏，不做横向滚动。

页面切换使用一次 300ms 的淡入上移（slide-in-from-bottom 8px），不做其他入场编排。

### Named Rules
**The Header-Is-Column Rule.** 清单卡片不单独放表头。卡片标题行同时承担列头，列名对齐到下方数据列。

## Elevation & Depth

系统基本是平的，深度主要靠色阶表达：纸面画布 → 纸白卡片 → 浅灰页脚条。卡片只带一层几乎看不见的 1px 2px 环境阴影，作用是让白卡在灰底上「落」下来，而不是浮起来。真正的投影只留给脱离文档流的层：弹出框、下拉菜单、对话框、抽屉。

### Shadow Vocabulary
- **纸贴 Paper Rest**（`box-shadow: 0 1px 2px rgba(35,36,38,0.02)`）：所有卡片的静止态。
- **按钮压痕 Control**（`shadow-xs`，约 `0 1px 2px rgba(0,0,0,0.05)`）：描边按钮、输入框。
- **浮层 Overlay**（`shadow-lg` / `shadow-md`）：Dialog、Sheet、Popover、Dropdown。
- **焦点环 Focus**（`0 0 0 3px` 焦点灰 50% 透明度）：所有可交互控件的键盘焦点。

### Named Rules
**The Flat-By-Default Rule.** 卡片在任何状态下都不加大阴影。悬停反馈用洗灰底色，拖放反馈用 2px 橙色描边环。

## Shapes

圆角基准是 12px（`--radius`），按层级递减：卡片 16px、按钮和输入框 10px、图标方块 8–10px，徽章、状态点和勾选圆圈用全圆。卡片内部不再嵌套带圆角的卡片，内部分区一律用发丝线横切。

勾选控件是空心细圆圈（20px，灰墨 45% 描边），悬停时变为账本绿，填充浅绿底并显示对勾。这个「圆圈 → 实心勾」的动作是完成类操作的统一形状。

## Components

### Buttons
- **Shape:** 柔和圆角（10px），高度 36px，小号 32px，图标按钮为正方形。
- **Primary:** 石墨底、白字、400 字重，内边距 8px 16px，带图标时左侧 12px。每个页面头部最多一个主按钮（「记一笔」「添加心愿」）。
- **Outline:** 纸白底 + 发丝线 + 压痕阴影，用于次要但需要被看见的操作（恢复、设置预算）。
- **Ghost:** 透明底，悬停时洗灰。用于卡片页脚的「查看全部 ›」、分页和顶栏工具。
- **Destructive:** 砖红底白字，只出现在二次确认里。入口按钮用 Ghost 加砖红文字。
- **Hover / Focus:** 背景色过渡（transition-all），键盘焦点显示 3px 焦点灰环，不位移、不放大。

### Chips / Badges
- **倒计时胶囊 Pill：** 全圆、高 20px、12px / 500 字重，只用于时间状态（如「14 天后」「明天」）。普通状态用洗灰底配灰字（#f0f0f2 / #5f6068）；需要你处理时用橙雾底配加深的句点橙字（#a9441d）。扣款方式这类属性保持纯文字，不做成胶囊。
- **周期进度条：** 4px 高的全圆细条，底色 #ececef，填充用类别色；需要你付款时改用句点橙。只用来表示当前这一期已经过去多少。
- **计数徽章：** 全圆、洗灰底、12px 墨色，紧跟在卡片标题后显示数量。
- **提醒角标：** 铃铛右上角的 14px 句点橙全圆，10px 白色数字。
- **趋势徽章：** 洗橙底（上涨）或 10% 账本绿底（下降），图标用对应色，数字用墨色。

### Cards / Containers
- **Corner Style:** 16px。
- **Background:** 纸白，放在纸面画布上。
- **Shadow Strategy:** 纸贴（见 Elevation）。
- **Border:** 1px 发丝线；内部分割线用 Inner Hairline。
- **Internal Padding:** 24px。清单型卡片的上下内边距为 0，由标题行和列表行自带内边距。
- **页脚条：** 附属信息放在 `border-t` 加浅灰底的 Footer 条里，例如本月固定支出、待核对快捷入口。

### Inputs / Fields
- **Style:** 透明底、1px Input Stroke、10px 圆角、高 36px，14px 字号。金额输入用带 ¥ 前缀的 InputGroup，并加 tabular-nums。
- **Focus:** 边框变为焦点灰，外加 3px 50% 焦点环。
- **Error / Disabled:** 错误时边框用砖红并显示 Alert。禁用时透明度 50%。
- **Labels:** 字段标签在上方，选填项写在括号里「（选填）」，说明文字用 12–14px 灰墨放在字段下方。

### Navigation
- **侧栏：** 每项高 32px、10px 圆角，图标 16px 灰墨。激活态是浅灰底，文字和图标转为墨色并加 500 字重。异常数量用侧栏菜单角标显示，颜色为句点橙。
- **顶栏：** 52px 高的发丝线底边，面包屑为「轻记 / 标题」，分隔斜杠用 45% 灰墨。
- **右上角铃铛（需要留意）：** Ghost 图标按钮，有待办时显示句点橙角标。弹出 360px 宽的 Popover，标题行「需要留意 + 计数」，每条是 Item：32px 图标方块、标题、12px 说明，悬停时右侧显示 ›，点击直达处理位置。警示类条目的图标方块和标题改用橙雾底、句点橙。

### Metric（签名组件）
指标卡由三行组成：14px 灰墨标签（可点开明细 Popover）、30–36px 金额（¥ 与小数降灰）、12px 脚注。脚注只回答「和什么比、是好是坏」，不重复页面别处已有的数字。

### List Row（签名组件）
卡片内的单行清单：左侧可选的勾选圆圈或 32px 图标方块，主标题 14px / 400，副标题 12px 灰墨，右侧金额右对齐并加 tabular-nums。整行可点开编辑，悬停时显示洗灰底和「⋯」更多菜单，次要操作都收在菜单里。

## Do's and Don'ts

### Do:
- **Do** 让金额整数先被读到：¥ 和小数部分降为灰墨并缩小一档，全部加 `tabular-nums`。
- **Do** 用句点橙（#e56332）且只用它表达「需要你判断」：提醒、超支、待核对、即将到期。
- **Do** 在清单卡片里用标题行兼作列头，lg 以下隐藏次要列。
- **Do** 把次要操作收进行尾的「⋯」菜单，悬停才显现。
- **Do** 每个状态都提供空状态（EmptyState：灰色图标方块 + 一句说明 + 一个主操作）、加载状态（Spinner + 「正在读取…」）和错误状态（Alert + 重试）。
- **Do** 新页面复用 PageHeader（24px 标题 + 一行说明 + 右侧唯一主按钮）。

### Don't:
- **Don't** 把句点橙用在主按钮、大面积背景或装饰上。
- **Don't** 用砖红表达提醒，也不要用橙色表达删除。
- **Don't** 给卡片加大阴影、渐变、玻璃拟态，也不要在卡片里再嵌带圆角的卡片。
- **Don't** 使用超过 500 的字重，也不要用大写字母、字距拉宽的标签。
- **Don't** 给图标或图标瓦片上类目色，也不要给属性文字（如扣款方式）套底色或描边胶囊；类目色只用于色点、占比色块和周期进度。
- **Don't** 在界面上展示工程版本号或技术细节，技术状态只在需要处理时出现。
