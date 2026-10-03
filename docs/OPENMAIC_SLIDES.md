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

  # 可选：Syllora 代填云端模型配置（用户本地输入 Key，写入云端）
  provider: deepseek
  preset: deepseek
  model: deepseek-chat
  api_key: <你的 Key>
```

`slides` 只在**开关打开且 `base_url`/`access_code` 都填好**时才生效——避免"开了但连不上"的模糊状态。
关闭时（默认）不产生任何云端请求，也不写 `slides.json`，既有行为逐字保留。

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

用户在本地填写 Key，Syllora 写入云端：

1. `POST /api/verify-model` 校验 `{model, apiKey, baseUrl, providerType}`，不通过立即停止
2. `PUT /api/model-config` 写入供应商（`kind: 'provider'`）
3. `PUT /api/model-config` 赋值根槽位 `llm`（`kind: 'slots'`）

槽位体系：根槽位是 `llm`，`course.outline` / `course.content` 等是它的子槽位，
**未显式赋值时继承 `llm`**，因此只需写根槽位。写入带乐观并发（`revision`），
冲突返回 409；被部署层 `openmaic.yml` 锁定的槽位返回 `SLOT_LOCKED`。

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
   `No model is configured for course.outline...` 失败。用设置界面或本模块的代填功能配置。
2. **资料限制**（取自 `/api/generate-classroom/capabilities`）：最多 5 份、总 150 MB、单文件 50 MB，
   支持 `pdf` / `txt` / `markdown`。
3. **访问口令**：云端未设 `ACCESS_CODE` 时门禁关闭，任何人都能访问——上公网前必须设置。

## 同步与升级

客户端对着**实测过的线上契约**写，不是对着文档推测。契约集中在
`packages/host/chat-service/src/syllora-cloud.ts` 的文件头注释里。云端升级后若接口变化，
优先核对那里列出的端点与字段，并由 `tests/syllora-cloud.spec.ts`（用真实 HTTP 服务器模拟云端）兜住。
