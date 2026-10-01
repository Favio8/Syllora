# Syllora 运行目录与命名迁移

用途：2026-10-01 命名统一的兼容与恢复说明；已实现规则，以自动化验证结果为准。

## 新命名

- 自有包为 `@syllora/*`，npm CLI 为 `@syllora/cli`，命令为 `syllora`。
- 桌面产品名 Syllora，应用 ID `ai.syllora.desktop`，更新源为本仓库 Release。
- 浏览器引导为 `window.__SYLLORA__`，桌面桥为 `sylloraDesktop`，IPC
  为 `syllora:host-info`，学习回写标记为 `[SYLLORA_SYNC]`。
- 环境变量前缀统一为 `SYLLORA_`，如 `SYLLORA_HOME`、`SYLLORA_API_URL`、
  `SYLLORA_HOST_URL`、`SYLLORA_WEB_DIST`、`SYLLORA_DESKTOP_USERDATA`。
- 第三方 `@deepseek-ai/*` 包、原始许可与上游文档保留来源名称。

## 数据迁移

先退出旧服务和桌面程序，备份完整工作区与 Host 数据目录。不要仅复制
`credentials.json`：加密凭据必须配合原 `master.key` 使用。

- `pnpm serve` 默认 Host 目录仍为仓库 `.syllora-home/`，业务目录仍为
  `.syllora-data/`；工作区内部状态与模型配置统一存放在 `.syllora/`。
- 旧工作区的 `.studyclaw/` 在第一次访问应用状态时整目录重命名为
  `.syllora/`。配置、密文、大纲、题池、历史、Agent/Memory 文件一起迁移。
- 单独运行 `syllora serve` 的默认 Host 目录为 `~/.syllora/`；没有显式
  Home 配置时，将 `~/.studyclaw/` 整目录迁移，主密钥不会重新生成。
- `SYLLORA_HOME` 优先；旧 `STUDYCLAW_HOME` 暂作为兼容别名，显式指定的
  Home 不自动搬迁。可先保持旧路径运行，再停止服务、手动搬迁目录并修改变量。
- 新旧目录同时存在、旧目录为符号链接或重命名失败时明确报错，保留原文件；
  不覆盖、不合并两组数据。备份后人工选定正确目录，再重试。
- 旧 Host 锁存在时先停止旧服务并核查锁；不通过迁移绕开活跃进程锁。

如需退回旧版本，先停止服务，备份新数据，再把 `.syllora/` 改回
`.studyclaw/`，并恢复旧环境变量。新旧程序不能同时写同一目录。

## 客户端和发布

CLI 名称及 IPC/引导协议变化需要配套更新客户端。旧页面应刷新，旧 CLI
应重新安装；旧包名不再作为发布目标。旧设置中的学习 preset 读取时归一到
`syllora-learning`。发布工作流仍只由明确推送版本 tag 触发；本次命名修复
不会发布 npm 包、桌面安装器或 Release。npm 组织权限与发布凭据须由维护者
在正式发布前配置，不沿用旧仓库的包名或下载地址。

桌面应用身份已变化，旧安装的应用数据不会依据猜测的跨平台路径自动搬迁。
可通过旧应用「打开数据目录」取得原目录，停止应用后将其中的 `host-home/`
完整复制到新应用数据目录；配置与主密钥需一起保留。未签名安装器限制仍适用。
