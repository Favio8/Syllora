# Syllora

**Turn every course into a learning system.**

把每一门课程，变成一个会持续进化的学习系统。

Syllora 是基于 StudyClaw 直接复用开发的本机 AI 学习工作台。首版提供课程与资料管理、引用问答、学习计划、单选题练习、证据状态和复习安排。当前交付为 MVP，不代表整份 PRD 的发布验收已经完成。

## 启动

使用 Node.js 22.19+（或 24+）与 pnpm 11。

```powershell
pnpm install --frozen-lockfile
pnpm build:web
pnpm serve
```

浏览器打开终端显示的本地地址，默认 `http://127.0.0.1:8080`。当前工作区已安装依赖并生成前端产物，可直接执行 `pnpm serve`。

端口被占用时：

```powershell
pnpm serve --port 8081
```

服务默认只监听本机地址，沿用原项目的访问 token 与 Origin 校验。不要将此 MVP 直接暴露到公网。

## 第一次使用

1. 打开左下角「模型与设置」，填写模型服务地址、model_id 和 API Key。沿用上游的 OpenAI 兼容接口适配与加密凭据存储。
2. 阅读外部调用说明，勾选授权并设置累计模型调用上限。初始上限为 0，不会自动调用收费服务；每道题包含生成与复核两次调用。
3. 新建课程，在右侧「资料」上传文本型 PDF、MD/TXT，或粘贴正文。
4. 在「大纲」生成知识点，选择学习范围、每天分钟数、未来天数和休息日。
5. 生成计划草案，检查容量后点击「确认生效」。
6. 点击「继续」，获取有来源的讲解，确认完成讲解学习，生成并提交练习题。
7. 查看知识点状态和复习时间；有争议的题目可报错，原作答保留，但相关证据暂停计入并重新计算。

模型调用失败、缺少配置或预算耗尽时，应用保留已经保存的资料与学习记录。不会用预设答案替代真实模型生成。

## 目录与复用关系

```text
apps/web/                           Next.js / React 前端
apps/cli/                           原 Node Host 与本地访问保护
packages/host/chat-service/src/
  syllora.ts                        Syllora 接口、作业与持久化
  syllora-domain.ts                 计划、证据、复习规则
packages/course/builder/            复用资料解析与结构化模型调用
packages/llm/                       复用模型适配
vendor/                             保留的上游基础组件与许可
scripts/syllora-serve.mjs           Syllora 启动入口
```

原 StudyClaw 源码及文档保留，原 README 见 [docs/upstream/StudyClaw-README.md](docs/upstream/StudyClaw-README.md)。其 SM-2、掌握度概率、Agent 工具和桌面应用说明不代表当前 Syllora 首页的产品承诺。

Syllora 使用独立的规则：两道不同题独立正确达到初步掌握，至少经过 24 小时再完成到期复测；复习间隔为 24／72／168 小时。辅助作答不计独立证据，答错后重新补强。

## 本地数据

- `.syllora-home/`：服务注册、访问 token、凭据加密主密钥等。
- `.syllora-data/`：模型配置、加密凭据、课程资料片段、作答与生成作业。
- 两个目录均已加入 `.gitignore`。迁移配置时需同时保留主密钥和加密凭据，不要公开这些目录。
- 可通过 `SYLLORA_HOME` 和 `SYLLORA_DATA_DIR` 环境变量指定独立目录。不同服务实例不要共享可写数据目录。
- 搬迁时复制的旧 `.studyclaw/`、`courses/`、`artifacts/` 和临时目录不作为 Syllora 默认数据源，也不纳入代码提交。

## 当前边界

仅支持本机单用户浏览器形态；扫描 PDF、复杂公式完整识别、多人公开部署、金额预算、完整 PRD 验收及赛事物料不包含在本轮交付中。费用金额显示未知，调用次数上限不等同于金额上限。

完整实现记录、验证边界和后续事项见 [docs/MVP.md](docs/MVP.md)。真实模型和实际课程资料尚待运行时接入；用户已要求本轮停止继续测试。

## 开发约定

参阅 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。提交信息采用英文 `emoji type: description`。

```powershell
pnpm typecheck
pnpm test
pnpm build:web
```

以上是后续开发可用命令，不表示本轮又执行了测试。浏览器联调脚本 `scripts/syllora-e2e.ts` 使用明确标识的本地模型测试服务，不代表真实模型效果；产物写入外层工作区 `tmp/`。

沿用 [MIT License](LICENSE)，保留 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中的上游归属与许可。
