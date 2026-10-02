# Third-Party Notices

This repository reuses source code from the DeepSeek Harness (dsh) project and
its vendored dependencies, all MIT licensed. The original copyright and license
notices are retained in the copied files and directories.

## deepseek-harness (dsh)

- Source: https://github.com/deepseek-ai/deepseek-harness (local copy used as the upstream)
- License: MIT — Copyright (c) 2026 DeepSeek
- Reused parts: `vendor/*` (cordis family), `packages/runtime-diagnostics/invariants`,
  `packages/storage/*` (storage hub + domain + json + sqlite backends), workspace
  registry algorithms, RPC contract patterns, and engineering scaffolding
  (tsconfig / vitest / workspace configuration).
- Agent parity work also follows the MIT-licensed DSH `packages/core/agent`,
  `packages/core/agent-loop`, `packages/core/tools`, `packages/client/ui-model-selection`,
  `packages/client/ui-tool`, and `packages/client/ui-settings-*` contracts. StudyClaw
  implementations are adapted to its existing package boundaries and learning preset.

## vendored cordis ecosystem (`vendor/`)

- Upstream: cordis 4.0.0-rc.7 and cosmokit / schemastery, MIT licensed,
  vendored and locally modified by the dsh project under the
  `@deepseek-ai/*` scope names (see `vendor/README.md` for the 18 local
  modifications list).
- License: MIT — original copyrights retained per package.

## OpenMAIC (`vendor/OpenMAIC/`)

- Upstream: https://github.com/THU-MAIC/OpenMAIC — `openmaic@1.1.1`, commit
  `5312c2b4b4bcb2e7db07cacabcdac8bfddc827fa` (2026-10-02).
- License: MIT — Copyright (c) 2026 THU-MAIC. The upstream `LICENSE` file and the
  `license` field in `package.json` are both preserved unchanged.
- Reused parts: kept in full as a source snapshot under `vendor/OpenMAIC/`. It is an
  appendix kept for reference and reuse; no Syllora code imports it, and it is
  excluded from the pnpm workspace (see `vendor/README.md`).
- Note: the upstream website states AGPL-3.0, which contradicts the repository. The
  upstream changelog records the switch from AGPL-3.0 to MIT in v0.3.0 (2026-06-28),
  so this snapshot is treated as MIT with the repository `LICENSE` as the authority.

## runtime dependencies

- `zod` — MIT
- `js-yaml` — MIT
- `supports-color` — MIT
- `@standard-schema/spec` — CC-BY 4.0 / MIT
- `node-addon-require-builtin` — MIT

---

## Fork provenance（StudyClaw-Next 上游历史，ENG-4）

- **基线**：fork 自 `github.com/deepseek-ai/deepseek-harness` 的
  `0.1.0-rc.8` 快照；此后按 StudyClaw 产品形态做增量改造。
- **许可**：全部沿用 MIT；各 `package.json` 的 license 字段与上游一致。
- **上游当时的包名**：StudyClaw-Next 的 workspace 包处于两套命名并存的过渡态——
  新增/改造的包用 `@studyclaw/*`，沿用的上游基础包保留 `@deepseek-ai/dsh-*`
  原名。**两套名字指向同一实现且互相依赖**，运行时无歧义：

| @deepseek-ai/dsh-* | 职责 |
|---|---|
| dsh-storage / storage-domain / storage-json | 存储后端 |
| dsh-llm / dsh-llm-deepseek | LLM 抽象与 DeepSeek 适配 |
| dsh-settings / dsh-credentials | 配置与凭据域模型 |
| dsh-timeout / invariants / launch-environment / anonymous-user-id | 基础设施 |
| attachment / brand / home-paths | 上游直拷组件 |

- **上游当时的决定**：评估结论是"暂不改"。15 个包改名会波及 import/peerDeps/
  lockfile，纯机械收益低；本节即作为 provenance 记录存在。后续若启用
  npm 发布再统一迁移。

- **编码纪律**：全部 workspace `package.json` 已去除 UTF-8 BOM
  （历史 PowerShell 批量重写引入；BOM 会破坏严格 JSON 工具链，
  与审查报告 P2-5 同源的 Windows 编码问题）。

## Syllora provenance（2026-10-01）

- 直接复用来源：[StudyClaw-Next](https://github.com/Favio8/studyclaw-next)，MIT。
- Syllora 自有包、CLI、IPC、浏览器引导及发布产物已统一使用
  `@syllora/*` / `syllora` / `SYLLORA_*`；原 `@deepseek-ai/*` 基础包与
  `vendor/` 保持上游名称及原始许可，不冒充 Syllora 原创。
- `LICENSE` 中的 StudyClaw authors 著作权声明与
  `docs/upstream/StudyClaw-README.md` 原文保留。新命名不改变许可和归属。
- `.studyclaw` 与 `STUDYCLAW_HOME` 仅在迁移或资料排除逻辑中保留，
  迁移规则见 [运行目录与命名迁移](docs/RUNTIME_MIGRATION.md)。
