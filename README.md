<p align="center">
  <img src="media/icons/versiondock-logo-dark.png" alt="VersionDock" width="128" height="128">
</p>

<h1 align="center">VersionDock</h1>

<p align="center">Manage Git and SVN changes, commits, history and conflicts inside VS Code.</p>

<p align="center">
  <a href="package.json"><img src="https://img.shields.io/badge/version-1.0.0-blue" alt="Version"></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS_Code-%3E%3D1.85.0-007ACC" alt="VS Code minimum version"></a>
  <a href="#workflows"><img src="https://img.shields.io/badge/VCS-Git_%2B_SVN-F05032?logo=git&amp;logoColor=white" alt="Git and SVN"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--only-blue" alt="GPL-3.0-only"></a>
  <a href="https://github.com/chenqinru/VersionDock/actions/workflows/ci.yml"><img src="https://img.shields.io/badge/CI-GitHub_Actions-2088FF?logo=githubactions&amp;logoColor=white" alt="GitHub Actions workflow"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README_zh.md">简体中文</a> ·
  <a href="https://github.com/chenqinru/VersionDock/issues">Issues</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

VersionDock supports mixed Git/SVN workspaces, operations across repositories, a three-pane conflict editor and optional AI workflows.

## Workflows

| Area | Current capabilities |
| --- | --- |
| Changes and commits | Tree / flat file views, diff previews, selected-file commits, Git stage / unstage, amend, commit and push, commit-message history |
| Multiple repositories | Mixed Git/SVN discovery, repository colors and visibility, combined changes and history; nested repositories manage their own files |
| History | Git branch graph, SVN revisions, file / selection history, author / text / date / branch filters, commit details and comparison |
| Branches and tags | Git create, checkout, merge, rebase, compare, rename and delete; tag creation, checkout, merge, push and local / remote deletion |
| Sync | Incoming / outgoing commits, fetch, pull, push, sync, undo of unpushed commits and local-change backups before updates |
| Local changes | Named changelists, native Git Stash, patch shelves, full / per-file restore and diff previews; shared shelves with Desktop |
| Conflicts | Git/SVN conflict lists, three-pane text merging, saving and marking resolutions, progress and abort actions for ongoing operations |
| Repository structure | Git submodule initialization / updates, worktree creation / pruning, subtree add / pull / push / split and related operations |
| Accounts and remotes | Git identity profiles, SVN authentication management, GitHub / GitLab / Gitee accounts and clone / publish entry points |
| Editor history | Git/SVN line annotations, current-line commit hints and navigation to history |

The Commit panel offers `simplified`, `changelists` and `vscode` layouts, light / dark themes, adjustable density and scrollbars, and a separate window.

## Optional AI workflows

AI features require a configured model service or local Agent CLI. Git and SVN operations work independently.

- **Commit messages** based on selected changes, with customizable prompts.
- **Commit explanations** grounded in historical changes and file diffs.
- **Code reviews** of selected changes.
- **Conflict resolution** that proposes text-conflict results for review and application.
- **Commit composition** that groups selected changes into an editable commit plan before execution.

| Mode | Integrations |
| --- | --- |
| Model service | GitHub Copilot, OpenAI, Claude, Gemini and custom OpenAI-compatible endpoints |
| Local Agent CLI | Claude, Codex, Antigravity and OpenCode |

OpenAI and custom endpoints support `chat-completions` and `responses`. CLI tools must be installed and authenticated separately. These workflows send selected code, diffs or conflict context to the configured service / Agent. Choose an integration appropriate for your repository. AI API keys are configured through VS Code settings; use user settings to avoid committing keys in workspace configuration.

## Conflict editor

The editor presents the current version, editable result and incoming version side by side, with per-conflict actions, navigation and synchronized scrolling. SVN property and tree conflicts are identified separately in the conflict list.

## Install and start

Runtime requirements: **VS Code 1.85.0+**, an available **Git** executable, and the `svn` command-line client for SVN working copies (1.14+ recommended). Installing Node.js separately is not required to run the packaged extension.

Building from source requires Node.js 24 and npm. The `nvm` commands below are for existing nvm installations; installing Node.js 24 directly also works.

Search the extension ID `chenqinru.versiondock` in VS Code, download an available VSIX from [Releases](https://github.com/chenqinru/VersionDock/releases), or build from source:

```sh
git clone https://github.com/chenqinru/VersionDock.git
cd VersionDock
# Install and use Node.js 24 as specified in .nvmrc
nvm install
nvm use
npm ci
npm run package
```

Run **Extensions: Install from VSIX…** in VS Code and select the generated `versiondock-<version>.vsix`. Open a folder containing Git repositories or SVN working copies.

- **VersionDock Commit** in the sidebar: inspect changes, select files, commit or save local changes.
- **VersionDock Log** in the panel: inspect history, branches / tags, commits and diffs.
- **Status bar branch entry**: repository-specific Git or SVN operations.
- **Command Palette**: search for `VersionDock` to open history, conflicts, annotations and settings.

## Common settings

Search for `versiondock` in VS Code settings. The extension's configuration lists all available options.

| Setting | Default | Purpose |
| --- | --- | --- |
| `versiondock.changesViewMode` | `simplified` | Changes layout |
| `versiondock.layoutDensity` | `comfortable` | UI density; also supports `compact` |
| `versiondock.scrollbarVisibility` | `system` | System, automatically hidden or always visible scrollbars |
| `versiondock.defaultSaveAction` | `stash` | Default to Git Stash or Shelve when saving changes |
| `versiondock.ai.executionMode` | `provider` | Model service or `agent-cli` |
| `versiondock.ai.provider` | `github-copilot` | Model provider |
| `versiondock.ai.apiProtocol` | `chat-completions` | OpenAI / custom endpoint protocol |
| `versiondock.ai.cli.provider` | `claude` | Local Agent CLI |

## Recommended: VersionDock Desktop

For Git/SVN management outside your editor, try [VersionDock Desktop](https://github.com/chenqinru/VersionDockDesktop). This standalone workbench runs on macOS, Windows and Linux, bringing changes, commits, synchronization, history and conflicts across multiple projects into one application.

Desktop and this extension are installed separately and can be used independently or together. See the [Desktop installation guide](https://github.com/chenqinru/VersionDockDesktop/blob/main/README_en.md#installation), or [download the app from Releases](https://github.com/chenqinru/VersionDockDesktop/releases).

## Git, SVN and Desktop

- SVN has no Git index: selected files are the SVN commit targets. Git Stash and patch shelves are Git-only features.
- SVN branch / tag operations recognize the conventional `trunk`, `branches` and `tags` layout. Availability depends on the repository structure.
- [VersionDock Desktop](https://github.com/chenqinru/VersionDockDesktop) is a separate desktop project. Updated versions of both clients share Stash, the Git index and shelves for the **same local Git working directory**. Independent clones do not share local data; shelves are isolated between worktrees. See [shelf interoperability](docs/shelf-interop.md).
- Restoring a shelf keeps its record by default. A full restore can also delete it. Refresh the other client to see additions or deletions.

## Development

Use Node.js 24 and npm. `npm run package` builds the host and all Webviews automatically.

```sh
npm ci
npm run check      # Lint, type checks and repository regression tests
npm run build      # Production build
npm run watch      # Development watch
```

Press F5 in VS Code to start the Extension Development Host. Use temporary repositories to verify Git/SVN writes.

- [Contribution guide](CONTRIBUTING.md): structure, setup and acceptance checks.
- [CI and release guide](docs/ci-release.md): workflows, VSIX artifacts, release tags and registry credentials.
- [Security policy](SECURITY.md): private vulnerability reporting.

## Attribution and license

Thanks to RioNoir and the contributors to [GitCharm](https://github.com/RioNoir/GitCharm) for the original implementation. VersionDock is a modified, independently maintained derivative. Changes and issues in this project are the responsibility of this repository's maintainers.

Distributed under [GPL-3.0-only](LICENSE). See [NOTICE](NOTICE.md) and [third-party notices](THIRD_PARTY_NOTICES.md) for source and resource attribution.
