# 统一工作台与 Host 接口

用途：0.1.2-beta 开发与交付契约。日期：2026-10-02。状态：实现完成后的接口说明；实际验收以工作区任务报告为准。

PR #43 的布局、图标、菜单、首页、阅读交互和主题迁入 `apps/web/src/features/workbench/`。正式首页由 `Syllora.tsx` 统一管理课程、作答、证据和计划。Electron 组装 `apps/web/out`，Web 与桌面没有独立前端源码、启动器或模拟业务服务。

## 启动与构建

仓库根运行 `pnpm install --frozen-lockfile`、`pnpm build:web`、`pnpm serve`；浏览器进入终端所示本机地址。开发运行 `pnpm --filter web dev`，沿用 Host 代理和布局中的 token 注入。桌面目录执行 `node scripts/assemble-host.mjs --build` 后运行 `pnpm --filter @syllora/desktop dev:desktop`。安装包仍从相同静态导出组装。

左下角「用户 → 设置」管理供应商与外部调用授权；「用户资料」进入称呼、主题和新计划默认分钟数。课程入口为「新建课程」，实际选择已有课程文件夹，可填写显示名称和图标。归档课程可从课程目录或设置的数据管理恢复。结束当前会话调用 Host 的 `endSession`，不会删除课程。

## 服务与响应协议

`POST /api/syllora/<action>` 请求体为 `{payload}`，响应 `{result}` 或 `{error:{code,message}}`。供应商、目录浏览和诊断继续使用通用 RPC `/api/<method>`，响应 `{ok:true,result}` 或 `{ok:false,error}`。客户端分别解析两种协议，统一抛出带业务编码的 `ApiError`，携带 Host Bearer token；生成接受请求后以真实 Job 查询结果。网络结果未知时保留逻辑请求 ID 并查询原任务，重试沿用该 ID。浏览器恢复缓存只保存请求 ID，不保存凭据。

新增或扩展的动作：

| 动作 | 请求 | 返回与约束 |
| --- | --- | --- |
| `uiPreferences` | `{}` 读取；保存 `name,theme,dailyMinutes,baseVersion` | 称呼 1–16 字，主题 light/dark，默认分钟 5–480，返回 `revision`；冲突为 `VERSION_CONFLICT`。共享偏好独立持久化，不改变外部调用授权。 |
| `coursePresentation` | `courseId,icon` | 持久化 12 类课程图标；`openCourse` 和 `rename` 也支持可选 `icon`。旧课程使用通用图标。 |
| `readingDocument` | `courseId,materialId` | 当前课程发布版本、来源 ID/锚点、正文、解析状态、失败页与已鉴权原件入口。已删除或停用资料不可读。 |
| `generate` | 原参数及可选 `reading:{materialId,revision,selection,sourceIds,mode}` | 仅 answer 支持阅读上下文；校验课程归属、发布版本和真实选区，生成和发布前均校验。解释使用所选片段及邻近资料；搜索在当前课程已发布资料中检索候选再解释，不联网搜索。 |
| `activity` | `{}` | 返回真实持久化活动；`state` 同时返回 `uiPreferences,activity`。完成任务和成功问答/阅读任务按对象 ID 去重。 |
| `saveDraft` | 原参数及可选 `baseVersion` | 返回 `version`。新版客户端使用乐观并发；旧客户端不传版本仍兼容。冲突保留本页输入，用户明确重载后才覆盖；未保存输入另有按课程隔离的本页刷新恢复缓存。 |

Job 可返回 `resultMessageId`；阅读结果与 `jobId`、版本和上下文一起保存到消息。删除资料清除其选区和回答文本，活动历史仅保留成功事件的统计事实。聊天清除与已接受问题一致的服务端草稿，迟到请求不会清除后续输入。`uiPreferences` 文件位于共享数据目录 `.syllora/ui-preferences.json`，活动与课程图标位于课程快照。

## 数据与兼容

课程 UUID、计划版本、来源版本、作答、学习会话与证据继续由 Host 决定。五档证据为未评估、待验证、待加强、初步掌握、复测通过，页面不推断掌握度。旧快照未记录活动时显示空历史；旧时长、用量等显示未知，不补造过去记录。统计中的分钟数为已完成任务的建议时长，不是实际计时；问答与阅读只计互动次数。

模型配置与加密凭据沿用原设置实现，不从独立 UI 的浏览器存储导入配置，也不导入演示课程。删除课程仅删除 Syllora 管理产物与学习记录，保留原始资料。目录缺失与删除未完成入口在课程目录中展示。

## 回归入口

`pnpm test` 覆盖 Host 契约及 Web 组件；`pnpm typecheck`、`pnpm build:web` 检查完整类型图和静态构建。`scripts/syllora-e2e.ts` 使用明确标识的本地受控模型，可通过 `SYLLORA_E2E_PROTOCOL=anthropic` 验证 Messages 协议。它保留原计划、判分、争议、来源和 PDF 业务断言，并增加阅读与活动验证。`scripts/syllora-verify-issue4.ts`、`scripts/syllora-verify-sessions.ts` 保留排程和会话回归。

独立工程原测试中有效的并发、防止迟到复活、偏好冲突、存储失败及旧快照兼容边界已纳入 Host/正式 Web 回归。原模拟服务、模拟 API 配置、固定答案与重置演示数据不属于正式契约。

真实供应商验收由用户后续配置后进行；受控模型通过不能代替真实模型的答案、引用和近重复人工核验。真实多日学习效果及全量 PRD 发布签核另行记录。
