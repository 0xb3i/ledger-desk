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

- `GET /api/integrations/mail/status` → `MailSyncStatus`。返回配置状态、已连接 QQ 邮箱地址、默认建议起始日期 `suggestedStartDate`、已导入笔数、衔接跳过历史重复笔数、最近同步时间、错误信息以及未能自动解析的招行邮件列表 `issues`。不返回授权码。
- `POST /api/integrations/mail/config`，输入 `{email,authCode?,syncStartDate,accountId?}` → `MailSyncStatus`。先验证 `imap.qq.com:993` 只读登录与 `EXAMINE INBOX`，通过后将 16 位授权码写入 macOS 系统钥匙串、将非凭据配置写入权限 `600` 的 `mail.json`，并立即执行一次同步。
- `DELETE /api/integrations/mail/config` → `MailSyncStatus`。停用邮箱同步、删除 `mail.json` 并移除系统钥匙串中的授权码；已导入的本地账目完整保留。
- `POST /api/integrations/mail/sync`，输入 `{}` 执行增量同步，或输入 `{startDate,endDate}` 执行按日期范围补扫 → `MailSyncStatus`。
- `GET /api/integrations/mail/issues/:uidValidity/:uid` → `MailIssueDetail`，返回待核对邮件摘要和补录草稿。
- `POST /api/integrations/mail/issues/:uidValidity/:uid/record`，输入 `TransactionInput` → `{transaction,autoResolvedCount,status}`。
- `POST /api/integrations/mail/issues/dismiss-all` → `MailSyncStatus`，忽略所有待核对邮件。
- `POST /api/integrations/mail/issues/:uidValidity/:uid/dismiss`，输入 `{}` → `MailSyncStatus`，忽略单条无法解析的招行邮件提醒。

后台服务启动时和每 5 分钟通过只读 IMAP（`EXAMINE INBOX` + `BODY.PEEK`）检查新邮件，不改动邮件未读/已读状态。解析器沿用 `1.1.5` SHA-256 交易指纹；从原飞书平滑切换时，重叠日期内已在飞书导入的历史账单会自动跳过。原飞书定时同步已停用。

## 账本

- `GET /api/bootstrap` → `Bootstrap`。
- `GET /api/summary?month=2026-11` → `Summary`。
- `GET /api/transactions` → `TransactionPage`。支持 `month`、`search`、`kind`、`status`、`page`、`deleted`、`date`、`accountId`、`categoryId`、`sort`、`pageSize`；`uncategorized` 表示无分类。`sort` 支持 `newest`（默认）、`oldest`、`largest`、`smallest`；`pageSize` 默认 30，界面使用 12。返回的 `summary` 和 `daily` 覆盖完整筛选范围，仅汇总已确认且未撤销账单，不是当前页小计。
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

## 月度预算

月度预算是一个总额，每个月都按同一金额计算剩余额度与每天可花，不按类目拆分。

- `GET /api/budget` → `MonthlyBudget`（`{amountCents:number|null, version:number}`），`null` 表示未设置。
- `PUT /api/budget`，输入 `{amount:string|null, version:number}` → `MonthlyBudget`。`amount` 为十进制文本，`null` 或空白表示取消预算；版本过期返回 409。

剩余预算、每天可花和超支提醒由客户端结合 `Summary.expenseCents`（已扣除退款的实际支出）计算，服务端不保存派生值。

## 备份

- `GET /api/backup` → `Backup`，下载轻记 JSON，包含已撤销账目、结构化来源、请求回执和全部心愿，不包含密钥、会话、心愿创建请求哈希或完整历史审计。
- `POST /api/backup/restore`，输入 `Backup` → `BackupRestoreResult`，`inserted`／`skipped` 统计账目，`wishlistInserted`／`wishlistSkipped` 统计心愿，`budgetRestored` 表示是否写入了月度预算；同 ID 且内容相同跳过，有差异返回 409，整批原子写入，不覆盖现有记录。

导出为 `schemaVersion: 7`，包含二级标签、标签规则、账单的手动标签和固定支出排除标记，以及月度预算、心愿单（含排队顺序 `position`）、转账方向、类目图标、颜色与版本、固定支出标记、分类来源及用户分类规则（包括内置规则的用户覆盖）。代码内的默认规则不重复写入备份。恢复同时接受版本 1–7，旧备份不修改现有心愿单与预算；预算在当前未设置时写入，金额相同视为已有，不同则整批冲突；版本 1 缺失的固定标记按 `false` 处理，旧非空分类、人工创建或曾编辑的空分类按人工分类保护。类目、规则、账目与心愿在同一事务恢复，冲突时整批回滚。全新空库中未使用、未修改的默认类目可按备份恢复名称与样式；现有用户修改受保护。旧版备份不覆盖当前类目的图标和颜色。

单次请求正文上限为 8 MB。完整数据库备份与恢复见 [本地运行与维护](OPERATIONS.md)。

## 既有设备协议

公共账本模块保留设备凭据协议，用于既有客户端兼容；当前本地邮箱同步不使用这些凭据。

- `GET /api/devices` → `Device[]`。
- `POST /api/devices`，输入 `{name,accountId}` → `{device,token}`；令牌只返回一次。
- `DELETE /api/devices/:id` → `{revoked:true}`。
- `POST /api/ingest/cmb`：设备 Bearer 认证和 `Idempotency-Key`，输入招行解析 JSON，返回 `IngestResult`。

只有数据库提交后才返回 `created`、`duplicate` 或 `needs_review`。同一幂等键携带不同内容返回 409；不同身份的指纹碰撞保存为待核对。该接口受本机监听范围约束，不是 iPhone 访问 Mac 的公网入口。

退款详情可用 `GET /api/transactions/:id/refund-expense` 读取当前关联原支出，包含原金额及退款抵扣投影。接口需要账本会话，跨月和分页仍有效；关联失效返回 404，不回退到旧关联。
