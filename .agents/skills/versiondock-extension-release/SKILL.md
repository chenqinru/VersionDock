---
name: versiondock-extension-release
description: "完成当前 VersionDock VS Code 插件的版本准备、更新说明、检查、VSIX 打包、首次上架和后续自动发布。适用于插件发布、版本更新、打包及发布说明请求。"
---

# VersionDock 插件发布

完成插件从版本整理、检查打包到上架和结果核验的发布流程。复用当前仓库脚本，由 Codex 根据真实差异整理说明，不需要额外 AI 服务。

## 确定任务与版本

- 从仓库根目录读取 `git status --short`、`package.json`、`.nvmrc`、[发布维护指南](../../../docs/ci-release.md)；要自动发布时再读 `.github/workflows/release-vsix.yml` 和 `scripts/release.mjs`。保留已有改动。
- 用户要求发布或准备发布时，推进完整流程：确定版本、整理说明、检查、打包、提交发布改动、推送、发布并核验结果，不默认停在本地准备。用户明确只要求打包、生成说明或其他单项工作时，按该目标执行。创建或修改 Skill、解释用法本身不触发实际发布。
- 优先使用明确版本号。当前版本尚未公开且已高于已确认发布基线时，继续准备当前版本，避免重复递增；首次发布没有基线时也保留当前版本。否则默认 patch，简短告知假设后调用现有脚本。仅当基线或身份无法自行确认且会影响结果时询问用户。
- 正式版本必须是 `X.Y.Z`。版本边界以当前产品发布为准，不能把二开前的内部版本或上游标签直接当作 VersionDock 的公开市场版本。用户明确指定首次版本时遵从；已用同一市场 ID 发布的版本必须递增。
- 本地标签、GitHub Release、Marketplace 和 Open VSX 是独立状态。需要发布时按用户选定渠道查询实际版本和身份；不能凭本地标签认定市场已上架。

## 整理真实变更

1. 优先使用用户给出的基线；否则查看当前历史中可达的正式标签及相关发布记录，确认基线在 `HEAD` 的祖先链中。排除目标标签、后续或其他分支标签；历史缺失时先核查浅克隆或缺失标签，不编造基线。
2. 检查基线到 `HEAD` 的提交正文、文件列表及累计 diff；准备默认还检查暂存、未暂存和相关未跟踪源码，并说明它们尚未提交。只读取与本次变化有关的文件，提交标题仅作线索，已撤销的改动不作为功能交付。
3. 首次发布介绍当前真正实现的主要能力；后续版本描述用户可感知的功能、修复和安装 / 兼容性变化。合并重复条目，不用纯格式、Skill 维护或无影响 CI 改动凑数量，不把静态检查或占位功能写成运行成功。
   发布前将目标版本的中英文说明写入根目录 `CHANGELOG.md`，使用 `## X.Y.Z` 标题，按版本倒序保留历史。仅补日志时保留当前版本，不触发发布；日期只在确认实际发布日期后添加。VS Code 读取包内该文件显示更改日志，不会读取 `dist/release-notes.md`。
4. 用户要求人工 GitHub Release 正文时整理中文与英文，内容逐条对应，保留用户补充；使用插件现有的 `scripts/release.mjs` 和发布说明输出路径。
5. 当前流水线通过 `scripts/release.mjs notes` 从提交标题生成 `dist/release-notes.md`；本地润色会在流水线中被重新生成。明确区分插件更改日志、自动 Release 正文与人工草稿：只生成 Release 正文可把双语稿写入该本地文件并交付，不能声称流水线已接入人工稿。用户明确要求持久化人工 Release 正文或让流水线采用它时，先在该任务范围内接入实际读取链路并验证，不只编辑临时文件。

## 同步、校验与打包

- 准备版本时使用 `npm run version:bump -- TARGET_VERSION`，把 `TARGET_VERSION` 替换为明确目标。只生成说明不调用；已经是目标版本时不重复升版。核对 package、锁文件顶层与 `packages[""]` 版本以及双语 README 徽章，不更改依赖版本。
- 可以直接复用现有版本校验，不另写一套规则：

  ```sh
  node --input-type=module -e "import { packageVersion } from './scripts/release.mjs'; console.log(packageVersion(process.cwd()))"
  ```

- 本地正式安装包运行 `npm run check` 并完成打包；同一源码和依赖状态已通过的结果可复用。仅说明或文档修改按实际影响选择检查。`check` 不含构建，`package` 会自动执行生产构建：

  ```sh
  mkdir -p dist
  task_release_version=$(node -p "require('./package.json').version")
  npm run package -- --out "dist/versiondock-${task_release_version}.vsix"
  ```

- 需要自动更新说明时，使用 `RELEASE_TAG` 指定匹配目标版本的 `vX.Y.Z`，运行 `node scripts/release.mjs notes`。只写入忽略的 `dist/`，不把本地输出当作源码提交。
- 检查实际 VSIX 的扩展 ID、版本、Logo、宿主与所有 Webview、许可文本、`CHANGELOG.md` 及排除规则。不要重命名旧 VSIX 冒充新版本。需要真实安装验收时，在 VS Code 安装该文件并检查版本与受影响功能；没有运行就注明未验收。
- 交付目标版本、基线、实际变更、VSIX 路径和检查结果，区分草稿、检查通过、打包成功和公开发布。

## 选择发布方式

细节见 [发布维护指南](../../../docs/ci-release.md)。默认使用现有 **Release VSIX** 工作流：创建 GitHub Release，并向已配置凭据的插件市场发布。用户指定渠道时按该渠道执行；首次上架根据 publisher、认证和 runner 是否就绪选择网页上传、本地 CLI 或流水线。

- **手动 Marketplace 上架**：确认用户实际拥有与 manifest 一致的 publisher，交付新生成的 VSIX；网页上传由用户完成时报告等待上传，不声称已上架。该方式不需要 GitHub Actions 或流水线 Secret。
- **本地 CLI 发布**：认证已就绪时，发布经过校验的包：`npm exec -- vsce publish --packagePath "dist/versiondock-${task_release_version}.vsix"`。版本变量来自当前 metadata，凭据由安全的现有认证方式提供，不能要求用户把 Token 发在聊天中。
- **自动发布**：先确认远端含有所需工作流与发布提交、目标渠道凭据及 runner 可用，再推送匹配版本的标签或触发 **Release VSIX**。用户仅指定一个渠道时选择匹配的发布路径，避免同时发布其他渠道。
- 当前工作流依赖 `VSCE_PAT` / `OVSX_PAT`。缺少某项时对应市场任务会跳过；GitHub Release 成功不代表市场成功。认证规范会变化，发布前按[官方文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)确认适用方式，不把当前 PAT 流程写成永久要求或宣称 Entra ID 已接入。
- 发布请求按当前和此前有效的指令推进，不对已经明确的提交、标签、推送或发布动作重复确认。仅在发布身份、凭据或关键目标确实缺失且无法自行核实时询问；先完成不依赖该信息的检查和安装包。仓库公开状态与插件上架状态分别核验，不因发布插件改变仓库可见性。

## 发布核验与失败处理

- 分别核对用户选择的每个渠道：GitHub 标签 SHA、Release 与资产，Marketplace / Open VSX 的 publisher、扩展 ID 和版本。任务跳过、重复版本被忽略或旧页面存在，都不能独立证明本次新版本发布成功。
- 已公开版本保留，修正内容使用新版本；不强推标签、不使用 `--clobber` 覆盖公开包。现有流程允许给同一标签的 GitHub Release 补缺失附件，执行前先核实实际状态和目标渠道。
- 网络、权限、认证、版本冲突、检查失败与 runner 未启动分别定位。无日志且无步骤时查看 GitHub check annotations，账户付款或消费额度错误不能靠修改构建命令解决。
- 一端发布成功、另一端失败时保留成功结果，优先补发失败渠道并复用已验证的包。远端明确成功后不重复发布；未知响应先查询状态。权限 / 认证失败停止盲目重试，网络或服务端暂时错误在核实状态后最多重试两次。
- 代码需要修改时使用新发布提交及适当的新版本；重跑历史任务使用旧工作流和源码，不能假设会获得本地最新修复。报告已完成渠道、未完成渠道、具体阻碍和下一步。
