# Syllora 开发与 Git 规范

本规范适用于 Syllora 代码仓库。产品需求、调研与方案讨论主要保存在外层 `Syllora-ai` 工作区；运行和维护代码所必需的文档应随本仓库版本管理。

## 开发前提

- 先阅读 `AGENTS.md`，确认任务范围与验收标准。
- 新功能先完成 GitHub 同类项目调研和方案确认，再编写代码。
- 已按用户要求复用 StudyClaw 的 TypeScript / Next.js / Node Host 技术栈。安装、构建、启动命令与当前 MVP 边界见 `README.md`。

## 分支

- `main` 为主分支；功能和修复默认使用短生命周期工作分支。
- 分支名使用小写英文与连字符：`<type>/<short-description>`。
- 示例：`feat/course-import`、`fix/review-scheduling`、`docs/development-guide`、`chore/project-setup`。
- 一个分支围绕一个明确目标；已有指定分支时按任务约定使用。

## 提交信息

标题必须使用英文，严格采用以下格式：

```text
emoji type: description
```

| 类型 | Emoji | 用途 | 示例 |
| --- | --- | --- | --- |
| `feat` | ✨ | 新功能 | `✨ feat: add course import` |
| `fix` | 🐛 | 修复缺陷 | `🐛 fix: preserve review progress after reload` |
| `docs` | 📝 | 文档 | `📝 docs: define workspace and repository guidelines` |
| `refactor` | ♻️ | 不改变预期行为的重构 | `♻️ refactor: simplify course validation` |
| `perf` | ⚡️ | 性能优化 | `⚡️ perf: reduce duplicate document queries` |
| `test` | ✅ | 测试 | `✅ test: cover empty course materials` |
| `build` | 📦 | 构建系统、依赖及打包 | `📦 build: update project dependencies` |
| `ci` | 👷 | 持续集成配置 | `👷 ci: run checks for pull requests` |
| `style` | 🎨 | 不影响行为的代码格式调整 | `🎨 style: format course service` |
| `chore` | 🔧 | 其他维护任务 | `🔧 chore: configure editor defaults` |
| `revert` | ⏪ | 回退已有提交 | `⏪ revert: undo course import changes` |

- 使用对应表中的 emoji；`type` 小写，冒号后空一格。
- 描述以英文动词原形开头，简洁说明改动，不使用 `update stuff` 等含糊表述；末尾不加句号。
- 标题尽量控制在 72 个字符以内。本项目暂不采用 `type(scope)` 变体，以保持格式一致。
- 需要背景时在标题后空一行，再用英文正文说明原因和影响。
- 不兼容变更在正文中使用 `BREAKING CHANGE:` 说明影响和迁移方式；有实际 issue 时可用 `Refs: #123` 或 `Closes: #123`，不要编造编号。
- PR 标题及 squash 合并后的提交标题也使用同一格式。

## 提交前检查

1. 确认仓库路径、当前分支和 `git status --short`；外层工作区不是本仓库的一部分。
2. 阅读 `git diff`，确认改动均与当前任务有关。
3. 根据改动运行相关测试、构建或静态检查；纯文档修改核对路径、链接与文字一致性。
4. 显式暂存本次需要的文件，再检查 `git diff --cached` 和 `git diff --cached --check`。
5. 确认没有密钥、个人数据、临时分析产物、无关生成文件或用户尚未授权提交的改动。
6. 任务包含提交时按规范提交；任务包含推送时再推送。

遵循单一目的原则，避免将大规模格式化、依赖升级和功能实现混在一个提交中。禁止为获得干净状态而丢弃用户改动。

## 评审与合并

- PR 描述说明具体问题、最终行为、主要改动、实际验证结果及已知限制。
- 涉及 UI 时提供适当的截图；涉及接口或数据迁移时说明兼容性与迁移步骤。
- 关联真实需求或 issue；区分已执行的检查和待执行的检查。
- 合并前解决阻塞性评审意见并通过已配置的相关检查；推荐 squash 合并，保持主分支历史易读。
- 本文规定协作方式，不表示 GitHub 分支保护、CI 或提交钩子已经配置。技术栈与团队流程确认后再配置自动检查。

## 安全与历史

- 不提交真实 `.env`、凭据、访问令牌或用户资料；示例配置使用明显的占位值。
- 不对共享分支擅自 rebase、强制推送或改写历史。回退已共享改动优先通过新的 revert 提交表达。
- 删除分支、发布版本及其他外部操作必须处于当前任务授权范围内。
