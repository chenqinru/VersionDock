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
| `VSCE_PAT` | VS Code Marketplace 发布 Token，需要对应 publisher 的扩展发布权限 |
| `OVSX_PAT` | Open VSX 发布 Token，需要对应 namespace 的发布权限 |

缺少某一 Token 时，工作流明确在该市场任务的 Summary 中记录跳过，不影响 GitHub Release 和另一市场。`GITHUB_TOKEN` 由 Actions 自动提供，只有 GitHub Release 任务需要 `contents: write`。

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

## 尚未启动 runner 的失败

2026-10-08 的 CI（run `37714783333`）没有执行任何步骤。GitHub annotation 明确指出近期账户付款失败或消费额度需要提高。这是账户层限制，修复 YAML 不会恢复 runner。

需要仓库账户所有者在 [Billing & plans](https://github.com/settings/billing) 检查付款状态和 Actions 消费额度，恢复后重新运行 CI。该仓库当时没有 self-hosted runner；本次改动继续使用 GitHub 托管 runner，不改动账户账单设置。
