# 课程文件夹与资料初始化

用途：开发与恢复契约。日期：2026-10-02。状态：用户批准方案已实现；真实模型教学内容尚待人工抽检。

## 存储与身份

一个本地文件夹对应一门课程。首次打开创建持久化 UUID，重命名只改显示名称。
搬迁后重新打开新目录即可恢复身份；原路径仍存在时拒绝打开同 UUID 的复制目录，
避免同一课程在两个位置写入。任务绑定启动时的目录，切换页面不改变其写入目标。

```text
课程根目录/
  原始资料.md、子目录/...         用户文件，保持原样
  sources/                       上传或粘贴的新资料，重名追加序号
  .syllora/
    course.json                  单课程快照、学习记录、任务、当前 revision
    .staging/cache/              按内容与模型配置复用的解析／讲义检查点
    .staging/<任务 UUID>/         尚未发布的产物
    revisions/<版本 UUID>/
      parsed/<资料 ID>.md        解析正文（PDF 按物理页标注）
      sources.json               来源、结构定位、原文与上下文
      outline.json               本次整理的知识点
      lectures.json              结构化讲义
      lectures/<章节 ID>.md      可独立阅读的 Markdown
      manifest.json              文件指纹、失败范围、来源覆盖与模型版本
```

`course.json` 使用原快照 `version: 1`，`courses` 中仅一个课程；包含 `jobs`、
诊断调用数及兼容字段。课程的 `revision` 指向已发布产物。模型配置、加密凭据、
调用授权与最近课程路径存放于应用数据目录的 `.syllora/`，不复制到课程目录。
加密主密钥继续位于 Host Home。迁移和备份须保留原主密钥。

先完整写入暂存产物、校验来源与选中文件指纹，再将目录重命名为不可变版本，
最后原子替换快照中的版本指针。取消、校验失败、文件变化与进程中断保留旧指针；
中断任务重新打开后标记失败，用户可重试。极端中断可能留下未引用版本，删除课程
时统一清理。仅支持一个 Host 写同一课程目录，不提供跨进程数据库锁。

## 检查、整理与学习

扫描排除隐藏路径、`.syllora`、依赖和构建目录，不跟随目录链接。接受文本 PDF
及 UTF-8 MD/TXT；单文件最多 20 MiB，单 PDF 最多 50 页，课程选中文本 PDF
合计最多 100 页、解析正文最多 100,000 个 Unicode 字符。扫描件无正文时明确失败；
空页或部分解析失败必须由用户排除或接受可用部分，失败范围保存在任务与 manifest。

Markdown 先识别标题、段落、列表、围栏和表格，普通片段目标约 1,800 字符，
超过 2,400 才按句子或完整行续分。超长单行必须按容量切分。补充标题与续段表头
放入 `context`，原文保存在 `text`；定位 `start/end` 使用 JavaScript UTF-16
偏移，可在对应解析正文中复核。PDF 来源保留物理页码与跨页邻接关系。

初始化按章节及单次上下文容量分批处理全部选中来源，没有全课程 30 个知识点
或前 22,000 字符截断。讲义包括导读、解释、原文依据、实际例子、知识联系和
独立标识的教学类比。引用必须属于本批资料，摘录必须逐字存在，所有来源须关联
到讲义；这些检查不证明每个结论都语义正确，真实供应商仍需人工抽检。

每批失败自动重试最多一次。用户重试复用内容未变化且模型配置相同的检查点，
未完成批次继续生成；新任务使用新 requestId，重复提交同 requestId 返回原任务。
问答／题目使用课程已发布来源版本；中文匹配增加词项和字符片段及邻接内容。
上下文先为各份候选资料保留相关片段，再填充剩余容量；容量不足时如实记录未使用
范围。任务 `coverage` 保存实际来源 ID、课程 revision、使用／候选片段和原文字符数、
仍有省略片段的资料名称；这些是本次候选范围的覆盖，不代表已阅读整个课程。
历史来源保留以维护旧题目和作答证据。新产物不改写作答、既有范围与计划。
资料变化仅展示增量，用户点击更新后才发布。

材料 `version` 保留内容指纹（兼容旧数值版本），`revisionNumber` 显示正文版本序号；
同一路径正文变化递增，未变化时保持序号与资料 ID。历史来源仍在 `history` 中。
上传同名不同正文时保存到不同路径，各自建立独立资料；不覆盖用户文件。
PDF `pageIssues` 区分 `blank-page` 与 `unextracted-text`，解析器异常保留具体原因。

PDF 预览读取课程中的原文件，经课程／资料归属、路径边界、容量与指纹校验。
前端通过 Authorization 请求头取得二进制并使用临时 blob 预览，关闭即释放 URL；
预览地址不携带凭据，浏览器未提供 PDF 内嵌查看时可下载同一份已鉴权原件。
原件变化返回 `SOURCE_CHANGED`（409），用户确认更新后再预览。
旧版本解析正文继续可用，不声称用户覆盖掉的旧 PDF 字节仍存在。

## 接口

接口沿用 `/api/syllora/<动作>` POST、访问 token 与 Origin 检查；请求正文为
`{ "payload": { ... } }`。现有学习接口仍携带 `courseId`，按该 ID 路由到独立目录。

| 动作 | payload 主要字段 | 返回 |
| --- | --- | --- |
| `openCourse` | `path`，可选 `name`、`timezone` | `id`、`path`、`created` |
| `scan` | `courseId` | `files`（路径、大小、状态、变化、指纹）、`missing` |
| `import` | `courseId`、`name`、`text` 或 `base64` | 保存路径、`pending`、`duplicate` |
| `initialize` | `courseId`、UUID `requestId`、`paths`，可选 `fingerprints`、`acceptPartial` | `jobId` |
| `state` | 空对象 | 课程、任务、最近路径与错误、旧课程入口、共享授权与调用诊断 |
| `cancel` | `courseId`、`jobId` | 保存结果 |
| `lectures` | `courseId` | `revision`、`lectures` |
| `materialFile` | `courseId`、`materialId` | 原文件元信息和 `base64`（兼容 RPC 客户端） |
| `migrateCourse` | 旧 `courseId`、目标 `path` | `id`、`path`、`migrated` |
| `restorePointSources` | `courseId`、原 `pointId`、用户确认支持同一概念的 `replacementPointId` | 保存结果；原节点、任务与作答 ID 保留 |

任务 `progress` 包含扫描／解析／整理／校验阶段、`done/total`、`failures` 与说明。
扫描发生在调用模型之前，初始化请求立即返回持久化任务。兼容旧自动化客户端的
`create` 在应用数据目录创建课程子文件夹，`generate(kind: outline)` 转入初始化；
首页采用用户选择目录与显式检查清单。

`GET/HEAD /api/syllora/material-file?courseId=<UUID>&materialId=<UUID>` 返回
PDF 原字节，沿用 token／Origin 门禁，包含 `nosniff` 与 `private, no-store`。
无令牌返回 401、跨站 Origin 返回 403、非法 ID 返回 400、外课程或已删除资料返回
404；HTTP 集成用例覆盖原件字节一致性与文件变化拒绝。

## 迁移与删除

首页为旧 `syllora.json` 中每门课程提供迁移入口。用户指定已有目标文件夹，
目标已有课程或同 UUID 已迁移时拒绝覆盖。课程、知识点、来源、计划、题目、
作答、操作与任务历史 ID 保留；运行中的旧任务按中断恢复规则处理。
旧应用已保存的 PDF 经指纹校验后复制到目标 `sources/`，保留原存储，不覆盖目标文件；
仅有片段的旧资料标记“缺少原文件”，不得当作完整解析结果；补充原文件后再初始化。
旧快照一直保留，迁移失败可重新选择目标并重试。

删除课程须明确确认，先取消并等待任务，再清理本应用管理的 `course.json`、
`revisions/` 与 `.staging/` 并移除最近课程记录。根目录、原资料、上传正文和继承
模块其他 `.syllora` 文件保留。删除单份资料会使引用失效并清理整理版本，需重新
初始化讲义；用户原文件仍留在目录中。

## 2026-10-02 恢复与诊断契约

`state.courses[].blockedPointIds` 列出缺少当前活跃来源的节点。历史来源可维护旧记录，
但不用于新学习生成。`NextAction.kind` 新增 `waiting` 和 `blocked`；前者的
`availableAt` 是任务日期在课程时区的起点（含夏令时），后者指向补充资料入口。
`start`、打开既有复习及任务绑定生成会在服务端检查计划日期和当前来源，提前执行
返回 `TASK_NOT_DUE`，来源失效返回 `NO_USABLE_SOURCE`。

`restorePointSources` 校验两节点均属于当前课程且替代节点有当前可用来源；只复制
用户明确确认的来源关联，不改原节点名称、任务和作答，也不复活已失效旧题。
新增复习保留原计划占用，按日窗口与休息日排入剩余容量；确认前原计划不变。
错答反馈 `planAdjustment.code` 可为 `SKIPPED_EXISTING_REVIEW`，表示已有未完成
复习，不新建空草案；原有 `GENERATED` 与 `SKIPPED_EXISTING_DRAFT` 行为保留。

Job 新增可选诊断字段 `promptVersion`、`ruleVersion`、`finishedAt`、`elapsedMs`、
`errorCode`。来源整理 prompt 标记 `lecture-v1`，问答／题目标记
`syllora-teaching-v2`，当前证据规则为 `syllora-v1`。旧 Job 无字段时不伪造值。
故障代码包括 `QUOTA_EXCEEDED`、`RATE_LIMITED`、`UPSTREAM_TIMEOUT`、`CANCELLED`、
`MODEL_AUTH_FAILED`、`OUTPUT_TRUNCATED`、`STORAGE_ERROR` 和校验类错误；不持久化
任意供应商响应作为用户错误说明。争议题新增可选 `dispute.reason/at` 审计信息。

最近课程注册表新增可选 `deletion: pending|failed`。清理前先持久化删除意图并
排空/取消学习任务，阻止已进入但尚未创建 Job 的迟到请求和后续事务。中途失败
保留注册表标记，重启后仍拒绝普通读写及重新打开；`state.projects` 展示错误与
重试入口。重复并发删除返回 `DELETING`，已标记的课程可用确认删除请求继续清理。
只有清理和注册表移除均成功才返回完成。旧注册表无需手动迁移。

课程 JSON 与共享配置 YAML 均使用唯一临时文件、刷盘和原子替换；Windows 临时
占用（EPERM/EACCES/EBUSY）最多追加 5 次短暂退避。永久失败保留正式文件并清理
自己的临时文件，不通过先删除正式文件实现覆盖。文件格式与供应商写锁顺序不变。

## 学习记录兼容

课程仍保留原有 ID 与 JSON 快照。新增可选会话/观测、参数修订及新作答的规则/资料/计划快照；不改写历史作答、旧资料 ID 和原文件。缺少这些字段的旧课程可打开，旧作答不伪造会话，旧规则仍按默认重放。参数与会话契约见 [LEARNING_OBSERVATIONS.md](LEARNING_OBSERVATIONS.md)。

## 单份资料删除与并发初始化

同一 Host 内，`deleteMaterial`、`initialize`、全部 `generate`（包括 `kind: outline` 兼容入口）与 `import` 共享课程级操作守卫。删除单份资料从标记失效、取消并排空旧 Job 到清理 `revisions/`、`.staging/` 完成一直持有守卫；新初始化不能在清理期间发布随后被删除的版本。初始化在配置读取等尚未创建 Job 的阶段也持有守卫。冲突明确返回 `COURSE_BUSY`，客户端应查询原操作结果后重试；普通查询和其他课程不受此守卫阻断，完成或失败后释放守卫。

删除整门课程在单份资料清理期间同样返回 `COURSE_BUSY`；其原有持久化删除意图及迟到请求阻断不变。这是单 Host 内的保护，不支持多个进程共享可写课程目录。确定性测试覆盖两种初始化入口、排空旧任务、实际清理阶段、Job 前等待、另一课程可用及清理后成功重建。
