<p align="center">
  <img src="media/icons/versiondock-logo-dark.png" alt="VersionDock" width="128" height="128">
</p>

<h1 align="center">VersionDock</h1>

<p align="center">在 VS Code 中集中处理 Git / SVN 更改、提交、历史和冲突。</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-1.0.1-blue" alt="Version"></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS_Code-%3E%3D1.85.0-007ACC" alt="VS Code minimum version"></a>
  <a href="#能做什么"><img src="https://img.shields.io/badge/VCS-Git_%2B_SVN-F05032?logo=git&amp;logoColor=white" alt="Git and SVN"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue" alt="GPL-3.0-only"></a>
  <a href="https://github.com/chenqinru/VersionDock/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&amp;logoColor=white" alt="GitHub Actions workflow"></a>
</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.md">English</a> ·
  <a href="https://github.com/chenqinru/VersionDock/issues">问题反馈</a> ·
  <a href="CONTRIBUTING.md">贡献指南</a> ·
  <a href="CHANGELOG.md">更改日志</a>
</p>

VersionDock 支持 Git / SVN 混合工作区、多仓库操作、三栏冲突处理和可选 AI 辅助工作流。

## 能做什么

| 工作流 | 当前能力 |
| --- | --- |
| 更改与提交 | 树状 / 扁平文件列表、差异预览、按文件提交、Git 暂存 / 取消暂存、Amend、提交并推送、提交信息历史 |
| 多仓库工作区 | Git / SVN 混合发现、仓库颜色、显示 / 隐藏仓库、跨仓库查看更改与历史；嵌套仓库分别管理自己的文件 |
| 提交历史 | Git 分支图谱、SVN 修订历史、文件 / 选区历史、作者 / 文本 / 日期 / 分支筛选、提交详情与比较 |
| 分支与标签 | Git 分支创建、检出、合并、变基、比较、重命名和删除；标签创建、检出、合并、推送及本地 / 远程删除 |
| 同步 | 待推送 / 待拉取提交、抓取、拉取、推送、同步、未推送提交的撤销，以及更新前的本地更改备份 |
| 本地变更管理 | 命名变更列表、原生 Git Stash、补丁搁置、完整 / 按文件恢复、差异预览；与 Desktop 共享搁置 |
| 冲突处理 | Git / SVN 冲突列表、文本冲突三栏合并编辑器、保存结果与标记解决、进行中操作的状态与中止入口 |
| 仓库结构 | Git submodule 初始化 / 更新、worktree 创建 / 清理、subtree 添加 / 拉取 / 推送 / 拆分等管理 |
| 身份与远程 | Git 提交身份 Profile、SVN 认证管理、GitHub / GitLab / Gitee 远程账号与仓库克隆 / 发布入口 |
| 编辑器追溯 | Git / SVN 行注释、当前行提交提示，以及跳转到对应历史 |

提交面板提供 `simplified`、`changelists`、`vscode` 三种视图，支持深浅主题、布局密度、滚动条行为和独立窗口。

## AI 辅助工作流

AI 为可选能力，需要自行配置可用的模型服务或本地 Agent CLI。普通 Git / SVN 操作可独立使用。

- **生成提交信息**：基于选中的更改生成信息，并支持自定义 Prompt。
- **提交解释**：从历史提交和文件差异解释改动。
- **代码审查**：分析所选更改并展示审查结果。
- **冲突解决**：为文本冲突生成候选结果，供审阅后应用。
- **智能提交编排**：将选中的更改组织成提交方案，调整分组和信息后再执行。

支持的接入方式：

| 模式 | 接入 |
| --- | --- |
| 模型服务 | GitHub Copilot、OpenAI、Claude、Gemini、自定义 OpenAI 兼容接口 |
| 本地 Agent CLI | Claude、Codex、Antigravity、OpenCode |

OpenAI 和自定义接口支持 `chat-completions` 与 `responses`。CLI 模式需要对应工具已安装且完成认证。AI 功能会将所选代码、差异或冲突上下文交给配置的服务 / Agent；请按仓库要求选择接入方式。AI API Key 使用 VS Code 设置配置，建议放在用户设置中，避免提交到工作区配置。

## 冲突编辑器

文本冲突以“当前版本 / 合并结果 / 对方版本”三栏展示，支持逐段接受更改、编辑结果、冲突导航和同步滚动。SVN 的属性冲突、树冲突在冲突列表中单独识别，不以文本合并代替处理。

## 安装与开始使用

运行要求：**VS Code 1.85.0+**、可执行的 **Git**；使用 SVN 时另需 `svn` 命令行客户端（推荐 1.14+）。已安装的插件不需要额外安装 Node.js。

从源码构建需要 Node.js 24 和 npm；以下 `nvm` 命令适用于已安装 nvm 的环境，也可自行安装 Node.js 24。

可在 VS Code 扩展页按 ID `chenqinru.versiondock` 查找，或从 [Releases](https://github.com/chenqinru/VersionDock/releases) 获取已发布的 VSIX。也可从源码构建：

```sh
git clone https://github.com/chenqinru/VersionDock.git
cd VersionDock
# 安装并使用 .nvmrc 指定的 Node.js 24
nvm install
nvm use
npm ci
npm run package
```

在 VS Code 执行 **Extensions: Install from VSIX…**，选择生成的 `versiondock-<版本号>.vsix`，然后打开包含 Git 仓库或 SVN 工作副本的目录。

- 侧栏 **VersionDock Commit**：查看更改、选择文件、提交或保存本地更改。
- 面板 **VersionDock Log**：查看历史、分支 / 标签、提交详情与差异。
- 状态栏分支入口：按当前仓库类型执行 Git 或 SVN 操作。
- 命令面板搜索 `VersionDock`：打开历史、冲突、注释、设置等入口。

## 常用设置

在 VS Code 设置中搜索 `versiondock`。以下仅列常用项，完整设置以扩展配置为准。

| 设置 | 默认值 | 用途 |
| --- | --- | --- |
| `versiondock.changesViewMode` | `simplified` | 更改列表布局 |
| `versiondock.layoutDensity` | `comfortable` | 界面密度，可选 `compact` |
| `versiondock.scrollbarVisibility` | `system` | 系统滚动条、自动隐藏或常显 |
| `versiondock.defaultSaveAction` | `stash` | 保存更改时默认使用 Stash 或 Shelve |
| `versiondock.ai.executionMode` | `provider` | 模型服务或 `agent-cli` |
| `versiondock.ai.provider` | `github-copilot` | 模型服务提供方 |
| `versiondock.ai.apiProtocol` | `chat-completions` | OpenAI / 自定义接口协议 |
| `versiondock.ai.cli.provider` | `claude` | 本地 Agent CLI |

## 推荐：VersionDock Desktop

如果希望在编辑器之外集中管理 Git / SVN 仓库，推荐 [VersionDock Desktop](https://github.com/chenqinru/VersionDockDesktop)。它是独立运行的桌面工作台，支持 macOS、Windows 和 Linux，将多个项目的更改、提交、同步、历史与冲突处理放在同一个应用中。

Desktop 与本扩展分别安装，可独立使用，也可按工作习惯搭配使用。查看 [Desktop 安装说明](https://github.com/chenqinru/VersionDockDesktop#下载安装)，或前往 [Releases 下载应用](https://github.com/chenqinru/VersionDockDesktop/releases)。

## Git、SVN 与 Desktop 的边界

- SVN 没有 Git index；提交面板以选中文件作为 SVN 提交目标。Git Stash 和补丁搁置只用于 Git 仓库。
- SVN 分支 / 标签操作按常见的 `trunk`、`branches`、`tags` 目录结构识别，具体行为取决于仓库布局。
- [VersionDock Desktop](https://github.com/chenqinru/VersionDockDesktop) 是独立桌面项目。两端新版在**同一本地 Git 工作目录**中共享 Stash、index 和搁置记录；独立 clone 不共享这些本地数据，不同 worktree 的搁置分别存储。详见[搁置互通说明](docs/shelf-interop.md)。
- 恢复搁置默认保留记录；完整恢复时可选择同时删除。另一端刷新列表后可见新增或删除。

## 开发与贡献

使用 Node.js 24 和 npm。`npm run package` 会自动构建宿主与全部 Webview，无需先重复运行 build。

```sh
npm ci
npm run check      # Lint、类型检查和仓库回归测试
npm run build      # 生产构建
npm run watch      # 开发监听
```

在 VS Code 中按 F5 启动 Extension Development Host。涉及 Git / SVN 写操作的验证请使用临时仓库。

- [贡献指南](CONTRIBUTING.md)：代码结构、开发调试和验收方式。
- [CI 与发布](docs/ci-release.md)：工作流、VSIX 产物、版本标签及市场凭据。
- [安全政策](SECURITY.md)：私密报告安全问题。

## 来源与许可

感谢 [GitCharm](https://github.com/RioNoir/GitCharm) 作者 RioNoir 及其贡献者提供的基础实现。VersionDock 是经过修改、独立维护的衍生项目；本项目的改动与问题由本仓库维护者负责。

项目采用 [GPL-3.0-only](LICENSE)。上游来源和第三方资源说明见 [NOTICE](NOTICE.md) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。
