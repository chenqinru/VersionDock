# Contributing to VersionDock

Report VersionDock issues and submit pull requests to this repository. For security vulnerabilities, follow [SECURITY.md](SECURITY.md).

## Set up

Use Node.js 24, npm, VS Code 1.85.0+ and Git. Install SVN 1.14+ when working on SVN features.

```sh
git clone https://github.com/chenqinru/VersionDock.git
cd VersionDock
nvm install
nvm use
npm ci
```

Open the checkout in VS Code and press F5 to launch **Run Extension**. The launch configuration builds the extension before opening an Extension Development Host. Use `npm run watch` for incremental builds, or **Run Extension (no rebuild)** when a build is already available.

## Code structure

| Directory | Responsibility |
| --- | --- |
| `src/host/git/`, `src/host/svn/`, `src/host/vcs/` | Repository operations, CLI integration and Git/SVN boundaries |
| `src/host/panels/` | VS Code Webview providers and host message handling |
| `src/host/ai*/`, `src/host/remote/` | AI workflows and hosting-provider integration |
| `src/webview/` | React panels, state and shared components |
| `l10n/`, `package.nls*.json` | English and Simplified Chinese localization |
| `media/` | Runtime icons, fonts and related resources |
| `scripts/`, `.github/workflows/` | Regression tests, builds and release automation |

Both host and Webviews are bundled with esbuild. Repository operations belong in the host; Webviews communicate through the existing message protocol.

## Validate changes

```sh
npm run check
npm run package -- --out /tmp/versiondock-check.vsix
```

The checks cover lint, types, Git tag operations, shelves, scrollbar configuration and release behavior. Use temporary repositories for write operations and regression fixtures; preserve existing changes in real working copies.

For UI changes, check the affected view in the Extension Development Host with light / dark themes and English / Simplified Chinese. For repository changes, test the real Git/SVN path, including failures and conflicts where relevant. State which checks were performed; a successful build alone does not verify runtime behavior.

Optional checks with additional prerequisites:

```sh
# Node.js 24 and an installed Chromium browser; CHROME_PATH can select it
npm run test:scrollbars:browser

# An independent Desktop checkout and its Rust toolchain
npm run test:shelves -- --desktop /path/to/VersionDockDesktop
```

Keep tests focused on behavior and meaningful boundaries. Update both languages for user-visible text. Preserve upstream attribution and third-party notices when modifying or adding bundled resources.

## Issues and pull requests

For bugs, include the extension version, VS Code / OS versions, Git or SVN version, reproduction steps and relevant logs. Remove credentials and private repository details from shared logs and screenshots. Use [SECURITY.md](SECURITY.md) for vulnerabilities.

Keep pull requests focused, explain the behavior change and report validation. Use the existing PR template and Conventional Commits, for example `fix(shelve): preserve file permissions during restore`.

Treat other contributors respectfully and keep feedback focused on the issue. Release procedures and version consistency are documented in [CI and release](docs/ci-release.md).
