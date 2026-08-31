# Contributing to VersionDock

Thank you for your interest in contributing to VersionDock! We welcome contributions from the community.

## 📋 Code of Conduct

This project adheres to the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

## 🛠️ Getting Started

### Prerequisites

- **Node.js**: `v20` or higher
- **npm**: `v9` or higher
- **VS Code**: `1.85.0` or higher
- **Git**: Installed and available in PATH
- **SVN** (optional): `1.14.0` or higher for SVN features

### Setting Up Local Development

1. **Fork and clone the repository:**
   ```bash
   git clone https://github.com/<your-username>/VersionDock.git
   cd VersionDock
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start watching sources (incremental build):**
   ```bash
   npm run watch
   ```

4. **Launch Extension in Debug Mode:**
   - Open the project in VS Code.
   - Press `F5` (or go to **Run and Debug** -> Select **Run Extension**).
   - A new Extension Development Host window will open with VersionDock active.

## 🧪 Quality Checks

Before submitting a Pull Request, ensure all checks pass:

```bash
# Run ESLint
npm run lint

# Run TypeScript type-checking for host and webviews
npm run typecheck

# Full production build
npm run build
```

## 📝 Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` A new feature
- `fix:` A bug fix
- `docs:` Documentation changes
- `style:` Formatting, missing semicolons, etc. (no code change)
- `refactor:` Refactoring code without changing behavior
- `perf:` Performance improvements
- `test:` Adding or updating tests
- `chore:` Maintenance, dependencies, build tasks

Example:
```text
feat(commit-panel): add quick search for changed files
fix(git-graph): correct merge lane rendering for detached HEAD
```

## 🚀 Submitting a Pull Request

1. Create a descriptive feature branch (`git checkout -b feat/my-new-feature`).
2. Make your changes with clear, focused commits.
3. Verify `npm run lint`, `npm run typecheck`, and `npm run build`.
4. Push your branch (`git push origin feat/my-new-feature`).
5. Open a Pull Request on GitHub against the `main` branch with the provided PR template filled out.
