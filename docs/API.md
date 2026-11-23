# API 协议

当前本地地址为 `http://127.0.0.1:43927`。所有请求均校验本机 Host；除健康检查和会话入口外，账目接口需要有效会话或既有设备凭据。成功响应为 `{data: ...}`，错误为 `{error:{code,message,requestId}}`。

金额输入十进制字符串，输出整数分；时间使用带时区的 ISO 8601，按月归属及展示统一为 `Asia/Shanghai`。公共类型定义在 `src/shared/contracts.ts`。

## 本机入口与会话

- `GET /local/open`：本地启动器入口，限制浏览器来源，自动建立 HttpOnly 会话，返回 303 跳转到 `/`。它不是给外部网站调用的登录 API。
- `GET /api/session` → `{authenticated,version}`。
- `POST /api/session`，输入 `{accessKey}` → `{authenticated:true}`；保留公共会话契约，日常从本机入口进入即可。
- `DELETE /api/session` → `{authenticated:false}`。
- `GET /api/health` → `{status:'ok',version}`，实际执行数据库查询后返回。

网页写入要求同源，JSON 写入使用 `Content-Type: application/json`。版本由工程配置返回，不展示在页面中。

## QQ 邮箱同步

- `GET /api/integrations/mail/status` → `MailSyncStatus`。返回配置状态、已连接 QQ 邮箱地址、默认建议起始日期 `suggestedStartDate`、已导入笔数、衔接跳过历史重复笔数、最近同步时间、错误信息以及待核对邮件总数 `issueCount`、最近 50 封待核对邮件 `issues` 和当前可恢复的已忽略邮件数 `dismissedIssueCount`。不返回授权码。
- `POST /api/integrations/mail/config`，输入 `{email,authCode?,syncStartDate,accountId?}` → `MailSyncStatus`。先验证 `imap.qq.com:993` 只读登录与 `EXAMINE INBOX`，通过后将 16 位授权码写入 macOS 系统钥匙串、将非凭据配置写入权限 `600` 的 `mail.json`，并立即执行一次同步。
- `DELETE /api/integrations/mail/config` → `MailSyncStatus`。停用邮箱同步、删除 `mail.json` 并移除系统钥匙串中的授权码；已导入的本地账目完整保留。
- `POST /api/integrations/mail/sync`，输入 `{}` 执行增量同步，或输入 `{startDate,endDate}` 执行按日期范围补扫 → `MailSyncStatus`。
- `GET /api/integrations/mail/issues/:uidValidity/:uid` → `MailIssueDetail`，返回待核对邮件摘要和补录草稿。
- `POST /api/integrations/mail/issues/:uidValidity/:uid/record`，输入 `TransactionInput` → `{transaction,autoResolvedCount,status}`。
- `POST /api/integrations/mail/issues/dismiss-all`，输入 `{email,accountId,issues:[{uidValidity,uid}]}` → `MailSyncStatus`，仅忽略提交时选中的邮件，每次最多 50 封。
- `POST /api/integrations/mail/issues/restore-dismissed`，输入 `{email,accountId}` → `MailSyncStatus`，恢复该邮箱和账户下手动忽略的邮件。旧版已经忽略的邮件缺少操作来源，无法区分手动忽略和自动过滤。
- `POST /api/integrations/mail/issues/:uidValidity/:uid/dismiss`，输入 `{}` → `MailSyncStatus`，忽略单条无法解析的招行邮件提醒。

后台服务启动时和每 5 分钟通过只读 IMAP（`EXAMINE INBOX` + `BODY.PEEK`）检查新邮件，不改动邮件未读/已读状态。解析器沿用 `1.1.5` SHA-256 交易指纹；从原飞书平滑切换时，重叠日期内已在飞书导入的历史账单会自动跳过。原飞书定时同步已停用。

## 账本

- `GET /api/bootstrap` → `Bootstrap`。
- `GET /api/summary?month=2026-11` → `Summary`。
- `GET /api/transactions` → `TransactionPage`。支持 `month`、`search`、`kind`、`status`、`page`、`deleted`、`date`、`accountId`、`categoryId`、`sort`、`pageSize`；`uncategorized` 表示无分类。`sort` 支持 `newest`（默认）、`oldest`、`largest`、`smallest`；`pageSize` 默认 30，界面使用 12。返回的 `summary` 和 `daily` 覆盖完整筛选范围，仅汇总已确认且未撤销账单，不是当前页小计。
  通过 `spendCategory` 可查看构成分类实际支出的明细。它仅计入已确认、扣除退款后仍有支出的流水。传分类 ID 查看该类目，传 `transfer` 查看未分类转出，传 `uncategorized` 查看其余未分类支出。可同时传 `tagId` 筛选二级标签。
- `POST /api/transactions`，输入 `TransactionInput` → `Transaction`；请求头 `Idempotency-Key` 必填，一次操作及其重试沿用相同值。
- `PATCH /api/transactions/:id`，输入 `TransactionInput & {version:number,reviewStatus?:ReviewStatus}` → `Transaction`，版本冲突返回 409。
- `POST /api/transactions/:id/archive`，输入 `{version}` → `Transaction`。
- `POST /api/transactions/:id/restore`，输入 `{version}` → `Transaction`。
- `POST /api/transactions/:id/confirm`，输入 `{version}` → `Transaction`。
- `POST /api/accounts`，输入 `{name,bank}` → `Account`。

`Summary` 包含支出与收入分类、分日统计和固定支出明细，以及日均支出的 `averageDays` 和 `dailyAverageExpenseCents`。当前月按北京时间已过去的自然日（含今天）平均，历史月份按总天数平均，未来月份日均为 null；图表分日数组仍覆盖整月。`Transaction.isFixed` 只用于支出；旧请求省略时按兼容规则处理，日均扣除已确认固定支出的实际金额。账单写入时可按已确认固定支出识别同账户、同金额且商户匹配的账单。手动取消固定标记后，该笔账单不再参与自动标记。

`Transaction` 返回 `categorySource`（`unclassified`、`manual`、`rule`）及当时命中的 `categoryRuleId`、`categoryRuleKeyword`。客户端明确选择或清空分类时提交 `categoryOverride:true`；只编辑备注等其他字段时省略，保留原分类来源。新账目没有人工分类时才尝试规则。自动分类不改变原始请求回执或飞书来源指纹。

查询响应可包含 `Transaction.refundAdjustment`，表示退款抵扣额、实际支出及退款对应的支出 ID；该字段只读派生，不写入原账目或备份。`expenseCents` 为匹配退款后的实际支出，`grossExpenseCents` 为原支出，`matchedRefundCents` 为归属于所选支出的抵扣额，`unmatchedRefundCents` 为所选范围内未匹配退款。现金流的 `netExpenseCents`／`netIncomeCents` 保留原收付发生月口径。分类、分日、固定支出、日均及上月比较统一使用实际支出。

`Transaction.transferDirection` 为转账的 `inflow`／`outflow` 或 null；非转账为 null。手动转账输入需提供方向，历史未知方向可通过编辑补齐。收入／支出筛选包含相应方向的转账；转账筛选保留两种方向。汇总的 `transferInCents`／`transferOutCents`／`unknownTransferCents` 和相应计数用于说明转账状态，有方向的金额已包含在 `incomeCents`／`expenseCents`，不能再次累加。旧备份从原来源方向补齐，当前用户已确认的方向受保护。

## 类目

- `GET /api/categories` → `CategoryList`。
- `POST /api/categories`，输入 `CategoryInput`（名称、收支范围、图标、颜色）→ `Category`。
- `PATCH /api/categories/:id`，输入 `CategoryInput & {version:number}` → `Category`；版本冲突或同名返回 409，不兼容的收支范围返回 422。

类目使用稳定 ID；外观修改不写入账目。图标与颜色值以共享协议的 `CATEGORY_ICON_OPTIONS` 和 `CATEGORY_COLOR_OPTIONS` 为准。

- `GET /api/categories/:id/deletion-preview?replacementCategoryId=` → `CategoryDeletionPreview`，返回关联账单、分类规则、二级标签及标签规则数量。
- `DELETE /api/categories/:id`，输入 `{snapshot,replacementCategoryId?}` → `CategoryDeletionResult`。已有关联账单或分类规则时需指定接收类目。

## 二级标签

- `GET /api/tags` → `TagList`，包含标签及规则。
- `POST /api/tags`，输入 `{name,categoryId,icon?}` → `Tag`。
- `PATCH /api/tags/:id`，输入 `{name?,icon?,version}` → `Tag`。
- `POST /api/tags/:id/move`，输入 `{direction: 'up' | 'down'}` → `TagList`。
- `DELETE /api/tags/:id`，输入 `{version}` → `{deleted:true}`。
- `POST /api/tag-rules`，输入 `{tagId,keyword,matchType?}` → `TagRule`。
- `PATCH /api/tag-rules/:id`，输入 `{keyword,matchType?,version}` → `TagRule`。
- `DELETE /api/tag-rules/:id`，输入 `{version}` → `{deleted:true}`。
- `PUT /api/transactions/:id/tag`，输入 `{tagId}` → `{tagOverride}`。`tagId: null` 表示手动归入「其他」。
- `DELETE /api/transactions/:id/tag` → `{tagOverride:null}`，恢复按规则推导。

## 自动分类规则

- `GET /api/category-rules` → `CategoryRuleList`，包含内置默认及用户覆盖后的有效规则。
- `POST /api/category-rules`，输入 `CategoryRuleInput` → `CategoryRuleMutationResult`，包含 `updatedTransactions`。
- `PATCH /api/category-rules/:id`，输入 `CategoryRuleInput & {version:number}` → `CategoryRuleMutationResult`，包含 `updatedTransactions`。
- `DELETE /api/category-rules/:id`，输入 `{version}` → `{deleted:true,updatedTransactions:number}`；内置规则被停用，自定义规则被删除。
- `GET /api/category-rules/preview` → `CategoryPreview`，返回完整的匹配账单、未匹配数、冲突数和快照标识。
- `POST /api/category-rules/apply`，输入 `{snapshot}` → `{updated:number}`；快照过期返回 409，批次写入校验并发状态。

规则对交易摘要或主体做包含／完全一致匹配。自定义规则优先于内置规则，同优先级命中不同分类时不自动分类。退款使用支出规则，转账按已确认方向使用收入或支出规则，未知方向不自动分类。规则增改、启停、删除与历史分类更新在同一事务完成。历史重算处理未撤销的未分类和规则分类账目，保护人工分类与人工清空；未匹配或冲突会清空旧规则分类，无变化不增加账目版本。预览条目包含 `previousCategoryId` 和新的分类，清空时 `categoryId`、`ruleId`、`keyword` 为 null。`matchedCount` 为需更新条目数。

## 心愿单

以下接口均使用管理会话认证，写入校验 Origin。心愿独立于账目，价格以整数分保存，输入为十进制文本或 null。

- `GET /api/wishlist?status=wanted|purchased|deleted&search=&page=1` → `WishlistPage`，默认想买，每页 30 项。计数基于搜索范围，合计基于当前状态的全部结果。
- `GET /api/wishlist/:id` → `WishlistItem`，包含已移除记录，供冲突核对。
- `POST /api/wishlist`，输入 `WishlistInput & {id:string}` → `WishlistItem`。客户端 UUID 在重试时保持不变，相同初始内容重试返回现有记录，内容冲突返回 409。
- `PUT /api/wishlist/:id`，输入 `WishlistInput & {version:number}` → `WishlistItem`。
- `POST /api/wishlist/:id/status`，输入 `{status:'wanted'|'purchased',version:number}` → `WishlistItem`，不生成财务流水。
- `POST /api/wishlist/:id/position`，输入 `{position:number}` → 想买队列中受影响的 `WishlistItem[]`。把一项想买的心愿移到第 `position` 位（从 1 开始），其余顺延；已购或已移除返回 409。想买列表按 `position` 升序，新心愿排在队尾；已购、已移除仍按时间倒序。
- `DELETE /api/wishlist/:id`、`POST /api/wishlist/:id/restore`，输入 `{version:number}` → `WishlistItem`，软删除或恢复，保留购买状态。

所有修改检查版本，过期返回 409。商品链接仅允许不含用户名密码的 HTTP(S) 地址。备份包含已购、已移除心愿，恢复与账目共用事务。

## 订阅

以下接口均使用管理会话认证，写入校验 Origin。房租、会员、软件等周期扣费独立于账目，只做提醒与合计，不生成财务流水，避免与银行扣款重复。金额以整数分保存，输入为十进制文本；日期为上海时区的 `YYYY-MM-DD`。

- `SubscriptionInput`：`{name, category:'housing'|'software'|'membership'|'utility'|'insurance'|'other', amount, cycle:'weekly'|'monthly'|'quarterly'|'semiannual'|'yearly', nextDueDate, endDate?:string|null, autoRenew, remindDays:0–60, note}`。
- `autoRenew` 是扣款方式：`true` 自动扣款，过了扣费日自动推到下一期，只在订阅页列出、不提醒；`false` 手动付款（如房租），到日子前在铃铛提醒，过了付款日保持逾期，直到标记已付款。`nextDueDate` 是下次扣费（付款）日，也是锚定日：按月的周期保留锚定日的几号，小月取月末，不会逐期漂移。
- `endDate` 是到期日：服务用到这天为止，这天及以后不再扣费（例如房租交到 6 月 30 日就填 `2027-06-30`，6 月 30 日那期不扣）。没有下一次扣费、但还没到到期日时状态为 `ending`，仍在进行中，进入提醒窗口时铃铛提示即将到期；到了到期日状态为 `finished`，归入已到期，不再提醒、不计入合计。清空或延后到期日即恢复续费。
- 返回的 `Subscription` 附带服务端按今天推算的 `dueDate`（下次扣费日；不再续费时为到期日）、`daysLeft`、`state`（`upcoming`／`soon`／`overdue`／`ending`／`finished`，`soon` 表示进入 `remindDays` 提醒窗口；旧版本手动结束的为 `ended`）、`isFinal`（到期前的最后一次扣费）和按月折算的 `monthlyCents`；`sourceKey` 非空表示从固定支出账单导入。
- `GET /api/subscriptions?status=active|ended&search=` → `SubscriptionList`。进行中的项目按扣费日升序；合计字段 `monthlyCents`、`yearlyCents`、`remainingThisMonthCents`（本月剩余几天内还要付的，含逾期未续的手动项目，到期日当天及以后不算）和 `byCategory` 只统计进行中的项目，不受搜索影响。
- `GET /api/subscriptions/reminders` → `SubscriptionReminders`，只含手动付款（`autoRenew=false`）里 `soon`、`overdue` 以及进入提醒窗口的 `ending` 项目，供右上角铃铛使用；自动扣款的从不提醒。
- `GET /api/subscriptions/suggestions` → `SubscriptionSuggestionList`。识别可能的订阅：最近两年已确认的支出按名称（去掉月份数字与标点）和金额归组，至少 3 笔、相邻间隔都接近同一周期的整数倍，且最近一笔距今不超过两个半周期；标记为固定支出的账单只按名称归组（金额可变），2 笔即可。同来源或同名进行中的订阅、以及被忽略过的不再出现。`autoRenew` 为建议的扣款方式（居住类默认手动付款）。只读，不改动账单。
- `POST /api/subscriptions/suggestions/accept`，输入 `{key, autoRenew}` → `Subscription`（201）。按服务端重新识别的结果新建订阅，扣款方式由用户决定；建议已处理或不再成立时返回 409。`POST /api/subscriptions/suggestions/dismiss`，输入 `{key}` → `{dismissed:true}`，记住这条识别结果，之后不再推荐。
- `GET /api/subscriptions/:id` → `Subscription`，包含已结束记录。
- `POST /api/subscriptions`，输入 `SubscriptionInput & {id:string}` → `Subscription`。相同 UUID 与内容重试返回现有记录，内容不同返回 409。
- `PUT /api/subscriptions/:id`，输入 `SubscriptionInput & {version:number}` → `Subscription`；旧版本手动结束的项目需先恢复续费。
- `POST /api/subscriptions/:id/renew`，输入 `{version:number}` → `Subscription`。已付款：把当前这一期（`dueDate`）往后推一个周期，供手动付款的订阅使用；已不再续费的返回 409。
- `POST /api/subscriptions/:id/end`，输入 `{version:number}` → `Subscription`。不再续费：把到期日设为下次扣费日，已付的一期照常用到那天。`POST /api/subscriptions/:id/restore` 恢复续费：清除到期日（以及旧版本的手动结束），按原周期继续。

所有修改检查版本，过期返回 409。

## 月度预算

月度预算是一个总额，每个月都按同一金额计算剩余额度与每天可花，不按类目拆分。

- `GET /api/budget` → `MonthlyBudget`（`{amountCents:number|null, version:number}`），`null` 表示未设置。
- `PUT /api/budget`，输入 `{amount:string|null, version:number}` → `MonthlyBudget`。`amount` 为十进制文本，`null` 或空白表示取消预算；版本过期返回 409。

剩余预算、每天可花和超支提醒由客户端结合 `Summary.expenseCents`（已扣除退款的实际支出）计算，服务端不保存派生值。

## 备份

- `GET /api/backup` → `Backup`，下载轻记 JSON，包含已撤销账目、结构化来源、请求回执、全部心愿和订阅，不包含密钥、会话、心愿创建请求哈希或完整历史审计。
- `POST /api/backup/restore`，输入 `Backup` → `BackupRestoreResult`，`inserted`／`skipped` 统计账目，`wishlistInserted`／`wishlistSkipped` 统计心愿，`subscriptionsInserted`／`subscriptionsSkipped` 统计订阅，`budgetRestored` 表示是否写入了月度预算；同 ID 且内容相同跳过，有差异返回 409，整批原子写入，不覆盖现有记录。

导出为 `schemaVersion: 7`，包含二级标签、标签规则、账单的手动标签和固定支出排除标记，订阅（只含原始字段；较早的第 7 版备份没有这一项，或缺少到期日与导入来源），以及月度预算、心愿单（含排队顺序 `position`）、转账方向、类目图标、颜色与版本、固定支出标记、分类来源及用户分类规则（包括内置规则的用户覆盖）。代码内的默认规则不重复写入备份。恢复同时接受版本 1–7，旧备份不修改现有心愿单与预算；预算在当前未设置时写入，金额相同视为已有，不同则整批冲突；版本 1 缺失的固定标记按 `false` 处理，旧非空分类、人工创建或曾编辑的空分类按人工分类保护。类目、规则、账目与心愿在同一事务恢复，冲突时整批回滚。全新空库中未使用、未修改的默认类目可按备份恢复名称与样式；现有用户修改受保护。旧版备份不覆盖当前类目的图标和颜色。

单次请求正文上限为 8 MB。完整数据库备份与恢复见 [本地运行与维护](OPERATIONS.md)。

## 既有设备协议

公共账本模块保留设备凭据协议，用于既有客户端兼容；当前本地邮箱同步不使用这些凭据。

- `GET /api/devices` → `Device[]`。
- `POST /api/devices`，输入 `{name,accountId}` → `{device,token}`；令牌只返回一次。
- `DELETE /api/devices/:id` → `{revoked:true}`。
- `POST /api/ingest/cmb`：设备 Bearer 认证和 `Idempotency-Key`，输入招行解析 JSON，返回 `IngestResult`。

只有数据库提交后才返回 `created`、`duplicate` 或 `needs_review`。同一幂等键携带不同内容返回 409；不同身份的指纹碰撞保存为待核对。该接口受本机监听范围约束，不是 iPhone 访问 Mac 的公网入口。

退款详情可用 `GET /api/transactions/:id/refund-expense` 读取当前关联原支出，包含原金额及退款抵扣投影。接口需要账本会话，跨月和分页仍有效；关联失效返回 404，不回退到旧关联。
