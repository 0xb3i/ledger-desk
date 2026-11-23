# 项目约定

- [本机服务同步] 用户日常使用的是安装版轻记 `http://127.0.0.1:43927`（LaunchAgent 运行 `~/Library/Application Support/Qingji/current` 下的发布目录），不会读取源码改动。每次改完代码并通过 `npm run check` 与 `npm test` 后，运行 `npm run install:local` 重新构建安装，再用 `/api/health` 和页面确认 43927 已是新版本。涉及新迁移时，安装前先用 `sqlite3 ... ".backup ..."` 把 `data/ledger.sqlite` 快照到 `~/Library/Application Support/Qingji/pre-install-backups/`。开发预览端口（43928/5173 等）只用于临时验证，不能代替这一步。
