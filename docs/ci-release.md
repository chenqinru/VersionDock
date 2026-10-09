# CI 与 VSIX 发布

开发、CI 和发布统一使用 `.nvmrc` 中的 Node.js 24；GitHub runner 固定为 `ubuntu-24.04`，避免 `ubuntu-latest` 自动切换系统。首次安装依赖使用 `npm ci`。

## CI

向 `main` 推送、提交针对 `main` 的 PR 或手工运行 CI 时：

1. 安装锁定依赖。
2. 执行 `npm run check`：ESLint、宿主与 Webview 类型检查、标签/搁置/滚动条回归和发布脚本测试。
3. 通过 `npm run package` 构建宿主与全部 Webview 并生成 VSIX。
4. 将安装包上传到本次 Actions 的 Artifact，保留 14 天。

同一 ref 的新 CI 会取消旧 CI。CI 不创建版本标签、不发布插件市场。

浏览器滚动条交互测试和跨 Desktop 的搁置测试需要额外环境，可在本地分别执行 `npm run test:scrollbars:browser`、`npm run test:shelves -- --desktop /path/to/VersionDockDesktop`；普通 CI 运行插件仓库自身的回归测试。

## 发布

可使用仓库内的 [versiondock-extension-release Skill](../.agents/skills/versiondock-extension-release/SKILL.md) 执行插件发布流程：

```text
$versiondock-extension-release 发布当前插件版本，完成检查、打包、发布和结果核验
```

Skill 在发布请求下推进完整流程；用户明确只要求打包或生成说明时执行对应单项工作。创建或阅读 Skill 本身不改变版本或启动发布。插件更改日志维护在 `CHANGELOG.md`；写入 `dist/release-notes.md` 的人工 GitHub Release 正文目前是本地草稿，现有工作流仍会按 Git 提交重新生成发布正文。

可以在 Actions 中手工运行 **Release VSIX**，标签输入留空时使用 `v<package.json.version>`；也可以推送 `vX.Y.Z` 标签触发发布。

- 正式标签必须与 `package.json`、`package-lock.json` 顶层版本和 `packages[""].version` 一致，只接受稳定版本 `X.Y.Z`。
- 工作流发布当前所选 ref 的源码。已有标签必须指向当前提交，否则拒绝发布；不会移动已有标签。发布新代码应先升版本并提交，重试旧版本应选择原标签作为 workflow ref。
- 手工运行时，只有检查、测试和 VSIX 打包全部成功后才创建并推送新标签。
- 更新说明从当前提交的历史中寻找最近的已有正式标签，包含首次发布、无变化和非标准提交的情况。
- 已存在的同名 GitHub Release 资产保留，不使用 `--clobber` 覆盖。GitHub Release 失败不会进入市场发布。
- Marketplace 和 Open VSX 使用不同的并行任务，失败不会阻止另一市场尝试发布。两者使用本次验证过的 VSIX，发布工具版本及依赖由 lockfile 固定；重复版本使用 `--skip-duplicate`。

插件市场凭据配置在 **Settings → Secrets and variables → Actions**：

| Secret | 用途 |
| --- | --- |
| `VSCE_PAT` | 当前工作流的 Marketplace 发布 Token，需要对应 publisher 的扩展发布权限 |
| `OVSX_PAT` | Open VSX 发布 Token，需要对应 namespace 的发布权限 |

缺少某一 Token 时，工作流明确在该市场任务的 Summary 中记录跳过，不影响 GitHub Release 和另一市场。`GITHUB_TOKEN` 由 Actions 自动提供，只有 GitHub Release 任务需要 `contents: write`。

Marketplace 认证方式以[官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)为准；当前工作流尚未接入 Microsoft Entra ID。发布前检查 Token 的权限、有效期和平台政策，不能将现有 PAT 方式视为永久适用。

首次发布也可以从 [Marketplace 发布管理页面](https://marketplace.visualstudio.com/manage) 创建 / 选择与 `package.json.publisher` 一致的发布者，上传已验证的 VSIX。后续更新保持 `publisher` 和 `name` 不变，并提高版本号。

## 插件更改日志

根目录的 [CHANGELOG.md](../CHANGELOG.md) 随 VSIX 打包，VS Code 扩展详情中的“更改日志”页会读取该文件，无需额外注册命令或开发界面。中英文 README 也提供该文件的入口。

每次发布前，在文件顶部添加与 `package.json.version` 对应的 `## X.Y.Z` 章节，按版本倒序保留历史。中英文条目保持一致，描述用户可感知的新增、改进与修复；首次版本介绍当前能力。尚未发布时不编造发布日期或宣称已经上架。

版本脚本只同步版本元数据与 README 徽章，不会自动生成更改日志。发布 Skill 负责整理并维护 `CHANGELOG.md`；GitHub Release 正文仍由流水线按 Git 提交生成 `dist/release-notes.md`，两者分别维护，不会自动互相覆盖。

## 本地验证

```sh
nvm use
npm ci
npm run check
npm run package -- --out /tmp/versiondock-check.vsix
# 安装 actionlint 后验证工作流语法和内嵌 shell
actionlint .github/workflows/ci.yml .github/workflows/release-vsix.yml
```

`dist/` 为流水线输出目录，已从 Git 和 VSIX 中排除，避免把先前的 VSIX 或更新说明递归打进下一份包。
