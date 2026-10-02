# OpenMAIC（附录项目）

本目录是 [OpenMAIC](https://github.com/THU-MAIC/OpenMAIC) 的**源码快照**，作为 Syllora 的
附加项目保留：它的目标与 Syllora 不同（生成可播放的多智能体互动课堂），但两者都在处理
「学习资料 → 可学习的课程内容」，因此把它作为**参考与复用来源**随仓库保留，而不是通过
npm 依赖或 git submodule 引入。

> 这不是 Syllora 的一部分，也不参与 Syllora 的安装、构建与测试。Syllora 的运行不读取本目录。
> 上游自己的说明保留为 [`README.upstream.md`](README.upstream.md) 与
> [`README-zh.upstream.md`](README-zh.upstream.md)。

## 来源与版本

| 项 | 值 |
|---|---|
| 上游仓库 | https://github.com/THU-MAIC/OpenMAIC |
| 上游名称 | `openmaic`（未改名，保留原始身份） |
| 版本 | `1.1.1` |
| 快照提交 | `5312c2b4b4bcb2e7db07cacabcdac8bfddc827fa` |
| 提交日期 | 2026-10-02 |
| 许可证 | **MIT** — Copyright (c) 2026 THU-MAIC，原始 `LICENSE` 与 `package.json` 原样保留 |
| 官方站点 | https://openmaic.io/ · 在线体验 https://open.maic.chat/ |

### 许可证注意

上游官网 [OpenMAIC 开源教育平台](https://openmaic.io/zh/openmaic-open-source-education.html) 目前
写的是「AGPL-3.0（可提供商业授权）」，**与仓库实际许可不一致**。仓库 `LICENSE` 原文与
`package.json` 的 `license` 字段都是 **MIT**；上游 `README-zh.md` 的更新日志也记录了
「2026-06-28 — v0.3.0 …并将开源协议由 AGPL-3.0 调整为 MIT」。本快照按 **MIT** 对待，
并以仓库 `LICENSE` 为准；对外引用时若需要确定性结论，建议再向上游确认。

## 与上游快照的差异（本地改动）

按 `vendor/AGENTS.md` 的要求逐条登记。本次快照**没有修改任何上游源码**，只做了删减与改名：

1. **删除 `assets/`**（82 MB，主要是演示用 GIF，最大单个 18 MB）。它只用于上游 README 展示，
   对「阅读与复用源码」没有价值，保留会让本仓体积膨胀一个数量级。
2. **删除 `.git`、`.next`、`node_modules`、`coverage` 等**（克隆产物与构建产物，不属于源码）。
3. **上游 `README.md` / `README-zh.md` 改名为 `README.upstream.md` / `README-zh.upstream.md`**，
   让位给本说明文件；两个文件内容未改。
4. **行尾按本仓策略规范化**：本仓 `.gitattributes` 是 `* text=auto eol=lf`，上游有 3 个文本文件
   （`packages/@openmaic/importer/{DESIGN.md,SKILL.md,src/serializer/textSerializer.md}`）原本是
   CRLF，入库后变为 LF。这是本仓既有策略的结果，不是对上游内容的编辑；其余文本文件本来就是 LF。

除此之外，`lib/`、`components/`、`app/`、`packages/`、`skills/`、`tests/`、配置文件等
均与上游 `5312c2b` 一致，未做任何改写。`lib/` 下 812 个文件已逐一与上游比对，字节完全一致。

### 必须配套的 `.gitignore` 规则

本仓 `.gitignore` 有一条全局 `lib/` 规则（用于排除构建产物），它会**连 `vendor/OpenMAIC/lib/`
一起吞掉**——快照首次入库时正是因此静默丢了 812 个文件（`lib/` 是 OpenMAIC 的应用源码：
agent / classroom / generation / document / export 等，不是构建产物）。

因此 `.gitignore` 里必须有对应的重新包含规则：

```gitignore
!vendor/OpenMAIC/lib/
!vendor/OpenMAIC/lib/**
```

同步快照后请确认 `git ls-files vendor/OpenMAIC/lib | wc -l` 约为 812；为 0 就说明这条规则丢了。

## 为什么不参与本仓的工作区

`pnpm-workspace.yaml` 用 `vendor/*` 收录工作区包，而本目录是 `vendor/OpenMAIC`，因此**默认会
被当作工作区包**。这必须排除，原因有实证：

- 本目录的 `package.json` 带 `postinstall: "pnpm run build:packages"`，会连带构建它自己的
  6 个内部包（`@openmaic/{dsl,editor,generation,importer,renderer,storage}`）与 2 个改造过的
  第三方包（`mathml2omml`、`pptxgenjs`）；
- 实测：去掉排除后 `pnpm list --recursive` 会列出 `openmaic@1.1.1` 与 `@openmaic/dsl@0.11.2`，
  本仓 `pnpm install` 会因此尝试构建这些包并失败。

所以 `pnpm-workspace.yaml` 里有显式排除：`'!vendor/OpenMAIC'`。

## 它有什么（便于按需取用）

| 目录 | 内容 |
|---|---|
| `lib/agent`、`lib/agent-runtime`、`lib/classroom` | 多智能体课堂运行时与编排 |
| `lib/generation`、`lib/chapter-generation` | 课程/章节内容生成 |
| `lib/document`、`lib/document-store`、`lib/import` | 多格式文档解析与导入 |
| `lib/export`、`render-service` | PPTX / 交互 HTML / 视频导出 |
| `packages/@openmaic/*` | 自研 SDK：DSL、渲染器、导入器、编辑器、生成、存储 |
| `skills/agent-runtime/**/SKILL.md` | 智能体技能说明（课程规划、讲义风格、事实核查、费曼学习等） |
| `tests/`、`e2e/`、`eval/` | 上游测试与评测集 |

## 同步流程

1. 取回上游：`git clone --depth 1 https://github.com/THU-MAIC/OpenMAIC.git`，记录
   `git rev-parse HEAD`。
2. 用相同的排除项覆盖本目录（`.git`、`assets`、`.next`、`node_modules`、`coverage`、
   `*.tsbuildinfo`），并把两个上游 README 改名。
3. 确认 `package.json` 的 `version` 与 `license`，并更新本文件的来源表。
4. 确认 `pnpm-workspace.yaml` 的 `'!vendor/OpenMAIC'` 仍在；运行 `pnpm list --recursive`
   不应出现 `openmaic`。
5. 确认 `.gitignore` 的 `!vendor/OpenMAIC/lib/` 与 `!vendor/OpenMAIC/lib/**` 仍在，并核对
   `git ls-files vendor/OpenMAIC | wc -l` 的数量（当前库内约 3258 个文件）。
6. 本目录的改动**不需要**跑 Syllora 的测试套件（它不参与构建）。但若把其中的代码复制进
   `packages/` 或 `apps/`，那就成为 Syllora 的代码，必须按 Syllora 的规范走完整验证，
   并在 `THIRD_PARTY_NOTICES.md` 中标明来源与 MIT 归属。
