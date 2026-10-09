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

手工运行时，`registry` 可选择 `marketplace`（只发布 VS Code Marketplace）、`open-vsx`（只发布 Open VSX）或 `all`（默认，两者都尝试）。推送标签仍按两者处理，缺少对应认证配置时跳过该市场。只发布一个市场时，使用手工运行并选择对应目标。

- 正式标签必须与 `package.json`、`package-lock.json` 顶层版本和 `packages[""].version` 一致，只接受稳定版本 `X.Y.Z`。
- 工作流发布当前所选 ref 的源码。已有标签必须指向当前提交，否则拒绝发布；不会移动已有标签。发布新代码应先升版本并提交，重试旧版本应选择原标签作为 workflow ref。
- 手工运行时，只有检查、测试和 VSIX 打包全部成功后才创建并推送新标签。
- 更新说明从当前提交的历史中寻找最近的已有正式标签，包含首次发布、无变化和非标准提交的情况。
- 已存在的同名 GitHub Release 资产保留，不使用 `--clobber` 覆盖。GitHub Release 失败不会进入市场发布。
- Marketplace 和 Open VSX 使用不同的并行任务，失败不会阻止另一市场尝试发布。两者使用本次验证过的 VSIX，发布工具版本及依赖由 lockfile 固定；重复版本使用 `--skip-duplicate`。

Marketplace 优先使用 GitHub OIDC 与 Microsoft Entra 应用身份认证；尚未配置 OIDC 时，可使用 PAT。Marketplace 发布任务使用 GitHub 的 `marketplace` Environment，拥有 `id-token: write`；Open VSX 任务不申请 OIDC Token。

### Marketplace OIDC 配置

1. 在 Microsoft Entra 的“应用注册”中创建单租户应用，重定向 URI 留空。记录“应用程序（客户端）ID”和“目录（租户）ID”；不需要创建客户端密码或托管身份。
2. 在应用的“证书和密码 → 联合身份凭据”中添加 GitHub Actions 凭据：颁发者 `https://token.actions.githubusercontent.com`，仓库所有者 `chenqinru`、所有者 ID `33949640`，仓库 `VersionDock`、仓库 ID `1301125862`，实体类型 Environment，环境名 `marketplace`，受众 `api://AzureADTokenExchange`。
3. 本仓库已启用 GitHub immutable subject，完整主题必须为 `repo:chenqinru@33949640/VersionDock@1301125862:environment:marketplace`。可用 `gh api repos/chenqinru/VersionDock/actions/oidc/customization/sub` 核对实际前缀；其他 fork 须使用自己的账号及仓库 ID，不能照抄。不要使用不带 ID 的旧主题，也不要按每个版本分别添加 Tag 凭据。
4. 在 GitHub 仓库 **Settings → Environments** 创建 `marketplace`，添加 Environment Variables：`AZURE_CLIENT_ID` 为应用程序（客户端）ID，`AZURE_TENANT_ID` 为目录（租户）ID。这些 ID 不是 Secret。发布任务也可读取同名 repository Variables；两者同时设置时以环境值为准。环境允许部署的分支 / 标签应覆盖 `main` 与正式版本的 `v*` 标签。
5. 从 `main` 手工运行 **Check Marketplace OIDC**。它不创建标签或发布扩展：先通过 `azure/login@v2` 登录，再读取 `https://app.vssps.visualstudio.com/_apis/profile/profiles/me`，输出 Marketplace identity ID。首次运行在身份尚未获得发布者授权时可能在权限检查步骤失败；已输出的 identity ID 仍可用于下一步。
6. 在 [Marketplace 管理页](https://marketplace.visualstudio.com/manage) 进入发布者 `chenqinru` 的 Members，按上一阶段输出的 Marketplace identity ID 添加应用身份，授予 Contributor。此 ID 来自 Marketplace profile API，不是应用程序客户端 ID、应用对象 ID 或租户 ID。
7. 重新运行 **Check Marketplace OIDC**；`vsce verify-pat --azure-credential chenqinru` 通过才说明应用取得发布者访问权限。尽管命令名称包含 `verify-pat`，`--azure-credential` 实际使用 Entra Token。登录成功和 profile 读取成功不能替代这个授权检查；正式发布仍需核验市场版本。

配置完整后，**Release VSIX** 会通过 OIDC 登录，使用 `vsce publish --azure-credential --packagePath ...` 发布已验证的安装包；`allow-no-subscriptions: true` 支持无 Azure 订阅的租户登录。它不绕过 Entra 注册权限或 Marketplace 发布者授权。仅设置一个 OIDC ID 会明确失败；OIDC 登录或发布失败不会静默降级为 PAT。

OIDC 工作流变更不会改变现有版本或移动已有标签。旧标签会使用当时的工作流；后续发布应让新版本提交包含 OIDC 配置，不用重新运行旧标签来假定使用了新认证。

参考：[GitHub OIDC 主题](https://docs.github.com/en/actions/reference/security/oidc)、[Azure Login](https://github.com/Azure/login)、[Marketplace 身份授权](https://learn.microsoft.com/en-us/azure/devops/extend/publish/command-line?view=azure-devops)和[VS Code 发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。

### PAT 兼容配置

PAT 配置在 **Settings → Secrets and variables → Actions**：

| Secret | 用途 |
| --- | --- |
| `VSCE_PAT` | 未配置 OIDC 时的 Marketplace 发布 Token，需要对应 publisher 的扩展发布权限 |
| `OVSX_PAT` | Open VSX 发布 Token，需要对应 namespace 的发布权限 |

Marketplace 同时缺少 OIDC ID 和 PAT，或 Open VSX 缺少 PAT 时，工作流在对应任务的 Summary 中记录跳过，不影响 GitHub Release 和另一市场。`GITHUB_TOKEN` 由 Actions 自动提供，只有 GitHub Release 任务需要 `contents: write`。

Marketplace 认证方式以[官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)为准。使用 PAT 时检查其权限、有效期和平台政策；Open VSX 的 PAT 与 Marketplace OIDC 分别配置。

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
actionlint .github/workflows/*.yml
```

`dist/` 为流水线输出目录，已从 Git 和 VSIX 中排除，避免把先前的 VSIX 或更新说明递归打进下一份包。
