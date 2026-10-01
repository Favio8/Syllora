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

浏览器打开终端显示的本地地址，默认 `http://127.0.0.1:8080`。

端口被占用时：

```powershell
pnpm serve --port 8081
```

服务默认只监听本机地址，沿用原项目的访问 token 与 Origin 校验。不要将此 MVP 直接暴露到公网。

## 第一次使用

1. 打开左下角「模型与设置」，填写模型服务地址、model_id 和 API Key。沿用上游的 OpenAI 兼容接口适配与加密凭据存储。
2. 阅读外部调用说明，勾选授权并设置累计模型调用上限。初始上限为 0，不会自动调用收费服务；每道题包含生成与复核两次调用。
3. 新建课程，在右侧「资料」上传文本型 PDF、MD/TXT，或粘贴正文。
   - 文本型 PDF 会保存原文件，可用「预览原文件」在浏览器中查看原件；MD/TXT 与粘贴正文只保存解析片段。
   - 完全相同的内容指纹会复用已有资料并提示，不重复拆解；同名但正文不同则建立一条新的独立资料线，旧资料仍可引用（版本号递增）。
   - 解析部分成功的资料会列出失败页码与原因，需显式「接受可用部分」后才参与生成；没有任何可用文本的资料不会入库。
4. 在「大纲」生成知识点，选择学习范围、每天分钟数、未来天数和休息日。
5. 生成计划草案，检查容量后点击「确认生效」。
6. 点击「继续」，获取有来源的讲解，确认完成讲解学习，生成并提交练习题。回答下方会显示本次实际使用的片段范围（共 N 个，候选 M 个）；未选入的片段不参与本次回答，也不声称已读完全部资料。
7. 查看知识点状态和复习时间；有争议的题目可报错，原作答保留，但相关证据暂停计入并重新计算。

模型调用失败、缺少配置或预算耗尽时，应用保留已经保存的资料与学习记录。不会用预设答案替代真实模型生成。

计划可填写目标日期（按课程时区计算，含当天，最多 366 天）和知识点学习估时（5–240 分钟整数，默认 20 分钟）。未填写目标日期时使用未来天数；目标日期已过的草案不能确认。容量提示区分单任务超过每天分钟数和时间窗口放不下。旧计划快照在读取时补充默认字段，并迁移容量提示格式，无需手动修改数据文件。

大纲支持重命名、上移和下移，排程沿用大纲顺序。草案中的每个未开始任务可调整为 1–720 分钟；装不下的任务保留在不可行草案中，降低估时后可重新排程。任务估时调整会更新草案 ID，旧页面的确认或调整请求返回 `VERSION_CONFLICT`。差异窗口保存打开时的计划与草案快照，展示调整前后的日期与估时；确认后才生效。

独立错答会生成包含即时巩固任务的调整草案，保留原计划、休息日、目标日期、估时和学习证据；已有草案时不覆盖。草案仍需用户确认，不会自动替换已生效计划。计划快照新增 `days`；旧快照按已有任务日期跨度补齐，无任务时补为 7 天。`plan` 接口兼容 `targetDate` 作为 `deadline` 的别名，两者同时传入时必须一致；`adjustTaskMinutes` 要求当前 `draftId`、`taskId` 与 `minutes`。

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
- `.syllora-data/files/`：文本型 PDF 的原文件（权限 0600）。删除资料或课程时同步删除；该目录同样不得公开或提交。
- 两个目录均已加入 `.gitignore`。迁移配置时需同时保留主密钥和加密凭据，不要公开这些目录。
- 可通过 `SYLLORA_HOME` 和 `SYLLORA_DATA_DIR` 环境变量指定独立目录。不同服务实例不要共享可写数据目录。
- 模型配置与继承模块的工作区状态统一放在业务目录内的 `.syllora/`。自有包名为 `@syllora/*`，CLI 命令为 `syllora`；兼容与恢复方法见 [运行目录与命名迁移](docs/RUNTIME_MIGRATION.md)。
- 搬迁时复制的旧 `.studyclaw/`、`courses/`、`artifacts/` 和临时目录不作为 Syllora 默认数据源，也不纳入代码提交。

## 当前边界

仅支持本机单用户浏览器形态；扫描 PDF、复杂公式完整识别、多人公开部署、金额预算、完整 PRD 验收及赛事物料不包含在本轮交付中。费用金额显示未知，调用次数上限不等同于金额上限。

完整实现记录、验证边界和后续事项见 [docs/MVP.md](docs/MVP.md)。真实模型和实际课程资料尚待运行时接入。

## 开发约定

参阅 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。提交信息采用英文 `emoji type: description`。

```powershell
pnpm typecheck
pnpm test
pnpm build:web
```

浏览器联调脚本 `scripts/syllora-e2e.ts` 使用明确标识的本地模型测试服务，不代表真实模型效果；产物写入外层工作区 `tmp/`。

沿用 [MIT License](LICENSE)，保留 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 中的上游归属与许可。
