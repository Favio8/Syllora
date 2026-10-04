# 虚拟课堂（云端 OpenMAIC 集成）· 部署与运维

虚拟课堂把「一节课」交给已部署的云端 OpenMAIC 生成，Syllora 只做编排（合并资料 → 上云 →
轮询 → 取回）与本地保存、播放。与「幻灯片讲义」共用同一个云端客户端（`syllora-cloud.ts`）
与同一份连接配置（`cloud` 段），区别只在生成粒度与用途：

| | 幻灯片讲义（`ui.slides`） | 虚拟课堂 |
|---|---|---|
| 触发 | 初始化时按章节自动 | 用户在「虚拟课堂」页按需发起 |
| 保留场景 | 只保留有画布的 slide 页 | slide / quiz / interactive 全保留 |
| 产物 | `revisions/<rev>/slides.json` | `<课程>/classrooms/<id>/{classroom,meta,progress}.json` |
| 默认 | 关 | 关（未配置连接时整页只给引导） |

云端各接口的请求/响应契约见 [云端 OpenMAIC 取回产物 API](OPENMAIC_CLOUD_API.md)（实测记录，
含几个必须避开的坑：课堂 id 在 `result.classroomId`、文件名头必须百分号编码、轮询要容忍瞬时失败）。

---

## 1. 部署形态

```
┌─ 本机 Syllora（Host + Web）
│   设置 → 模型配置 → 虚拟课堂（云端 OpenMAIC）：地址 + 访问口令
│   packages/host/chat-service/src/syllora-classroom.ts   课堂编排与本地存储
│   apps/web/src/components/ClassroomWorkspace.tsx        输入卡片 / 进度 / 播放器
│
└─ 云端 OpenMAIC（已部署，当前 https://studyandchat.top）
    /api/access-code/*  /api/materials  /api/generate-classroom/*
    /api/stages/*       /api/classroom-media/*  /api/model-config
```

**不需要新服务器**：本轮部署等于「本机接入已部署的云端」，云端侧只要满足：

1. 站点设了访问口令（`ACCESS_CODE`），本机能用 `POST /api/access-code/verify` 换到 cookie；
2. 云端已配好生成模型（`GET /api/model-config` 的根槽位 `llm` 已赋值；子槽位
   `course.outline` / `course.content` 会继承它）。缺模型时生成会失败并原样报
   `No model is configured for course.outline`，Syllora 会翻译成「请先为虚拟课堂配置模型」。

## 2. 配置连接（两种入口，同一份存储）

**推荐：设置页**（设置 → 模型配置 → 「虚拟课堂（云端 OpenMAIC）」卡片）

- 服务地址：站点根地址，如 `https://studyandchat.top`
- 站点访问口令：`ACCESS_CODE`
- 「检测连接」会调用 `/api/generate-classroom/capabilities`，显示资料限制与云端能力
  （联网检索 / 图片 / 视频 / 语音），并把「为什么不支持」变成可读原因；
- 「清除云端连接」显式清空（地址与口令都清）。

保存在**共享设置目录**（`SYLLORA_DATA_DIR`，默认 `<宿主 home>/application`）：

```yaml
# <共享设置目录>/.syllora/config.yaml
cloud:
  base_url: https://studyandchat.top
  access_code_env: OPENMAIC_ACCESS_CODE   # 引用名，不是口令本身
  provider: deepseek                      # 可选：模型代填用
  preset: deepseek
  model: deepseek-v4-flash
```

口令与模型 Key 写在同目录的 `credentials.json`，由主密钥加密（与模型 API Key 同一套
`secret-box`）；接口只回「是否已配置」，**任何响应都不回显口令**，课程目录里也不会出现凭据。

**备选：手工编辑 config.yaml。** `cloud.access_code` 仍接受字面量口令（老部署与
幻灯片讲义的手工配置方式保持可用）；`api_key` 同理。字面量优先于密封引用，但一旦在设置页
保存同类字段，明文会被引用形式取代。

优先级与查找顺序：课程自己的 `.syllora/config.yaml`（幻灯片讲义也读这里）→ 共享设置目录。

## 3. 数据流向与隐私

- **开启即上传**：所选课程资料会合并成一份 Markdown 上传到上面配置的服务器；
  首页附件（PDF / TXT / Markdown）同样是上传对象。UI 在输入卡片底部用一行提示明示，
  设置卡片里也写明「开启即意味着所选资料会上传到下面配置的服务器」。
- 合并规则：一次上传一份 `<课程资料>.md`（各来源带 `## 锚点`），云端限制最多 5 份 / 合计 150 MB /
  单份 50 MB，因此附件最多再带 4 份。
- 上传的资料**不会自动过期**；不需要时可以在云端侧用 `DELETE /api/materials/{id}` 释放配额
  （Syllora 目前不主动清理云端资料）。
- 云端产物全部存在 PostgreSQL 里（不是文件）；本地只保存取回的 JSON，渲染与播放都在本机。
- 访问 cookie 只存在宿主进程内存里，不落盘。

## 4. 使用流程

1. 打开一门课程 → 顶栏学习模式切到「虚拟课堂」；
2. 输入卡片：昵称 / 人设、课堂角色（教师必选，学生多选，音色在云端支持 TTS 时可选）、
   课程资料（不选=全部可用资料）、附件、需求（至少 4 个字符）→「进入课堂」；
3. 进度页：六步轨迹（资料上传 → 云端排队 → 生成大纲 → 生成场景 → 取回课堂 → 完成），
   显示云端上报的 `已生成场景 x/y`；可「取消生成」（云端任务随即停止等待，本地不保存半成品）；
4. 完成后自动进入播放器：左侧场景栏、右侧课件区（幻灯片走 `@openmaic/renderer` 画布、
   测验可作答/查看答案、互动演示走沙箱 iframe），下方是讲解台词；播放进度与作答存在
   `classrooms/<id>/progress.json`，**只记阅读状态，不计入学习证据**。

作业也会出现在左栏「任务」页（与初始化、电子书解析同一套 job），可在那里取消或查看失败原因。

## 5. 本地产物与恢复

```
<课程>/
  classrooms/<classroomId>/
    classroom.json    整份课堂文档（stage + scenes + outline，来自 GET /api/stages/{id}）
    meta.json         标题、需求、来源数、场景类型统计、云端地址、取回时间
    progress.json     本机播放进度与测验作答
```

- `classroomId` 只接受 `^[A-Za-z0-9_-]{1,80}$`，且读取时做真实路径包含检查（不越出 `classrooms/`）。
- 列表只显示 `meta.json` + `classroom.json` 都齐全的目录，半成品不会出现。
- 失败/取消绝不写半成品：先取回整份文档，再按「先 classroom.json 再 meta.json」顺序原子写入。
- 宿主重启后，上一次仍在运行的课堂作业会被标记为失败（`PROCESS_INTERRUPTED`），
  本地已下载的课堂不受影响。

## 6. 排障对照表

| 现象 | 代码 | 含义与处理 |
|---|---|---|
| 页面顶部「未配置云端连接」 | `CLOUD_NOT_CONFIGURED` | 设置里填地址 + 口令；或 `cloud.base_url` 与口令缺失 |
| 生成立即失败，提示检查口令 | `CLOUD_UNAUTHORIZED` | 口令错误/已轮换；云端返回 401 |
| 提示无法连接云端 | `CLOUD_UNREACHABLE` | 地址不通、DNS/代理、证书问题；先「检测连接」 |
| 等待很久后提示超时 | `CLOUD_TIMEOUT` | 云端仍在生成时放宽等待；任务可能仍在云端继续，稍后刷新列表 |
| 云端报 `No model is configured` | `CLOUD_MODEL_MISSING` | 云端 `/api/model-config` 的 `llm` 槽位未赋值（可用云端的模型设置或 Syllora 的代填能力） |
| 上传被拒（413） | `CLOUD_LIMIT` | 资料超限：单份 50 MB / 合计 150 MB / 最多 5 份 |
| 完成后提示未完成、未保存半成品 | `CLOUD_GENERATION_FAILED` | 云端任务失败（原因为上游话术）；调整需求或资料后重试 |
| 轮询期间偶发网络错误 | — | 自动重试：连续失败超过 10 次才放弃；4xx 立即停 |

## 7. 模型代填（可选）

云端客户端已实现代填流程（`syllora-cloud.ts` 的 `configureModel`）：先 `PUT /api/model-config`
写供应商（`kind:"provider"`）→ `POST /api/verify-model` 校验（`providerType` 是**协议类型**
`openai`/`anthropic`，不是预设名）→ 再 `PUT` 写根槽位 `llm`（`slots` 是扁平数组；子槽位继承根槽位）。
写入带 `revision` 乐观并发，冲突 409，部署层锁定返回 `SLOT_LOCKED`。

**当前 UI 尚未暴露这一步**（云端已在用 DeepSeek 预设，无需代填）；需要用时代填信息可写在
`cloud.provider` / `cloud.preset` / `cloud.model` / `cloud.apiKey`。

## 8. 验收清单（本轮已跑通的部分）

- [x] `settings.cloud.save` 密封保存口令与 Key，`settings.cloud.get` 只回是否已配置（单测断言不回显）；
- [x] 未配置连接时 `classroom.capabilities` 返回 `configured:false`，生成返回 `CLOUD_NOT_CONFIGURED`（不发网络请求）；
- [x] 端到端（假云端 HTTP 服务器）：合并资料 → 上传（文件名百分号编码）→ 发起生成 → 轮询 → 取回 → 落盘 → `classroom.job/get/list/progress` 全通；
- [x] 轮询容忍单次 5xx、401 立即停；取消不留半成品；附件一次性消费；路径白名单；
- [x] 前端：未配置引导、输入卡片校验与隐私提示、进度页、三分支渲染（slide/quiz/interactive）与进度保存。

尚未做（明确边界）：圆桌对话（云端 `/api/chat` 未实测）、媒体原件下载、MP4 导出、
大纲在进度页的可编辑确认（云端无对应接口）、云端资料清理。