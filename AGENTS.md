# VersionDock 插件项目约定

始终使用简体中文回答，代码、命令、专有名词和用户明确要求保留的原文除外。从当前源码、工具结果和用户目标出发，优先选择全生命周期维护成本低、简单清晰且不过度设计的实现。

## 项目与开发环境

- 本项目是 VS Code 的 Git / SVN 工作台，使用 TypeScript、React、Zustand 和 esbuild。来源为 GitCharm，保持 `GPL-3.0-only` 及 [NOTICE](NOTICE.md)、[第三方声明](THIRD_PARTY_NOTICES.md) 中的归属说明。
- 开发和发布使用 [.nvmrc](.nvmrc) 指定的 Node.js 24 与 npm；安装依赖用 `npm ci`。插件运行依托 VS Code，不把开发时的 Node.js 要求当作用户额外安装条件。
- 构建用 `npm run build`，监听用 `npm run watch`。在 VS Code 中按 F5 启动 Extension Development Host；启动配置见 [.vscode/launch.json](.vscode/launch.json)。
- Git / SVN 操作依赖本机 CLI。普通插件检查不依赖其他项目的 checkout；跨端搁置验证才使用用户指定的独立 Desktop 仓库。
- VersionDock Desktop 可作明确请求下的行为、文档或品牌参考；默认只修改当前仓库，不添加跨仓库源码依赖、`file:` 依赖或符号链接。

## 代码职责与入口

| 路径 | 职责 |
| --- | --- |
| `src/host/extension.ts`、`src/host/commands/` | 扩展生命周期、VS Code API 与命令注册 |
| `src/host/git/`、`src/host/svn/`、`src/host/vcs/` | 仓库操作、状态、CLI、Git 写锁与路径处理 |
| `src/host/panels/` | Webview 生命周期、消息分发与宿主操作 |
| `src/host/types/`、`src/webview/shared/msgTypes.ts` | 消息协议与共享类型；Webview 优先复用宿主定义 |
| `src/webview/` | React 面板、状态和共享组件 |
| `src/host/ai*/`、`src/host/remote/` | AI 工作流、服务 / Agent CLI 与托管平台账号 |
| `src/host/tags/`、`src/host/update/` | 标签工作流、更新与同步保护 |
| `src/host/utils/`、`src/host/ui/` | 路径、错误、日志、翻译、图标、状态栏和注释 |
| `package.json`、`package.nls*.json`、`l10n/` | 扩展清单、设置和中英文文案 |
| `media/` | 运行图标、字体及其许可文本 |
| `scripts/`、`.github/workflows/` | 检查、真实仓库回归、版本与发布自动化 |
| `.agents/skills/`、`docs/` | 项目 Skill 和维护指南；不打入 VSIX 的代理指令位于前者 |

## 实现边界

- 修改前读 `git status --short`，保留用户已有改动和未跟踪文件。先找到实际负责行为的路径，避免顺带重构、格式化或回退无关内容。
- Git / SVN 写操作在宿主实现，复用现有写锁、命令执行、错误、进度与取消机制；界面禁用按钮不能替代写入串行保护。不要擅自删除锁文件来绕过操作失败。
- 遵守 VCS 语义：Git 有 index、Stash 和搁置；SVN 以所选文件提交，并区分文本、属性和树冲突。不要把 Git 操作直接套到 SVN。
- Webview 异步请求和响应保留仓库、工作区与请求上下文，防止切换仓库或页面后旧结果覆盖新状态；订阅、定时器和取消句柄随生命周期释放。
- 用户可见文案维护中英文，复用宿主和 Webview 的翻译机制。界面沿用现有主题、布局密度、图标和交互，涉及视觉行为时在真实 Extension Development Host 中检查。
- 文件路径、字面量 pathspec、Unicode、符号链接和二进制内容沿用已有处理。共享搁置保持插件与 Desktop 的存储协议、附件、迁移标记和跨进程锁兼容，见 [互通说明](docs/shelf-interop.md)。
- 托管平台账号复用 VS Code Authentication / SecretStorage；Git 凭据、SVN 认证和 AI 设置分别遵循当前实现。AI API Key 当前来自 VS Code 设置，不宣称已使用 SecretStorage。日志与交付内容不输出凭据。
- 新增能力需要贯通宿主、消息协议、Webview 和操作结果。演示、占位按钮或静态检查不能作为真实功能完成的证据。

## 检查与验收

按变更选择检查，并复用同一代码状态下已通过的结果。纯文档和 Skill 修改检查内容、引用和格式；运行资源、依赖或打包规则变化需要检查 VSIX 内容。

| 场景 | 命令或方式 |
| --- | --- |
| 宿主 / Webview 类型 | `npm run typecheck`，或对应的 `typecheck:host` / `typecheck:webview` |
| 规范 | `npm run lint`；区分原有警告与本次新增问题 |
| 全部仓库回归 | `npm test` |
| 指定回归 | `npm run test:tags`、`npm run test:shelves`、`npm run test:scrollbars`、`npm run test:release` |
| 源码完整检查 | `npm run check`，包括 lint、类型和上述回归 |
| 构建 | `npm run build`；`check` 本身不包含构建 |
| 本地安装包 | `npm run package -- --out dist/versiondock-check.vsix`，先创建 `dist/`；package 会自动构建，无需预先重复 build |
| 浏览器滚动条交互 | `npm run test:scrollbars:browser`，另需 Chromium，可用 `CHROME_PATH` 指定 |
| 插件 / Desktop 互通 | `npm run test:shelves -- --desktop /path/to/VersionDockDesktop`，另需 Desktop 工具链 |
| 工作流语法 | 已安装 actionlint 时运行 `actionlint .github/workflows/ci.yml .github/workflows/release-vsix.yml` |
| 格式 | `git diff --check` |

- 重要仓库操作修复补充真实临时仓库中的行为与失败边界验证，不用用户工作仓库做破坏性试验，也不编写仅复述实现的测试。
- `npm run package` 成功后核对安装包的版本、publisher、运行资源和许可。代理指令、源码、依赖目录、开发配置及旧 VSIX 不应意外进入包；排除规则见 [.vscodeignore](.vscodeignore)。
- 交付时区分类型 / 测试通过、构建、VSIX 生成、Extension Development Host 验收、真实安装 / 更新及市场发布成功。

## 版本与发布

- 版本准备、更新说明、首次上架和自动发布使用 [versiondock-extension-release Skill](.agents/skills/versiondock-extension-release/SKILL.md)，详细流程以 [CI 与发布指南](docs/ci-release.md) 和工作流为准。
- 版本复用 `npm run version:bump -- patch` 或明确版本号。正式发布只接受 `X.Y.Z`；脚本同步 `package.json`、锁文件两处项目版本和中英文 README 版本徽章，不批量替换依赖版本。
- 发布前更新根目录 `CHANGELOG.md`，按版本倒序维护对应的中英文用户可见变更，并核对它已包含在 VSIX 中。首次版本介绍当前能力；不编造发布日期或已发布状态。VS Code 的更改日志读取该文件，GitHub Release 的自动正文是另一份输出。
- `publisher` 与 `name` 构成市场扩展 ID，已发布后不要为了升级改变它们。已公开版本不覆盖、不降级，不移动已有标签。
- Skill 创建或用法说明不触发版本变化。用户请求发布或准备发布时，按发布 Skill 推进检查、打包、提交、推送、发布和核验；用户明确只要求单项工作时遵从。按当前和此前有效指令执行，不重复询问已明确的动作；仓库可见性与插件发布分别处理。
- CI 只检查并生成 Artifact；Release 工作流会创建 GitHub Release 并按凭据发布插件市场。缺少凭据时市场任务会跳过，不把 GitHub Release 成功或跳过任务当作市场上架成功。
- 用户要求提交时使用 Conventional Commits：`type(scope): 中文总结`，正文用中文概括行为变化，仅提交当前任务相关文件。
