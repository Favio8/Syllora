# @syllora/desktop — Syllora 桌面壳

Electron 桌面壳：把统一新版工作台的「本地 HTTP Host + apps/web/out」装进桌面应用，
用户**免装 Node.js**。数据兼容与命名变化见
[运行目录与命名迁移](../../docs/RUNTIME_MIGRATION.md)。

## 运行结构

```
Electron 主进程 (src/main.cjs)
 ├─ spawn sidecar：ELECTRON_RUN_AS_NODE=1 electron.exe resources/host/bin.js serve --port 0
 │    注入 SYLLORA_HOME=<userData>/host-home、SYLLORA_DATA_DIR=<userData>/syllora-data、SYLLORA_COURSES_DIR=<应用所在目录>/.syllora、SYLLORA_WEB_DIST=resources/web
 ├─ 轮询 <userData>/host-home/host.json 拿随机端口
 └─ BrowserWindow → http://127.0.0.1:<port>/（index.html 由静态托管 tap 注入 token）
```

- Host 业务代码零改造；壳只有生命周期胶水（单实例、崩溃退避重启、外链走系统浏览器）。
- 宿主状态、主密钥和日志落在各平台规范目录（Windows `%APPDATA%`）的 `host-home/` 下；共享模型配置与最近课程位于 `syllora-data/.syllora/`，课程目录位于可执行文件旁的 `.syllora/<课程 UUID>/`，上传资料在该目录的 `sources/`，学习记录在该目录的 `.syllora/`。
- 首次升级保留并复制旧 `host-home/syllora/syllora.json` 与管理的 PDF 原件到 `syllora-data/`；首页旧汇总课程的迁移入口自动分配课程目录；已登记的外部课程启动后自动复制到新目录，已有不匹配目标不会覆盖。
- Windows/Linux 隐藏应用菜单；macOS 保留原生应用及编辑菜单用于退出和复制粘贴。诊断日志由工作台设置导出，目录打开桥仅允许应用已知目录，不允许打开任意文件。

## 常用命令

```powershell
pnpm install                                   # 安装 electron / electron-builder
pnpm --filter @syllora/desktop check:runtime # 校验 Electron 内嵌 Node ≥ 22.19（硬门槛）
node scripts/assemble-host.mjs --build         # 组装 sidecar 资源（可先重建 CLI bundle + web 导出）
node scripts/assemble-host.mjs                 # 只组装（要求 apps/cli/lib/bin.js 与 apps/web/out 已存在）
node scripts/smoke-sidecar.mjs                 # 阶段二冒烟：免装 Node 链路 + token 注入 + 二次启动自愈
node scripts/smoke-desktop.mjs                 # 阶段三冒烟：真实 electron . 整机验证
pnpm --filter @syllora/desktop dev:desktop   # 开发壳（需组装过资源）
$env:SYLLORA_DESKTOP_DEV_URL='http://127.0.0.1:8080'; electron .   # 联调外部 serve（不拉 sidecar）
node node_modules/electron-builder/cli.js --win --publish never       # Windows NSIS 安装包 → dist/
```

## 本机（Windows + pnpm 不在 PATH）注意

- 一律用 `node node_modules/electron-builder/cli.js …` 直调，不要依赖 `.bin` shim 或全局 pnpm。
- `host-runtime/` 闭包用 `npm install --ignore-scripts` 安装：koffi / @napi-rs/canvas 的
  `*.node` 由平台分包 prebuild 随包分发，postinstall 全是冗余校验。
- extraResources 无法携带 `resources/host/node_modules`——app-builder-lib 的
  `createFilter` 对顶层 `node_modules` 目录硬编码剪枝（`filter.js` "filter the root
  node_modules"）。闭包由 **`scripts/after-pack.cjs`（afterPack 钩子）** 在打包后直接
  `fs.cpSync` 落盘并硬校验 `*.node`。
- 打包态资源根是 `process.resourcesPath`（本身已是 `.../resources`）；开发态是
  `apps/desktop/resources`。`src/main.cjs` 的 `paths()` 已统一这两种布局。

## 产物

- `dist/Syllora-<version>-setup.exe`：NSIS 安装包（per-user，免装 Node）。
- 当前未配置代码签名与公证，正式分发前需核对目标系统的安装提示。
- `latest.yml` + `.blockmap`：electron-updater 增量更新元数据（发布时与安装包同传 Release）。

## 课程目录与安装升级

`SYLLORA_COURSES_DIR` 是 Host 的托管课程根目录。桌面壳默认传入 `<Syllora.exe 所在目录>/.syllora`；开发壳默认 `apps/desktop/.syllora`。配置、加密凭据和日志仍位于原 userData，不随课程目录搬迁。

自动迁移先复制资料、完整课程记录和发布版本到暂存目录，校验后切换注册表；失败保留旧路径并在我的课程显示原因。原目录不删除。不得将安装目录放在当前用户无法写入的位置；不允许写入时提示实际错误，不能静默换到另一目录。

NSIS 的 `scripts/preserve-courses.nsh` 保留应用根下的 `.syllora`，升级与卸载都不会清理课程资料。移除应用文件时先将课程目录原子重命名为同级 `<安装目录>.syllora-preserved`，移除后恢复到原位置。已有备份或重命名失败会中止清理；极端中断时可将该备份恢复为 `<安装目录>/.syllora`。共享 userData 继续通过 `deleteAppDataOnUninstall: false` 保留。

`node scripts/smoke-desktop.mjs` 使用隔离 userData 和 `SYLLORA_COURSES_DIR`，校验真实 Host 的课程创建、重复请求和上传隔离，不写真实课程目录或调用收费模型。
