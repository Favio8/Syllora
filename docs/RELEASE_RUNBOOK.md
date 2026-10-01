# Syllora 发布操作说明

用途：2026-10-01 更新自有命名后的发布步骤。状态：流程已配置；不代表已发布。

所有命令从独立克隆的 Syllora 仓库执行。正式发布前确认版本、目标提交、
npm `@syllora` 组织权限与 `NPM_TOKEN`，以及签名、许可和未关闭阻塞。

## 验证

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --dir apps/web test
pnpm release:pack
pnpm release:verify
pnpm release:publint
```

`release:pack` 生成自包含 CLI 与静态 Web，并把 `@syllora/cli` 打包到
`artifacts/syllora-cli-<version>.tgz`。`release:verify` 在隔离目录安装并运行
新命令；`publint` 校验 npm 发布结构。桌面构建与严格冒烟见
[桌面说明](../apps/desktop/README.md)。只有实际执行成功才能记录通过。

## 发布

`.github/workflows/release.yml` 仅在 `v*` tag 推送时执行。维护者先同步
根目录、CLI 与桌面清单版本，确认 CI 和评审通过，再对具体版本创建并推送 tag。
不要为了测试命名修复推送发布 tag。

流水线先通过类型与测试门禁，再并行执行三平台桌面出包与 npm 打包验证。
`NPM_TOKEN` 可用时发布到 `@syllora/cli`；没有 token 时只执行 dry-run。
预发布版本使用 `beta` dist-tag。两组作业完成后创建本仓库 GitHub Release。
更新地址为 `https://github.com/Favio8/Syllora/releases/latest/download/`。

如采用本机发布，使用明确的 npm registry 与已验证的 tarball；版本和权限确认后
执行 `npm publish <tarball> --registry https://registry.npmjs.org/ --access public`，
预发布加 `--tag beta`。不要更改全局 registry 来完成一次发布。

## 发布后检查与恢复

核对 npm 包名、CLI `syllora --help`、安装器名称 Syllora、Release 资产及
`latest*.yml` 下载地址。实际安装后按 README 执行主流程并记录结果。

发现回归时先停止继续分发，记录影响版本与数据兼容性，优先发布修复版本；
撤回包、删除 Release 或改写 tag 是独立外部操作，按具体授权执行。
运行目录恢复方法见 [RUNTIME_MIGRATION.md](RUNTIME_MIGRATION.md)。
