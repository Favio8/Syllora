# 云端 OpenMAIC 取回产物 API

本文件说明 **Syllora 如何把云端生成的内容取回本地仓库使用**。

- 云端指已部署的 OpenMAIC 站点（当前为 `https://studyandchat.top`）。
- 本地指 Syllora 的课程目录 `<课程>/.syllora/`，它是**普通文件夹**，不是数据库。
- 文中的端点与字段都标注了**来源**：`实测`＝对运行中的部署真实调用确认；`源码`＝读上游代码确认但未逐个真实调用。没有标注来源的字段一律不写。

配套实现见 `packages/host/chat-service/src/syllora-cloud.ts`（其文件头也记录了同一份契约）。

> **想先把它连起来？** 本文件是**接口契约参考**（每个端点怎么调、返回什么）。
> 从零到连通的操作顺序（地址与访问口令从哪来、四步顺序、每种连不上分别是什么报错）
> 在 [OPENMAIC_SLIDES.md 的「怎么把本地和云端连起来」](OPENMAIC_SLIDES.md#怎么把本地和云端连起来)。

---

## 0. 先明确一件事：云端不存在"文件"这个概念

这是最容易误解的地方。云端产物**全部存在 PostgreSQL 里，以记录形式存在**，不是文件系统里的文件：

| 云端存的东西 | 存法 |
|---|---|
| 场景（幻灯片） | `document_scenes` 表，一行一个场景，正文是 JSON |
| 课堂（一个 stage） | `document_stages` 表 + 其上挂的场景行 |
| 生成的图片/音频 | 容器内磁盘 `OPENMAIC_CLASSROOMS_DIR`，通过媒体路由按扩展名回传 |

所以"把云端生成的文件返回到本地"实际上分两步：

```
① 取回结构化数据（场景 JSON）            ← 绝大多数情况只需要这一步
② 在本地把它落成文件（.json / .md / .png / .pptx）
```

**第 ② 步在本地做**，因为本地已有渲染与导出能力（`@openmaic/renderer` 渲染画布、`slideToPng` 导出单页 PNG、`pptxgenjs` 导出 PPTX）。这比让云端产出二进制再传回来更可控（云端渲染器版本变化不会破坏本地已有文件）。

---

## 1. 认证

除登录页与 `verify` 外，所有接口都要求有效的 `openmaic_access` cookie。

### `GET /api/access-code/status` — 查询是否需要访问口令

`实测`

```http
GET /api/access-code/status
```

实测响应（**不需要 cookie 也能调**）：

```json
{ "success": true, "enabled": true, "authenticated": false }
```

用于判断站点是否设了 `ACCESS_CODE`（`enabled`），以及当前请求是否已通过（`authenticated`）。

### `POST /api/access-code/verify` — 用访问口令换 cookie

`实测`

```http
POST /api/access-code/verify
content-type: application/json

{ "code": "<站点访问口令，即服务器 .env.local 里的 ACCESS_CODE>" }
```

响应：

```
200
Set-Cookie: openmaic_access=<HMAC 签名值>; Path=/; HttpOnly; ...
```

要点：
- cookie 是 **HMAC 签名的令牌，7 天有效**；有效期由服务端校验，过期需重新换。
- 换 cookie 的请求**自身不要带旧 cookie**，否则失败态可能被缓存（Syllora 里对应 `skipCookie: true`）。
- 建议把 cookie 只放在**进程内存**，不要写进课程目录——课程目录是用户可见的普通文件夹。

---

## 2. 上传资料

### `POST /api/materials` — 上传一份资料

`实测`

```http
POST /api/materials
content-type: text/markdown
x-material-filename: %E5%8B%BE%E8%82%A1%E5%AE%9A%E7%90%86.md
cookie: openmaic_access=...

<文件原始字节，裸 body，不是 multipart>
```

响应（201）：

```json
{
  "materialId": "mat_ntprq425g2xd8arh4ts6gvwc1r",
  "originalName": "勾股定理.md",
  "bytes": 775,
  "mime": "text/markdown",
  "extraction": { "status": "idle" }
}
```

**两个必须注意的坑（都实测踩过）**：

1. **文件名走 header，必须百分号编码。** header 只能是 ASCII；中文名直接放进去会抛
   `Cannot convert argument to a ByteString because the character at index 0 has a value of 31532`。
   云端用 `decodeURIComponent` 解码，与 OpenMAIC 官方客户端一致。
2. **body 是裸字节，不是 multipart。** 用 `fetch` 时 `Uint8Array` 不是合法的 `BodyInit`，
   要传 `bytes.buffer.slice(byteOffset, byteOffset + byteLength)` 这样的 `ArrayBuffer`。

### 资料限制

`实测`（取自 `/api/generate-classroom/capabilities`）

| 项 | 值 |
|---|---|
| 单次最多份数 | **5** |
| 单次总字节 | 157,286,400（约 150 MB） |
| 单文件字节 | 52,428,800（约 50 MB） |
| 支持的格式 | `pdf` / `txt` / `markdown` |

> 因为最多 5 份，Syllora 把**一章的所有来源片段合并成一份 Markdown** 再上传。

### `GET /api/materials/{id}?sessionId=` — 读取资料

`源码` + `实测边界`

返回该资料的**公开投影**（与列表接口、agent 的 `list_materials` 工具同一形状）。
**注意**：资料是 **session 作用域**的，必须提供 `sessionId`。
实测不带 `sessionId` 时返回 **404** + 纯文本 `Not found`。

### `DELETE /api/materials/{id}` — 删除资料

`源码` 删除自己上传的资料并释放配额。**session 绑定的资料副本不可删**。

---

## 3. 生成课堂

### `GET /api/generate-classroom/capabilities`

`实测`

```json
{
  "capabilities": { "webSearch": true, "imageGeneration": true, "videoGeneration": true, "tts": true },
  "materials": { "formats": ["pdf", "txt", "markdown"], "maxCount": 5, "maxTotalBytes": 157286400, "maxDocumentBytes": 52428800 }
}
```

生成前先查这个，能把"为什么不支持"变成可读原因。

### `POST /api/generate-classroom` — 发起生成

`实测`

```http
POST /api/generate-classroom
content-type: application/json
cookie: openmaic_access=...

{ "requirement": "根据提供的资料生成《第一章 勾股定理》这一章的课堂幻灯片", "materialIds": ["mat_..."] }
```

响应（202）：

```json
{
  "jobId": "l0PQzx_44E",
  "status": "queued",
  "step": "queued",
  "message": "...",
  "pollUrl": "http://127.0.0.1:3000/api/generate-classroom/l0PQzx_44E",
  "pollIntervalMs": 5000
}
```

### `GET /api/generate-classroom/{jobId}` — 轮询

`实测`

```json
{
  "success": true,
  "jobId": "l0PQzx_44E",
  "status": "succeeded",
  "step": "completed",
  "progress": 100,
  "message": "Classroom generation completed",
  "scenesGenerated": 8,
  "totalScenes": 8,
  "result": {
    "url": "http://127.0.0.1:3000/classroom/stage-GR1A4ZOHBuDZ",
    "classroomId": "stage-GR1A4ZOHBuDZ",
    "scenesCount": 8
  },
  "done": true
}
```

**三个关键点**：

1. **课堂 id 在 `result.classroomId` 里，不在顶层。** 顶层只有
   `status` / `step` / `progress` / `scenesGenerated` / `totalScenes` / `error` / `done`。
   读 `raw.classroomId` 会永远得到 `undefined`——这是实测踩到的坑。
2. `status` 取值：`queued` | `running` | `succeeded` | `failed`。
3. `step` 的实测轨迹：`queued` → `generating_outlines` → `generating_scenes` → `completed`。
   `progress` 在 `generating_scenes` 阶段从 31 递增到 90。

**失败时**：`status: "failed"`，原因在 `error`，原样是上游的话，例如：

```
No model is configured for course.outline. Set one in the model settings,
or assign the slot (or an ancestor) in openmaic.yml.
@openmaic/storage: invalid scene scene_xxx: /actions/6/type: unknown action type: "action_placeholder"
```

**轮询必须容忍瞬时网络故障**：一次生成要数分钟到数小时，单次 `fetch failed` 不该判死整个任务。
Syllora 的做法是累计连续失败超过 10 次才放弃，但 4xx（如口令错）立即停。

**任务不跨容器重启存活**（实测）。重启云端容器后再轮询正在跑的任务，会得到 `failed`：

```json
{ "status": "failed", "error": "Stale job: process may have restarted during generation" }
```

这不是数据损坏——已生成的场景仍在数据库里。但**正在进行的生成会丢**，所以要避免在生成期间重启容器
（改 `.env.local`、`docker compose up -d`、升级镜像都会触发）。Syllora 侧的表现是：该章记为失败、
**不影响讲义发布**，下次初始化会重新生成（成功过的章节走缓存不重算）。

> 排查这一条时顺带确认了资源不是瓶颈：3.5 GB 内存的机器上容器只占约 145 MB（4%），
> `RestartCount=0`、`OOMKilled=false`、无内核 OOM 记录。**并发不会把服务器压垮**。

---

## 4. 取回产物（三种粒度）

### 4.1 只取场景（推荐，Syllora 现在用的）

#### `GET /api/stages/{classroomId}/manifest` — 场景清单

`实测`

```json
{
  "rev": 9,
  "scenes": [
    { "id": "scene_kJobch7BZ3", "order": 1, "rev": 1 },
    { "id": "scene_BiFiNxvKwd", "order": 2, "rev": 1 }
  ]
}
```

`rev` 是单调递增的版本号，可用于增量：只重取 `rev` 变过的场景。

#### `GET /api/stages/{classroomId}/scenes?ids=a,b,c` — 按 id 批量取场景

`实测`

- 单次 **最多 200 个 id**，超过要分片。
- `ids` 用**逗号**分隔；逗号是合法的子分隔符，**不要编码成 `%2C`**（云端按字面量解析）。

响应：

```json
{ "scenes": [ /* 场景对象数组 */ ] }
```

**场景对象的真实结构**（实测，取回 8 场景的课堂）：

```jsonc
{
  "id": "scene_kJobch7BZ3",
  "type": "slide",                 // slide | quiz | interactive | ...
  "order": 1,
  "title": "勾股定理导入",
  "actions": [ /* 动作列表 */ ],
  "content": {
    "type": "slide",
    "canvas": {                    // ★ 可渲染的画布
      "id": "canvas-...",
      "theme": { "backgroundColor": "#fff", "themeColors": ["#002fa7"], "fontColor": "#202128", "fontName": "..." },
      "background": { },
      "viewportSize": 1000,        // 画布宽
      "viewportRatio": 0.5625,     // 16:9
      "elements": [                // ★ 一个元素一个对象
        {
          "id": "text_qnsHuB4l",
          "type": "text",
          "left": 60, "top": 50, "width": 880, "height": 70, "rotate": 0,
          "content": "<p style=\"font-size:32px;text-align:center\"><strong>勾股定理导入</strong></p>",
          "defaultColor": "#111827",
          "defaultFontName": "Microsoft YaHei"
        }
      ]
    }
  },
  "stageId": "stage-GR1A4ZOHBuDZ",
  "outlineId": "...",
  "createdAt": 1791038631874,      // epoch 毫秒（整数，不是 ISO 字符串）
  "updatedAt": 1791038631874
}
```

> **注意 `content.type` 不全是 `slide`。** 实测一个 8 页课堂里 6 页是 `slide`（有 `canvas`），
> 另有 `interactive`（交互模拟，`content` 是 `{url, html, widgetType, widgetConfig}`）
> 和 `quiz`（测验，`content` 是 `{type, questions:[...]}`）。后两者**没有 `canvas`**，
> 幻灯片渲染器无法呈现。归一化时应丢弃，但要**记录丢弃数量**而不是静默少页。

### 4.2 取整份课堂文档（一次请求拿全）

#### `GET /api/stages/{id}` — 返回整个文档（stage + scenes + outline）

`实测`

```http
GET /api/stages/stage-GR1A4ZOHBuDZ
cookie: openmaic_access=...
```

实测返回 **121,998 字节**，顶层四个键：

```jsonc
{
  "stage": {
    "id": "stage-GR1A4ZOHBuDZ",
    "name": "...",
    "style": { },
    "createdAt": ..., "updatedAt": ...,
    "videoManifest": { },
    "languageDirective": ...,
    "generatedAgentConfigs": [ ]
  },
  "scenes": [ /* 8 个场景，结构与 4.1 完全一致 */ ],
  "dslVersion": "...",
  "outline": { "outlines": [ ], "createdAt": ..., "updatedAt": ..., "generationComplete": true }
}
```

**与 4.1 等价但更省请求**：实测两种方式返回的场景字段**逐个相同**
（`id / type / order / title / actions / content / stageId / outlineId / createdAt / updatedAt`），
`content.canvas` 的有无也一致（同一个 8 页课堂，两种方式都是 6 页有 canvas）。
所以"整份导出"用这一个接口即可；需要增量时再用 4.1 的 manifest。

同族接口：
- `PATCH /api/stages/{id}` — 重命名课程（`{ name }`）
- `PUT /api/stages/{id}` — 整份保存（`{ stage, scenes, outline? }`）
- `DELETE /api/stages/{id}` — 删除课程及其级联子行
- `GET /api/stage-meta/{stageId}` — 阶段元信息

#### `GET /api/stages/{id}/freshness` — **SSE 事件流（不是一次性查询）**

`实测`

实测响应头 `200` 后连接**故意保持不断**（20 秒超时仍未结束），返回的是 Server-Sent Events：

```
retry: 3000

event: stage_freshness
data: {"type":"stage_freshness","stageId":"stage-GR1A4ZOHBuDZ","rev":9}
```

所以**不要把它当普通 GET 调用**——用 `curl` 直接请求会看起来"卡住"。它是给前端做增量刷新订阅用的
（收到 `rev` 变化就重取变过的场景）。**Syllora 不使用它**，走一次性的 manifest 即可。

> 鉴权与存在性：未鉴权访问 → **401**；不存在的 id → **404**（不暴露存在性，实测确认）。

### 4.3 取生成的图片/音频（含讲课旁白）

`实测`

生成的多媒体产物（含讲课旁白语音）**不落文件，而是存进「资产池」**：PostgreSQL 的
`asset_entries` / `asset_blobs` 等表，按调用者（owner）分区。场景通过 `ast_*` id 引用它们。

场景里的引用形态（实测）：

```jsonc
{ "type": "speech", "text": "同学们好！欢迎来到今天的数学课堂……", "audioId": "ast_8w5e42fbe2cgeymk3te6tc4vqm" }
```

#### `GET /api/persistence/assets/{assetId}/content` — 下载单个资产

```http
GET /api/persistence/assets/ast_8w5e42fbe2cgeymk3te6tc4vqm/content
cookie: openmaic_access=...
```

实测结果：**`HTTP 200`，683,564 字节，`content-type: audio/wav`**。

| 请求 | 结果 |
|---|---|
| `GET /api/persistence/assets/{id}/content` | ✅ **200 + 字节**（可下载） |
| `POST` 同一路径 | 405 |
| `GET /api/persistence/assets/{id}` | 405 |
| `GET /api/persistence/assets` | 405 |

**路径必须以 `/content` 结尾，方法必须是 GET**，两者缺一都得到 405。

实测某次课堂生成后资产池的内容：**37 条 `audio/wav`，合计 20,983,388 字节（约 20 MB）**——
与生成任务返回的 `ttsCoverage: {total: 37, written: 37}` 完全吻合。

> **另一条路（不下载，本地重造）**：拿 `speech` 动作里的 `text` 调
> `POST /api/generate/tts` 重新合成。字段是 `{text, audioId, ttsProviderId, ttsVoice}`
> （**不是我最初猜的 `providerId`/`voiceId`**）。实测返回
> `{success:true, audioId, base64, format:"wav"}`——**`base64` 字段里就是完整 WAV**。
> 这条路会**重新计费**，但换音色或改文案时是唯一选择。

#### `GET /api/classroom-media/{classroomId}/{...path}` — 旧版文件式通道

`源码`

服务**旧版文件式课堂**（课程目录下的 `<id>/media` 与 `<id>/audio`）。

**当前版本的服务端生成不再写这个目录**——实测容器内 `data/classrooms` 根本不存在，
新课堂的音频要走上面的资产池接口。该路由仍支持 HTTP Range（可断点续传），
按扩展名回传 MIME（`.png` / `.jpg` / `.mp3` / `.wav` / `.ogg` / `.aac` / `.flac` / `.m4a`）。

实测：请求不存在的媒体路径返回 **404**。

### 4.4 导出 MP4（可选）

`源码`

| 接口 | 作用 |
|---|---|
| `GET /api/export-video/capability` | 探测是否配了渲染服务 |
| `POST /api/export-video/render` | `multipart/form-data` 上传导出归档，返回 `{jobId, pollIntervalMs:3000}`（202） |
| `GET /api/export-video/render/{jobId}` | 查询渲染进度 |
| `GET /api/export-video/render/{jobId}/download` | 下载成品 MP4 |

未配置 `RENDER_SERVICE_URL` 时 `POST` 返回 **501 `PROVIDER_DISABLED`**。

---

## 5. 模型配置（代填 Key）

`实测`

1. `GET /api/model-config` → 读 `revision`（乐观并发用）
2. `PUT /api/model-config` — 先写供应商：

```json
{ "revision": 17, "change": { "kind": "provider", "id": "deepseek", "preset": "deepseek", "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" } }
```

3. `POST /api/verify-model` — 校验：

```json
{ "model": "deepseek:deepseek-v4-flash", "apiKey": "sk-..." }
```

4. `PUT /api/model-config` — 再写根槽位：

```json
{ "revision": 18, "change": { "kind": "slots", "set": { "llm": "deepseek:deepseek-v4-flash" } } }
```

**四个坑（全部实测）**：

1. **顺序不能反。** `verify-model` 的 `providerType` 是**协议类型**（`openai`、`anthropic`），
   不是预设名；传预设名会得到 `Provider type mismatch for openai: expected openai, received deepseek`。
   而传 `<providerId>:<model>` 时服务端用**已保存的**供应商解析凭据，所以供应商必须先落地。
2. **模型名以云端预设为准。** DeepSeek 预设提供 `deepseek-v4-pro` / `deepseek-v4-flash`，
   **没有** `deepseek-chat`。可用模型读 `GET /api/model-config` 的
   `presets[].capabilities.chat.models`。
3. **`slots` 是扁平数组，不是嵌套对象**：

```jsonc
"slots": [
  { "slot": "llm", "parent": null, "capability": "chat", "locked": false,
    "assignment": "deepseek:deepseek-v4-flash",
    "effective": { "status": "assigned", "modelId": "deepseek-v4-flash", "providerId": "deepseek", "baseUrl": "https://api.deepseek.com" } },
  { "slot": "course.outline", "parent": "llm", "assignment": null }
]
```

4. **子槽位继承父槽位**：`course.outline`、`course.content` 未显式赋值时继承 `llm`，
   所以只写根槽位 `llm` 就够。写入带 `revision`，冲突返回 **409**；被部署层
   `openmaic.yml` 锁定的槽位返回 **`SLOT_LOCKED`**。

---

## 6. 落成本地文件的建议做法

| 你想要的本地文件 | 怎么做 | 现在的支持情况 |
|---|---|---|
| `slides.json` | 把场景归一化后写入 revision 目录 | ✅ 已实现 |
| `slides/*.md` | 从 canvas 提取正文文本 | ✅ 已实现（降级视图） |
| 单页 PNG | 本地 `@openmaic/renderer` 的 `slideToPng` | ✅ 已实现 |
| 整份 PPTX | 本地 `pptxgenjs` 按画布坐标映射 | ✅ 已实现 |
| **讲课旁白语音（.wav）** | 从 `speech` 动作拿 `audioId`，走 4.3 的资产接口下载 | ✅ **接口已实测可用**（700 KB/段量级，尚未接入 Syllora） |
| **旁白文本（字幕）** | `speech` 动作的 `text` 字段 | ✅ 数据已在场景里 |
| 整份课堂 JSON | 4.2 `GET /api/stages/{id}` | ⬜ 未实现（现用 manifest+scenes，功能等价） |
| 图片原件 | 同上，画布 `type: "image"` 元素带 `src` | ⬜ 未接入（接口同一条） |
| MP4 | 4.4 导出链路 | ⬜ 未实现（需云端配 `RENDER_SERVICE_URL`） |

**建议的目录结构**（与 Syllora 既有的 revision 模型一致）：

```
<课程>/.syllora/
  revisions/
    <rev>/
      slides.json          # 归一化后的场景（含 classroomId / sourceIds）
      slides/<章节>.md      # 正文降级视图，可检索
      manifest.json         # 含 slideCount
```

---

## 7. 幂等与缓存

- **Syllora 侧缓存键**：`slides-v2:<模型>:<本批内容>`。资料没变的章节直接复用，
  不重复上云计费。
- **云端增量**：`GET /api/stages/{id}/manifest` 返回每个场景的 `rev`。
  本地记住上次渲染用的 rev，只重取变过的场景（上游 workbench 就是这么做的）。
- 上传的资料**不会自动过期**；不需要时可 `DELETE /api/materials/{id}` 释放配额。

---

## 8. 一句话总结

**云端不产出文件，只产出结构化记录**；"取回文件"的正确姿势是
**取场景 JSON（4.1 或 4.2）→ 在本地渲染成 PNG / PPTX / Markdown**。
需要原始图片音频时再走 4.3 的媒体路由逐个取。
