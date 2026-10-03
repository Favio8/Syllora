# 幻灯片讲义（云端 OpenMAIC 集成）

Syllora 本地不运行 OpenMAIC：它是一个服务端 + PostgreSQL 的重型应用，因此部署在云上，
Syllora 通过 HTTP 调用它生成课堂，再把场景取回本地渲染与导出。

```
Syllora（本机）                         云端 OpenMAIC（你的服务器）
   │ 1. 访问口令换 cookie ──────────────────▶ POST /api/access-code/verify
   │ 2. 本章资料合并成 Markdown 上传 ────────▶ POST /api/materials  → materialId
   │ 3. 发起生成 ────────────────────────────▶ POST /api/generate-classroom → jobId
   │ 4. 轮询任务（5s） ──────────────────────▶ GET  /api/generate-classroom/{jobId}
   │ 5. 取回场景 ───────────────────────────▶ GET  /api/stages/{id}/manifest + /scenes
   │ 6. 本地渲染 / 导出 PNG / 导出 PPTX      （canvas 交给 @openmaic/renderer）
```

## 为什么这样分工

| | 放在云端 | 留在本地 |
|---|---|---|
| 内容 | 生成逻辑、模型调用、资料存储、PostgreSQL | — |
| 渲染 | — | `@openmaic/renderer`（渲染很轻，没必要上云） |
| 导出 | — | PNG（`slideToPng`）、PPTX（`pptxgenjs`） |

**关键取舍：资料会上传到你自己的服务器。** Syllora 原本是"本地优先、资料不出本机"，
启用幻灯片意味着接受这一数据流向——所以该功能默认关闭，必须显式开启。

## 配置

```yaml
# <课程>/.syllora/config.yaml
ui:
  slides: true          # 开关（默认关）

cloud:
  base_url: https://studyandchat.top   # 云端 OpenMAIC 站点
  access_code: <站点访问口令>           # 对应云端 ACCESS_CODE

  # 可选：单章生成的等待上限（分钟，1–1440）。默认 120。
  # 慢配置（开思维、串行）下 40 页要数小时，需调大。
  wait_timeout_minutes: 120

  # 可选：Syllora 代填云端模型配置（用户本地输入 Key，写入云端）
  provider: deepseek
  preset: deepseek
  model: deepseek-v4-flash
  api_key: <你的 Key>
```

`slides` 只在**开关打开且 `base_url`/`access_code` 都填好**时才生效——避免"开了但连不上"的模糊状态。
关闭时（默认）不产生任何云端请求，也不写 `slides.json`，既有行为逐字保留。

## 怎么把本地和云端连起来

上面是字段清单，这一节是**从零到连通的操作顺序**。四步，跳过任何一步都会失败。

### 第 1 步：拿到云端的地址与访问口令

| 要填的值 | 从哪来 |
|---|---|
| `base_url` | 你部署 OpenMAIC 的站点地址，例如 `https://studyandchat.top`。**本机 Docker 部署则是 `http://127.0.0.1:3000`** |
| `access_code` | 云端服务器的 `/opt/openmaic/.env.local` 里 `ACCESS_CODE=` 那一行的值 |

在云端服务器上取访问口令：

```bash
grep '^ACCESS_CODE=' /opt/openmaic/.env.local | cut -d= -f2-
```

> 若云端 `.env.local` 没设 `ACCESS_CODE`，门禁是关闭的——任何人都能访问，
> 此时本地也要把 `access_code` 填成同一个空值才连得上（但不该这样上公网）。

### 第 2 步：本地填 `config.yaml`

```yaml
# <课程>/.syllora/config.yaml
ui:
  slides: true

cloud:
  base_url: https://studyandchat.top
  access_code: <第 1 步取到的值>
```

**注意作用范围**：`config.yaml` 在**课程目录**下。多个课程要各自配一份；
放在上级目录的共享配置不会自动带下来。

### 第 3 步：确认真的连上了

这一步最容易被跳过，但连不上时的报错各不相同，先单独确认省时间。

**先确认站点活着、门禁开着**（这个接口不需要口令）：

```bash
curl -s https://studyandchat.top/api/access-code/status
# → {"success":true,"enabled":true,"authenticated":false}
```

`enabled: true` 说明站点设了口令。`authenticated: false` 是正常的——这个请求没带 cookie。

**再确认口令正确**（能换到 cookie 就通了）：

```bash
curl -s -i -X POST https://studyandchat.top/api/access-code/verify \
  -H 'content-type: application/json' \
  -d '{"code":"<你的访问口令>"}' | grep -i '^set-cookie'
# → Set-Cookie: openmaic_access=... （出现这行就说明口令对）
```

没出现 `Set-Cookie` 就是口令错。Syllora 侧对应的报错是：

| 现象 | 含义 |
|---|---|
| `云端拒绝了访问口令（401）。请检查 config.yaml 的 cloud.accessCode` | 口令不对 |
| `云端未返回访问 cookie；请确认站点访问口令正确` | 口令对了但响应异常（多为站点未就绪） |
| `无法连接云端 <地址>：fetch failed` | 地址不通：域名、端口、防火墙或 HTTPS 证书 |

### 第 4 步：配好云端的模型（否则第一次生成必失败）

**这一步最容易漏。** 云端没有任何模型时，生成会直接失败：

```
No model is configured for course.outline. Set one in the model settings,
or assign the slot (or an ancestor) in openmaic.yml.
```

两种做法，**必须选一种**：

- **让 Syllora 代填**（推荐）：在本地 `cloud` 里填 `provider` / `preset` / `model` / `api_key`，
  Syllora 会先写云端供应商、校验 Key、再赋给根槽位 `llm`。
- **在云端锁槽位**：改云端 `openmaic.yml`，全局生效、与 owner 无关。

> **不要用"浏览器登录后台配一次"这条路**——它落在该浏览器的匿名 owner 上，
> 而 Syllora 用访问码建立的是另一个会话，**看不到**。原因见后文
> 「为什么应由 Syllora 代填」。

### 这条链路实际用的是什么

我们这次部署（`https://studyandchat.top`）跑通过的组合，可直接照抄：

```yaml
cloud:
  base_url: https://studyandchat.top
  access_code: <服务器 .env.local 里的 ACCESS_CODE>
  provider: deepseek
  preset: deepseek
  model: deepseek-v4-flash
  api_key: <你的 DeepSeek Key>
```

云端同时开这三个提速开关（写在云端 `.env.local`，改完要重启容器）：

```bash
PARALLEL_SCENE_CONCURRENCY=4
LLM_THINKING_DISABLED=true
```

顺带提醒：**重启容器会打断正在进行的生成**，该章会记为失败（细节见
[OPENMAIC_CLOUD_API.md](OPENMAIC_CLOUD_API.md) 的轮询一节）。

## 生成粒度与产物

**一章 = 一个云端课堂。** Syllora 的批次划分即章节划分，每章：

1. 把本章全部来源片段合并成一份 Markdown 上传（云端单次最多 5 份资料，逐片段上传会超限）
2. 发起一次课堂生成，轮询到终态
3. 取回场景并归一化，写入 `revisions/<rev>/slides.json`

```jsonc
// slides.json 的一项
{
  "chapter": "第一章",
  "classroomId": "cls_xxx",     // 云端课堂 id，便于追溯是哪次生成
  "sourceIds": ["s1", "s2"],    // 本章依据的 Syllora 来源（章节级溯源）
  "scenes": [{ "id": "...", "title": "...", "order": 0, "content": { "type": "slide", "canvas": { } } }]
}
```

同时落盘 `slides/*.md`（从 canvas 提取正文的降级视图，便于纯文本阅读与检索），
`manifest.json` 开启时含 `slideCount`。

**缓存**：键为 `slides-v2:<模型>:<本批内容>`。资料未变的章节直接复用，不会重复上云计费。

### 一个云端课堂里可能有非幻灯片页

实测一次 8 页的课堂里，6 页是 `slide`（有 canvas），另 2 页分别是 `interactive`（交互模拟）
与 `quiz`（测验）——它们没有 canvas，幻灯片渲染器无法呈现。归一化会丢弃这些页，
但**把数量记进 `cloudSceneCount` / `skippedNonSlideCount`**，避免"生成少了页"的误解。

## 关于引用可追溯的变化

云端**不返回** Syllora 的逐页来源 id，因此原先"每页引用可回溯到原文"无法维持。
改为**章节级溯源**：每份幻灯片记录本次生成上传了哪些 Syllora 来源，并在界面上如实标注
「本章依据」与云端课堂 id，**不声称逐页对应**。

## 失败降级

幻灯片是附加产物，永不阻断讲义：

- 某一章两次尝试后仍失败 → 记进 `job.progress.failures`（`第三章（幻灯片）：…`），**继续下一章**
- 全部失败也不影响 Markdown 讲义发布与 revision 落盘
- 旧 revision 没有 `slides.json` → 读取返回空列表，界面提示"这一版没有幻灯片讲义"
- 云端返回的场景里认不出 canvas 的页会被丢弃，而不是把畸形数据交给渲染器

> **实现注意**：`within()` 对**不存在**的路径会抛 ENOENT，所以旧 revision 的兼容必须显式吞掉"文件不存在"。

## 代填模型 Key

用户在本地填写 Key，Syllora 写入云端。**顺序是实测确定的**：

1. `PUT /api/model-config` `{kind:'provider'}` 先保存供应商
2. `POST /api/verify-model` `{ model: '<providerId>:<model>', apiKey }` 校验
3. `PUT /api/model-config` `{kind:'slots'}` 赋值根槽位 `llm`

**为什么必须先保存供应商**：`/api/verify-model` 的 `providerType` 字段是**协议类型**
（`openai`、`anthropic` 等），不是预设名；传预设名会得到
`Provider type mismatch for openai: expected openai, received deepseek`。
而传 `<providerId>:<model>` 时服务端用**已保存的供应商**解析凭据与端点，故供应商必须先落地。

**模型名以云端预设为准，不要照文档猜**：DeepSeek 预设提供的是
`deepseek-v4-pro` / `deepseek-v4-flash`，并不是 `deepseek-chat`。可用模型从
`GET /api/model-config` 的 `presets[].capabilities.chat.models` 读。

槽位体系：根槽位是 `llm`，`course.outline` / `course.content` 等是它的子槽位，
**未显式赋值时继承 `llm`**，因此只需写根槽位。写入带乐观并发（`revision`），
冲突返回 409；被部署层 `openmaic.yml` 锁定的槽位返回 `SLOT_LOCKED`。

**产物标识在 `result` 里**：任务成功后课堂 id 与场景数位于
`result.classroomId` / `result.scenesCount`（见上游 `classroom-job-store` 的成功分支），
**不在顶层**。顶层只有 `status` / `step` / `progress` / `scenesGenerated` / `error` / `done`。

### 为什么应由 Syllora 代填，而不是先在网页里配

实测确认：**只用访问码**（不带浏览器 cookie）就能读写 `/api/model-config`，且同一 cookie 下
owner 稳定。这意味着两种配置方式落在**不同的 owner** 上：

| 配置方式 | 落在哪个 owner | Syllora 生成时能否看到 |
|---|---|---|
| 浏览器登录后手动配置 | 该浏览器的匿名 owner | **看不到** |
| Syllora 用访问码代填 | 访问码会话的 owner | **能看到** |

所以「先去网页里配一次」对本功能**不生效**，必须由 Syllora 写入；
或者改走部署层——在云端 `openmaic.yml` 里锁定槽位，那是全局的、与 owner 无关。

## 渲染与导出

讲义阅读器新增「文字讲义 / 幻灯片」切换：按章节选择、翻页、显示本章依据，并提供：

- **本页 PNG**：用渲染器自带的 `slideToPng`
- **全部 PPTX**：`apps/web/src/features/workbench/slide-export.ts` 用 `pptxgenjs` 按画布坐标映射

PPTX 保真边界：

| 元素 | 处理 |
|---|---|
| `text` | 段落与 `<br>` 还原为换行，内联字号取 `font-size`，其余样式保守降级 |
| `latex` | 以原文文本呈现（不做 HTML→OMML 转换，保证内容不丢） |
| `image` / `shape` | 图片按 `src` 插入；形状把 SVG path 包成 data URI 插入，保持外形 |
| `line` / `table` | 映射为 PPT 线段 / 原生表格 |
| `chart` / `video` / `audio` | 不导出（需要额外数据与媒体链路），跳过而非产出坏形状 |

## 云端前置条件

1. **云端必须配置模型**：否则生成任务会以
   `No model is configured for course.outline...` 失败。用本模块的代填功能配置
   （注意 owner 归属那一节：网页里配的对此不生效）。
2. **模型能力要够**：实测 DeepSeek 预设下 `deepseek-v4-flash` **生成失败**，云端存储层拒绝了
   模型产出的非法动作：

   ```
   @openmaic/storage: invalid scene scene_xxx: /actions/6/type:
   unknown action type: "action_placeholder"
   ```

   同一份资料换 `deepseek-v4-pro` 则成功生成 8 页。也就是说**较弱模型可能通不过上游的
   场景校验**，这是模型/提示词层面的问题，不是本集成的配置问题。选模型时建议先用一章试生成。
3. **资料限制**（取自 `/api/generate-classroom/capabilities`）：最多 5 份、总 150 MB、单文件 50 MB，
   支持 `pdf` / `txt` / `markdown`。
4. **访问口令**：云端未设 `ACCESS_CODE` 时门禁关闭，任何人都能访问——上公网前必须设置。

## 性能：为什么慢，以及怎么快 11 倍

实测数据（同一份 775 字资料、10–11 页课堂、真实云端）：

| 云端配置 | 秒/页 | 11 页 | 40 页推算 |
|---|---|---|---|
| `pro` + 串行 + 开思维（**上游默认**） | 135 | 26 分钟 | ≈ 6.0 小时 |
| `pro` + 并发 + 开思维 | 111 | 20 分钟 | ≈ 4.9 小时 |
| `flash` + 串行 + 开思维 | 70 | 13 分钟 | ≈ 3.1 小时 |
| `flash` + 并发 + 开思维 | 52 | 8.8 分钟 | ≈ 2.3 小时 |
| `pro` + 并发 + **关思维** | 21 | 4 分钟 | ≈ 57 分钟 |
| **`flash` + 并发 + 关思维** | **12** | **2 分钟** | **≈ 33 分钟** |

（40 页列是按每页耗时线性外推，不是实测。）

**三个可配置的杠杆，按收益排序：**

1. **关掉思维模式**（收益最大，约 6 倍）。`LLM_THINKING_DISABLED=true`。
   思维模式对"输出大段结构化 JSON"是纯浪费：`pro` 关掉后从 135 秒/页降到 21 秒/页。
2. **开启并发场景生成**（约 1.3–1.4 倍）。`PARALLEL_SCENE_CONCURRENCY=4`（上限 10）。
   上游**默认 0 = 串行**，必须显式开启。官方注释提醒：若你的 Key 并发额度低，请调小或不开。
3. **换更快的模型**（约 1.7 倍）。`flash` 12 秒/页 vs `pro` 21 秒/页（都关思维时）。

**这些是云端部署级环境变量**，写在云端 `.env.local` 后需重启容器；Syllora 不会替用户改云端环境。
命令示例见上文「端到端验证怎么做」附近的部署说明。

**注意瓶颈不在网络**：实测单次普通问答 `pro` 仅 2 秒、`flash` 1 秒，同时发 6 个请求也不限流；
服务器负载接近 0。耗时几乎全部来自模型逐页输出约 10KB 的结构化 JSON（一页含十余个画布元素）。

**超时要跟着配置调。** Syllora 侧等待上限默认 120 分钟，可用
`cloud.wait_timeout_minutes` 调整（1–1440 之间，非法值按未配置处理）。
慢配置下 40 页要数小时，不放宽会**先于云端完成而超时**。

## 端到端验证怎么做

单元测试用假服务器验证协议（快、离线）；但**假服务器会跟着实现走，掩盖真实契约的偏差**——
`classroomId` 藏在 `result` 下这个偏差就是被单元测试漏掉、由真实调用发现的。

因此另有一个默认跳过的真实云端测试：

```bash
SYLLORA_CLOUD_E2E=1 \
SYLLORA_CLOUD_BASE_URL=https://<你的站点> \
SYLLORA_CLOUD_ACCESS_CODE=<访问口令> \
SYLLORA_CLOUD_API_KEY=<供应商 Key> \
SYLLORA_CLOUD_PROVIDER=deepseek SYLLORA_CLOUD_PRESET=deepseek \
SYLLORA_CLOUD_MODEL=deepseek-v4-pro \
  vitest run --project node packages/host/chat-service/tests/syllora-cloud-live.spec.ts
```

它真的上传资料、生成一章、取回场景，并断言归一化后仍有可渲染内容。

**生成耗时波动很大**：同一份资料，命令行直跑约 13 分钟，通过测试跑两次分别超过 26 分钟
（云端是异步任务，时长取决于上游模型排队与负载）。因此测试超时给到 45 分钟——
这是"给得足够宽"，不是性能断言。注意 Syllora 自己的 `waitForJob` 默认上限是 30 分钟，
真实使用中若遇到更慢的云端，需要按部署情况调大。

## 同步与升级

客户端对着**实测过的线上契约**写，不是对着文档推测。契约集中在
`packages/host/chat-service/src/syllora-cloud.ts` 的文件头注释里。云端升级后若接口变化，
优先核对那里列出的端点与字段，并由 `tests/syllora-cloud.spec.ts`（用真实 HTTP 服务器模拟云端）兜住。
