# 幻灯片讲义（OpenMAIC 集成）

在 Markdown 讲义之外，按章节产出**结构化幻灯片**：用 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)
的 `@openmaic/dsl` 契约表达内容，用 `@openmaic/renderer` 渲染。两者都以 MIT 发布在 npm 上。

## 为什么这样集成

OpenMAIC 与 Syllora 处理同一个问题的两端：都是「学习资料 → 可学习的课程内容」。差异在于形态——

| | OpenMAIC | Syllora |
|---|---|---|
| 形态 | 一键生成多智能体互动课堂（幻灯片/测验/交互模拟/PBL + 语音白板） | 本地优先的学习工作台（资料→讲义→计划→复习证据） |
| 数据 | 服务端 + PostgreSQL | 本地文件（用户目录 `.syllora/`） |
| 依赖面 | AI SDK + CopilotKit + LangGraph + 8 个自研包 | 复用 DSH 的 host/agent 层 |

直接嵌入它的主程序会与 Syllora「本地文件、无数据库」的架构冲突，因此只取其中**自包含**的两块：

- **`@openmaic/dsl`**（零依赖）：`Stage`/`Scene`/`Slide` 契约 + `validateScene` 等校验器。
  用它约束模型输出，比手写校验更准，也让内容可被它的渲染器与导出链路消费。
- **`@openmaic/renderer`**（React 组件 `SlideCanvas`）：只读渲染 PPTist 风格幻灯片。
  与 Syllora 的 React 19 / Tailwind 4 栈吻合；`echarts`/`shiki` 是可选 peer，本仓库未安装。

不含：OpenMAIC 的数据库、多智能体课堂运行时、语音、白板、PBL 与它的主应用。

## 开关与成本

幻灯片是**每批多一次模型调用**，属于用户应显式选择的成本，因此**默认关闭**：升级到本版本不会
让已有课程静默多出调用。

```yaml
# .syllora/config.yaml
ui:
  slides: true
```

- 关闭（默认）：初始化不产生任何幻灯片调用，也不写 `slides.json`——旧行为逐字保留。
- 开启：每批在讲义之外再调用一次，产出该章节的幻灯片。

## 产物

发布到 `.syllora/revisions/<revision>/`：

| 文件 | 内容 |
|---|---|
| `slides.json` | `SlideDeck[]`，每项含 `chapter` 与 `scenes` |
| `slides/*.md` | 每套幻灯片的 Markdown 降级版（正文提取 + 来源），便于纯文本阅读与检索 |
| `manifest.json` | 开启时含 `slideDeckCount` |
| `.syllora/.staging/cache` | 幻灯片结果缓存，键为 `slides-v1:<model>:<批次内容>`；命中即复用，只补变化批次 |

一份 `Scene` 的形状（与 DSL 契约对齐，另加本项目要求的 `citations`）：

```jsonc
{
  "id": "scene-1", "title": "本章要点", "order": 0,
  "citations": ["<sourceId>"],              // 本页依据的来源片段，必须属于本批
  "content": { "type": "slide", "canvas": { /* viewportSize 1000、viewportRatio 0.5625 … */ } }
}
```

## 校验与降级

两道校验，规则与讲义一致：

1. **zod**（`syllora-slides.ts`）：字段、数量、坐标必须是有限正数，元素类型限定在渲染器支持的子集。
2. **`validateSlideDeck`**：引用必须属于本批；**本批每个来源至少被一页引用**（保证覆盖，不挑好写的讲）。

失败处理：

- 单批幻灯片连续两次失败 → 记进 `job.progress.failures`（形如 `第三章（幻灯片）：…`），**继续处理下一批**；
- 幻灯片全部失败也不影响 Markdown 讲义发布与 revision 落盘；
- 旧 revision 没有 `slides.json` → 读取返回空列表，界面提示"这一版没有幻灯片讲义"，不报错。

## 阅读与导出

讲义阅读器新增视图切换（文字讲义 / 幻灯片）：按章节选择、翻页、显示每页的原文依据锚点，
并可**导出当前页为 PNG**（用渲染器自带的 `slideToPng`，不自行截 DOM）。

## 已知边界

- **PPTX 导出未实现**。上游把它做在应用层（`lib/export/use-export-pptx.ts` 约 52 KB），依赖它为
  浏览器改造过的 `pptxgenjs` 分支与 HTML→OMML 的公式链路；移植需要引入这些依赖并重写宿主无关的部分，
  属于独立一轮工作。本轮先提供 Markdown 与 PNG。
- 幻灯片是"附加产物"：同一批里讲义失败仍按原有规则让整理失败，幻灯片失败则只记录。
- 生成质量取决于模型对契约的遵守程度，未做真实模型的语义抽检（当前验证到结构与契约层面）。

## 同步与升级

依赖走 npm 而非源码快照，升级方式：

```bash
pnpm --filter web add @openmaic/dsl@<version> @openmaic/renderer@<version>
```

升级前确认上游 `license` 仍为 MIT：上游官网曾写 AGPL-3.0，但仓库 `LICENSE` 与 `package.json` 为
MIT，其更新日志记录了 v0.3.0（2026-06-28）的 AGPL-3.0 → MIT 调整。若上游改回 AGPL，本集成需要
重新评估（AGPL 会传染到整个 Syllora）。
