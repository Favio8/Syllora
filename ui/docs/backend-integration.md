# 后端对接边界

## 当前数据链路

组件 → useWorkspace → WorkspaceService → mockService → localStorage。

本地存储键：`syllora-ui.workspace.v1`。TXT / Markdown 资料包含可选 `content` 正文，PDF 仍为元数据；旧数据兼容，不需要清空课程。聊天和阅读助手为本地演示，不发送业务 API 请求。

课程包含可选 `icon: CourseIconId`。新建服务为 `createCourse(name, icon)`，图标必选；选项 ID 为 `math`、`statistics`、`code`、`science`、`physics`、`language`、`literature`、`art`、`music`、`geography`、`history`、`notebook`。对接后端时保存并返回该 ID，不传 SVG 或组件名称。旧课程缺少图标时使用默认映射，未知选项回退为通用笔记图标；重命名保留图标。

`WorkspaceService` 位于 `src/types/index.ts`。后续新增 `src/services/api.ts` 实现这一契约，在 `src/services/index.ts` 切换导出。前端状态按操作返回的最新 `WorkspaceData` 更新。

## 与现有后端的关系

原项目使用 `/api/syllora/<action>` 与 `{ payload }` 请求封装；新 UI 的 DTO 为独立的界面模型，不直接导入后端 domain 文件。真实对接时应在服务适配层映射后端状态，尤其是课程、学习任务、资料与知识点证据。

以下是前端服务适配职责；当前导出仍为 mock，不代表这些方法已经发起 HTTP 请求：

| UI 服务 | 对接职责 |
|---|---|
| load | 读取课程列表与个人设置，转换为 WorkspaceData |
| createCourse / renameCourse | 创建、重命名课程后刷新状态 |
| setCourseArchived | 保存课程归档状态；归档不删除资料、消息或学习历史 |
| deleteCourse | 明确确认后删除课程及关联资料元数据、消息与记录 |
| toggleTask | 映射明确的任务完成 / 恢复操作；避免直接提升证据状态 |
| addMaterials | 升级为接收 File / FormData，上传真实文件、显示解析状态 |
| removeMaterial | 删除资料后刷新关联课程与证据 |
| appendMessage / reply | 联调时重构为统一 sendMessage；对接真实会话与流式响应 |
| savePreferences | 映射后端设置或保留前端个人偏好 |
| saveApiConfig | 保存非密钥模型配置；真实密钥应由后端安全管理 |
| recordActivity | 记录练习完成、阅读操作；对话与任务完成也生成日期记录 |
| reset | 仅为演示功能，真实模式不提供清空服务器数据操作 |
| ReadingService.document | 获取指定资料的解析正文，统一标题、来源与内容 |
| ReadingService.assist | 接收资料、选中文字及 explain / search 操作，返回解释或检索段落 |

阅读使用独立 `ReadingService`，同样从 `src/services/index.ts` 导出。选区操作仅在正文内部生效；切换资料会清除浮层与旧结果，异步结果通过请求版本隔离。

用户菜单目前使用本地个人偏好；退出状态使用 `sessionStorage` 中的 `syllora-ui.signed-out`，不清空课程。后续认证对接时应替换为真实 session / logout 流程，并补充正式协议。学习模式只保存在当前页面状态中。

`Preferences.theme` 为可选的 `light / dark`，缺少时使用浅色；通过 `savePreferences` 保存，用户点击“保存外观”后应用。旧 `compact` 字段保留以兼容历史数据，但界面不再使用或提供该选项。转场遵循系统 `prefers-reduced-motion`，没有单独的动画开关。

课程的可选 `archived` 字段用于归档；缺少字段视为正在学习。侧栏、主页、资料库和复习列表默认使用未归档课程，课程目录可切换正在学习 / 已归档 / 全部课程；统计保留归档课程的历史。删除课程会同时移除本地相关活动，原始文件不受影响。

`WorkspaceData.activity` 是可选 `LearningRecord[]`，旧数据补入带 `demo: true` 的示例历史。日期使用 Asia/Shanghai 的 YYYY-MM-DD。任务完成记录携带 `taskId` 和建议分钟数；取消完成移除对应记录，重复完成不会重复累加。随堂练习完成追加练习记录，对话提问和阅读操作只计互动次数。统计中的分钟数不是实际在线时长；真实计时需要由后端或独立会话计时器提供。示例记录可通过主页开关排除。

`WorkspaceData.apiConfig` 保存 `baseUrl`、`model`、`format`（compatible / native）、`temperature`。格式仅是未来适配器选项，尚未实现任何提供方的请求格式。前端“检查配置格式”验证 HTTP / HTTPS 地址与模型名称，不请求接口。API 密钥仅在当前标签页 `sessionStorage` 的 `syllora-ui.api-key` 中；未来真实模式应替换该演示方式，在服务端管理密钥与连接校验，避免把共享密钥发送给客户端。

## 联调前先确定

1. 课程、任务、知识点和消息 ID；前端名称和后端字段的映射。
2. 认证方式、API 基础地址和跨域方式。真实认证只在 API 适配层处理。
3. 请求 / 响应封装、错误码、超时与取消。
4. 上传大小限制、文件内容处理、解析进度与失败重试。
5. 聊天流式事件、消息顺序、发送中切换课程和失败重试。
6. 任务活动完成与知识点证据状态的独立语义。

## UI 设计约定

- 色彩：克莱因蓝 #002FA7、正文 #242630、次级文本 #838692、分隔线 #E9EAF0、侧栏 #F7F8FA、白色 #FFFFFF。
- 深色：画布 #101724、卡片 #171F2E、侧栏 #131B28、正文 #DCE5F3、操作蓝 #8DADFA；主题作用于页面、图表与浮层菜单。
- 字体：Syllora 品牌与英文使用 DM Sans；中文使用系统无衬线字体；进度数字使用等宽字体。
- 布局：左侧为 76px 图标导航栏，名称在右侧悬停显示。对话模式保留学习面板；阅读模式使用正文与阅读助手。窄屏使用抽屉导航与阅读结果浮层。
- 主页：作为初始页面，汇总课程、活动和学习入口；应用图标返回主页，顶部“我的课程”进入课程目录。页面切换为当前 UI 状态，尚未使用独立 URL 路由。
- 工作台：课程名称旁的菜单依次为更换课程、课程归档、重命名；更换课程保留当前学习模式。模式切换按钮位置固定，面板使用自己的收起与展开入口，收起栏只显示展开按钮。
- 动效：大多数反馈为 140–240 ms 的淡入、位移或缩放，系统开启减少动态效果时禁用动画与转场。
- 特征：以向量方向图呼应线性代数示例；克制的蓝色用于下一步操作，保持原项目的清爽学习氛围。

UI 独立交付不要求宿主注入、Electron 或模型调用；未来接口契约变化集中处理在服务适配层。

## 当前 TypeScript 契约与调用规则

完整参数及返回类型以 [src/types/index.ts](../src/types/index.ts) 为准，入口为 [src/services/index.ts](../src/services/index.ts)。

- `WorkspaceService` 的所有方法返回 `Promise<WorkspaceData>`；写操作成功后组件使用整份快照更新。后端返回 `{saved:true}`、`{id}` 或 `{jobId}` 时，适配器必须再次读取状态并转换，不能把它们当成 `WorkspaceData`。
- `createCourse(name, icon)`：名称 1–40 个字符；`renameCourse(courseId, name)` 使用相同限制。后端名称可接受更长范围，但当前 UI 以 40 为上限。
- `savePreferences({name, dailyMinutes, compact, theme})`：UI 称呼最多 16 个字符，分钟范围 5–480。`compact` 是历史兼容字段，主题缺省为浅色。
- `addMaterials(courseId, files)` 当前只接收 `{name, size, content?}[]`。`size` 为字节；TXT/MD 本地上限 1 MiB，PDF 上限 20 MiB。PDF 原字节没有进入服务，不能直接接入真实上传；需先把文件入口改为保留 `File` 或其字节。
- `ReadingService.document(courseId, materialId)` 返回 `{id,name,title,content,source}`。`source` 目前只有 `demo/local/unavailable`，接后端正文前要增加远端来源及解析中、失败等状态，避免误标成本地文本。
- `ReadingService.assist(document, selection, mode)` 返回 `{mode,selection,explanation,matches:[{title,excerpt}]}`；目前是一次性结果，不包含请求取消参数、文档修订号、引用位置或外部网页地址。
- `LearningRecord.date` 使用 `YYYY-MM-DD`，消息 `createdAt` 为 ISO 时间字符串，文件 `addedAt` 为日期显示字段。DTO 的 `version:1` 是前端存储版本，不是后端课程或计划版本。

## 已核对的仓库后端接口

下面依据本分支基线 `edd4ffe0e51d8cd989a1c9462752e0c223a8ddc4` 的代码核对。现有接口已经存在于仓库，本 UI 尚未调用；下表是接入清单，不是新增后端实现。

代码参考：[SylloraProjects](../../packages/host/chat-service/src/syllora-projects.ts)、[SylloraService](../../packages/host/chat-service/src/syllora.ts)、[HTTP 路由](../../apps/cli/src/bin.ts)、[领域结构](../../packages/host/chat-service/src/syllora-domain.ts)、[供应商 RPC](../../packages/host/apiproxy/src/index.ts)。目录与初始化详见 [COURSE_PROJECTS](../../docs/COURSE_PROJECTS.md)。

### 请求、响应和认证

Syllora 业务动作采用 `POST /api/syllora/<action>`，JSON 请求为 `{ "payload": {...} }`。成功响应是 `{ "result": ... }`；失败响应是 `{ "error": { "code": "...", "message": "..." } }`，业务失败通常为 HTTP 409，校验失败为 400。网络、非 JSON、401/403 和业务错误都应转换成前端可读的服务异常。

现有通用 `/api/settings.*` RPC 使用另一种信封：`{ "ok": true, "result": ... }` 或 `{ "ok": false, "error": {...} }`，业务错误可以随 HTTP 200 返回。不能共用只检查 HTTP 状态的成功逻辑。

请求仍需宿主访问 token（`Authorization: Bearer <host-token>`）和 Origin 校验。当前 UI 没有 `window.__SYLLORA__` 注入，也没有读取 `host.json`；独立部署时须确定合法的 token 获取方式。`output:'export'` 产物不提供运行时 Next.js API 路由或代理，应使用同源反向代理/宿主静态托管，或经过后端配置的跨源方案。不能仅添加前端环境变量就假设 CORS、token 与代理已完成。模型 API Key 与宿主 token 是两种凭据。

下面请求和返回结构是仓库现有协议示例，所有 ID 均为占位：

```http
POST /api/syllora/rename
Content-Type: application/json
Authorization: Bearer <host-token>

{"payload":{"courseId":"<backend-course-uuid>","name":"线性代数"}}
```

```json
{"result":{"saved":true}}
```

收到保存成功后再调用 `state` 并映射 UI 快照。

### 可复用动作与需要改造的 UI

| UI 服务/入口 | 已有动作与 payload | 返回/接入注意 |
|---|---|---|
| `load()` | `state`：`{}` | `{courses,jobs,projects,legacyCourses,settings}`；`settings` 是授权/诊断，不是 UI Preferences |
| 新建课程 | `openCourse`：`{path,name?,timezone?}`；兼容 `create`：`{name,requestId,timezone?}` | 返回实际 `{id,path,created}`；目前纯名称+图标表单没有目录入口；`create` 会创建应用数据目录下的课程文件夹，不能默默替代用户目录选择 |
| `renameCourse` | `rename`：`{courseId,name}` | `{saved:true}`；再次 `state`；图标尚无存储字段 |
| `setCourseArchived` | `archive`：`{courseId,archived}` | `{saved:true}`；后端归档会结束会话并取消相关生成，不只是切换 UI 标签 |
| `deleteCourse` | `delete`：`{courseId,confirmed:true}` | 保留用户目录与原文件；失败保留 `projects[].deletion`，必须显示重试清理状态 |
| 添加资料 | `import`：`{courseId,name,text? 或 base64?}` | 返回 `{path,pending,duplicate}`；仅上传到 `sources/`，不等于已解析的 Material |
| 检查并整理资料 | `scan`：`{courseId}`；`initialize`：`{courseId,requestId,paths,fingerprints?,acceptPartial?}` | 扫描返回文件/缺失列表，初始化返回 `{jobId}`；需增加检查清单、解析进度和取消入口 |
| `removeMaterial` | `deleteMaterial`：`{courseId,materialId}` | 保存后重读状态；来源、讲义及任务可能失效，不能仅移除列表行 |
| `appendMessage/reply` | `generate`：`{courseId,requestId,kind:'answer',prompt,taskId?}` | 返回 `{jobId}`；后端已追加用户消息，不能再重复本地 append；轮询 `state.jobs` 并读取最终消息 |
| 开始/完成学习 | `start`、`explainDone`：`{courseId,taskId}` | 现有后端无任意 `toggleTask`；计划日期、独立作答与完成规则由服务端检查；需重构 UI 的勾选完成入口 |
| 练习与复习 | `review`：`{courseId,pointId}`；`generate(kind:'question',taskId,slot,requestId)`；`submit`：`{courseId,questionId,requestId,option}` | 需要真实题目、助答标记、题目状态与幂等编号；当前练习为固定示例，不能上传示例结果当成证据 |
| 查询讲义/原文 | `lectures`：`{courseId}`；`materialFile`：`{courseId,materialId}` | 讲义不是完整资料原文；PDF 原件另有受鉴权保护的 GET/HEAD `material-file`；正文版本/锚点的阅读接口仍需设计 |
| 模型配置 | `settings.get`、`settings.saveProvider`、`settings.setCredential`、`settings.activateProvider` | 使用通用 RPC 信封；必须确定 provider ID 与 `openai/anthropic` protocol，再单独保存密钥并激活；当前 `compatible/native` 不能直接当后端协议值 |
| 外部调用授权 | `preferences`：`{consent}` | `{saved:true}`；这是资料外发授权，与称呼/主题/每日分钟数无关；本 UI 接真实 AI 前需增加授权入口 |
| `savePreferences`、课程图标 | 无同形业务动作 | 可先由前端以真实 UUID 为键保存，或明确增加受校验的服务端 UI 偏好字段；不能塞进仅接受 consent 的 `preferences` |
| `recordActivity` / 统计 | 后端 `courses[].sessions/learningEvents/metrics` | 本地建议分钟数不等于真实会话时长；需明确事件与统计投影，不追加虚构在线时间 |
| `ReadingService.assist` | 当前无同形“选区解释/选区搜索”业务动作 | 建议独立服务，携带课程、资料、正文修订号与选区定位；互联网搜索另行设计，不把本地段落检索描述成联网搜索 |
| `reset` / 退出 | 仅前端演示行为 | 真实模式禁用服务器数据重置；真实账号/退出尚无对应认证实现 |

`generate` 的参数中 `requestId` 为 UUID，同一次请求重试应保留该值。后台生成和课程初始化都需要观察持久化 Job；观察超时不代表服务器失败，不能自动换 requestId 重发。轮询、取消、失败和重新加载应围绕原 Job。若后续选择 `/api/chat/stream` 的 Agent/SSE 架构，需另外适配其会话和流事件模型，不能把它当成上述 Job 动作的别名。

## DTO 映射与数据兼容

| 后端字段 | 当前 UI 字段 | 映射/限制 |
|---|---|---|
| `Course.id/name/archived` | 同名 | 使用真实 UUID；示例 `linear-algebra/probability/python` 不是后端 ID |
| `Course.plan.tasks` | `Course.tasks` | `learn/review` 映射为学习/复习；`completed` 仅来自后端 status；`todo/in_progress/skipped/date` 不应被永久压成布尔值，接入前扩展 DTO |
| `Point.name/chapter` | `KnowledgePoint.title/chapter` | 名称可转换；保留 point ID、来源和阻塞原因 |
| `Course.evidence[pointId]` | `KnowledgePoint.state` | 后端有未评估、待验证、待加强、初步掌握、复测通过；当前三档 UI 仅是演示。真实模式应扩展到五档，不把“初步掌握”或“复测通过”混成同一个已验证 |
| `Message.text/at` | `Message.content/createdAt` | `at` 毫秒时间转 ISO；保留 `sourceIds` 引用，现有 DTO 暂不包含引用 |
| `Material.file.bytes` | `Material.size` | 无原文件大小时使用未知态，不能把 0 当成真实字节数 |
| `Material.sources/path/status/version` | `Material.content` 等 | sources 为有锚点的解析片段，不能无标注拼接后宣称完整原文；正文接口应明确修订号与部分解析状态 |
| `Course.folder/revision/next`、`state.jobs/projects` | 当前缺少 | 增加目录缺失、删除未完成、来源阻塞、待到期、初始化/生成中的视图与操作限制 |

旧 UI localStorage 的 icon/theme/activity 可在明确迁移时保留。真实后端状态不能与示例课程自动合并；接入时从真实服务加载并显式区分演示与真实模式，迁移只转用户认可的偏好。`compact` 继续忽略，缺少 theme/icon 使用兼容回退。真实存储失败不得显示为“已保存”，400/409 也不得用 mock 数据遮盖。

## 建议联调顺序与验收

1. 确定同源托管/代理和 host token 获取方案；实现请求信封、HTTP/业务错误、超时及取消。
2. 实现 `WorkspaceService.load` 与 DTO 映射，接目录选择、新建/打开、重命名、归档恢复及删除；验证跨页修改、目录缺失和删除失败。
3. 保留 File/字节，完成 import → scan → initialize → Job 观察 → 正文版本读取；验证部分解析、资料删除及旧来源失效。
4. 重构聊天为一次发送操作，确定 Job 或 Agent/SSE 架构；验证幂等重试、切课、刷新和失败保留，不产生双份用户消息。
5. 替换固定练习与任意 toggle；按后端题目/作答/证据流程显示五档状态，验证未来任务拒绝提前开始、助答不计独立证据。
6. 确定阅读解释/搜索的定位契约、统计事件来源、UI 偏好存储和外部调用授权；最后替换模拟服务并移除真实模式中的演示提示/重置入口。

当前浏览器脚本验收的是独立 mock UI。真实联调需要另加受控模型/HTTP 测试，覆盖未认证、未授权、模型未配置、busy、任务未到期、来源失效、版本冲突和网络失败；不等同于真实模型效果验收。

## 草稿与并发保存（PR #43 审核修复）

聊天草稿按课程保存在当前标签页的 `sessionStorage`（`syllora-ui.chat-draft.v1.<courseId>`），切换课程、页面、学习模式和刷新后保留；关闭标签页后清除。问题持久化成功后才清除对应草稿，存储失败、预设提示以及回复期间新输入的草稿均保留。恢复演示数据会清除当前标签页草稿。存储被禁用时保留页面内存并提示刷新风险。

每次工作空间变更从最新 localStorage 快照读取，支持 Web Locks 的同源页面通过锁串行保存，其他标签页通过 storage 事件刷新。Web Locks 不可用时仅保证当前标签页同步写入，不保证跨标签页并发写入；正式产品需要后端事务。

旧 `version:1` 数据无需清空；新增可选 `revision`、`preferencesVersion`、`apiConfigVersion` 默认 0。偏好与 API 保存必须携带编辑开始时的 `baseVersion`。版本过期会拒绝保存并保留输入，设置窗口可点击“加载最新设置”后重新编辑。恢复演示数据继续递增版本，旧窗口不能覆盖恢复后的状态。

`npm test` 执行实际 TypeScript mock 服务的隔离状态回归，不连接业务后端或真实模型。CI 独立安装本目录锁定依赖并执行状态测试、类型检查与生产构建；Python 浏览器脚本仍需单独执行，CI 不声称覆盖真实浏览器。
