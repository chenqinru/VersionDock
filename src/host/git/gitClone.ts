import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execCli } from '../vcs/cli';
import { t } from '../utils/l10n';
import type { WorkspaceGitManager } from './WorkspaceGitManager';
import type { RemoteRepositoryService } from '../remote/RemoteRepositoryService';
import type { RemoteRepository } from '../remote/types';

function isDirectoryEmpty(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    // 忽略常见的系统静默生成的空文件
    const meaningfulEntries = entries.filter(e => e !== '.DS_Store' && e !== 'Thumbs.db');
    return meaningfulEntries.length === 0;
  } catch {
    return true;
  }
}

function isValidFolderName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (path.basename(trimmed) !== trimmed) return false;
  if (/[<>:"|?*]/.test(trimmed)) return false;
  return true;
}

interface CredentialHelperContext {
  env: NodeJS.ProcessEnv;
  args: string[];
  cleanup: () => Promise<void>;
}

async function prepareGitCredentialHelper(
  targetUrl: string,
  credentials?: { username: string; password: string },
): Promise<CredentialHelperContext> {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };

  if (!credentials) {
    return { env: baseEnv, args: [], cleanup: async () => {} };
  }

  let targetProtocol = '';
  let targetHostname = '';
  let targetEffectivePort = '';
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { env: baseEnv, args: [], cleanup: async () => {} };
    }
    targetProtocol = parsed.protocol.replace(/:$/, '').toLowerCase();
    targetHostname = parsed.hostname.toLowerCase();
    targetEffectivePort = parsed.port || (targetProtocol === 'https' ? '443' : '80');
  } catch {
    return { env: baseEnv, args: [], cleanup: async () => {} };
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'versiondock-git-auth-'));
  const nodePath = process.execPath;
  const helperScriptPath = path.join(tempDir, 'credential-helper.cjs');

  const helperContent = `
const fs = require('fs');
const input = fs.readFileSync(0, 'utf8');
const lines = input.split(/\\r?\\n/);
const data = {};
for (const line of lines) {
  const idx = line.indexOf('=');
  if (idx !== -1) {
    data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
}

let reqProtocol = (data.protocol || '').toLowerCase().trim().replace(/:$/, '');
let reqHost = (data.host || '').toLowerCase().trim();
let reqHostname = '';
let reqPort = '';

if (data.url) {
  try {
    const u = new URL(data.url);
    reqProtocol = reqProtocol || u.protocol.replace(/:$/, '').toLowerCase();
    reqHostname = u.hostname.toLowerCase();
    reqPort = u.port;
  } catch {}
}

if (!reqHostname && reqHost) {
  if (reqHost.startsWith('[') && reqHost.includes(']')) {
    const closeBracket = reqHost.indexOf(']');
    reqHostname = reqHost.slice(0, closeBracket + 1);
    if (reqHost.slice(closeBracket + 1).startsWith(':')) {
      reqPort = reqHost.slice(closeBracket + 2);
    }
  } else {
    const idx = reqHost.lastIndexOf(':');
    if (idx !== -1) {
      reqHostname = reqHost.slice(0, idx);
      reqPort = reqHost.slice(idx + 1);
    } else {
      reqHostname = reqHost;
    }
  }
}

const reqEffectivePort = reqPort || (reqProtocol === 'https' ? '443' : reqProtocol === 'http' ? '80' : '');

const targetProtocol = (process.env.VERSIONDOCK_TARGET_PROTOCOL || '').toLowerCase();
const targetHostname = (process.env.VERSIONDOCK_TARGET_HOSTNAME || '').toLowerCase();
const targetEffectivePort = (process.env.VERSIONDOCK_TARGET_EFFECTIVE_PORT || '').toLowerCase();

const isMatch = targetProtocol &&
  targetHostname &&
  targetEffectivePort &&
  reqProtocol === targetProtocol &&
  reqHostname === targetHostname &&
  reqEffectivePort === targetEffectivePort;

if (isMatch) {
  if (process.argv[2] === 'get') {
    const u = process.env.VERSIONDOCK_GIT_USERNAME || '';
    const p = process.env.VERSIONDOCK_GIT_PASSWORD || '';
    if (u) process.stdout.write('username=' + u + '\\n');
    if (p) process.stdout.write('password=' + p + '\\n');
  }
}
`;
  await fs.promises.writeFile(helperScriptPath, helperContent.trim(), { mode: 0o600 });

  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    VERSIONDOCK_TARGET_PROTOCOL: targetProtocol,
    VERSIONDOCK_TARGET_HOSTNAME: targetHostname,
    VERSIONDOCK_TARGET_EFFECTIVE_PORT: targetEffectivePort,
    VERSIONDOCK_GIT_USERNAME: credentials.username,
    VERSIONDOCK_GIT_PASSWORD: credentials.password,
    ELECTRON_RUN_AS_NODE: '1',
  };

  const parsed = new URL(targetUrl);
  const originUrl = `${targetProtocol}://${targetHostname}${parsed.port ? `:${parsed.port}` : ''}`;

  const args = [
    '-c', `credential.${originUrl}.helper=`,
    '-c', `credential.${originUrl}.helper=!${JSON.stringify(nodePath)} ${JSON.stringify(helperScriptPath)}`,
  ];

  return {
    env,
    args,
    cleanup: async () => {
      try {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      } catch {
        // 忽略清理临时目录失败
      }
    },
  };
}

interface CloneSourceQuickPickItem extends vscode.QuickPickItem {
  id: 'github' | 'gitlab' | 'url' | 'direct-url';
  cloneUrl?: string;
}

async function promptForManualUrl(): Promise<string | undefined> {
  const gitUrl = await vscode.window.showInputBox({
    title: t('Clone Git Repository'),
    prompt: t('Enter the Git repository URL (e.g. https://... or git@...)'),
    placeHolder: 'https://github.com/username/repository.git',
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return t('Git URL cannot be empty');
      }
      if (!/^(https?|git|ssh|file):\/\//i.test(trimmed) && !/^git@[\w.-]+:/i.test(trimmed)) {
        return t('Invalid Git URL. Expected an http(s) URL, ssh URL, or git@ address');
      }
      return undefined;
    },
  });
  return gitUrl?.trim();
}

async function pickGitHubRepository(remoteService: RemoteRepositoryService): Promise<string | undefined> {
  try {
    const repos = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Fetching repositories from GitHub…'),
        cancellable: true,
      },
      async (_progress, token) => {
        const fetchPromise = remoteService.github.listRepositories();
        return await Promise.race([
          fetchPromise,
          new Promise<never>((_, reject) => {
            token.onCancellationRequested(() => reject(new Error(t('Operation cancelled.'))));
          }),
        ]);
      }
    );

    if (repos.length === 0) {
      void vscode.window.showInformationMessage(t('No GitHub repositories found for your account.'));
      return undefined;
    }

    interface RepoItem extends vscode.QuickPickItem {
      cloneUrl: string;
    }

    const items: RepoItem[] = repos.map(repo => ({
      label: `$(repo) ${repo.fullName}`,
      description: repo.private ? `$(lock) ${t('Private')}` : `$(globe) ${t('Public')}`,
      detail: repo.cloneUrl,
      cloneUrl: repo.cloneUrl,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: t('Select GitHub Repository'),
      placeHolder: t('Search or select a repository to clone'),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });

    return selected?.cloneUrl;
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    if (!msg.includes(t('Operation cancelled.'))) {
      void vscode.window.showErrorMessage(t('Failed to fetch GitHub repositories: {0}', msg));
    }
    return undefined;
  }
}

async function pickGitLabRepository(remoteService: RemoteRepositoryService): Promise<string | undefined> {
  try {
    let repos: RemoteRepository[] = [];
    try {
      repos = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('Fetching repositories from GitLab…'),
          cancellable: true,
        },
        async (_progress, token) => {
          const fetchPromise = remoteService.gitlab.listRepositories();
          return await Promise.race([
            fetchPromise,
            new Promise<never>((_, reject) => {
              token.onCancellationRequested(() => reject(new Error(t('Operation cancelled.'))));
            }),
          ]);
        }
      );
    } catch (fetchErr: unknown) {
      const errStr = String(fetchErr);
      const isAuthErr = errStr.includes('authentication') || errStr.includes('account') || errStr.includes('cancelled');
      if (isAuthErr) {
        const manage = t('Manage GitLab Accounts');
        const choice = await vscode.window.showWarningMessage(
          t('GitLab authentication is required to list repositories.'),
          manage,
        );
        if (choice === manage) {
          await remoteService.gitlab.manageAccounts();
        }
        return undefined;
      }
      throw fetchErr;
    }

    if (repos.length === 0) {
      const manage = t('Manage GitLab Accounts');
      const choice = await vscode.window.showInformationMessage(
        t('No GitLab projects found. Would you like to check or add GitLab accounts?'),
        manage,
      );
      if (choice === manage) {
        await remoteService.gitlab.manageAccounts();
      }
      return undefined;
    }

    interface RepoItem extends vscode.QuickPickItem {
      cloneUrl: string;
    }

    const items: RepoItem[] = repos.map(repo => ({
      label: `$(repo) ${repo.fullName}`,
      description: `${repo.host} · ${repo.private ? t('Private') : t('Public')}`,
      detail: repo.cloneUrl,
      cloneUrl: repo.cloneUrl,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      title: t('Select GitLab Repository'),
      placeHolder: t('Search or select a project to clone'),
      matchOnDescription: true,
      matchOnDetail: true,
      ignoreFocusOut: true,
    });

    return selected?.cloneUrl;
  } catch (err: unknown) {
    const msg = (err as Error)?.message || String(err);
    if (!msg.includes(t('Operation cancelled.'))) {
      void vscode.window.showErrorMessage(t('Failed to fetch GitLab repositories: {0}', msg));
    }
    return undefined;
  }
}

type CloneSourceResult =
  | { kind: 'github' }
  | { kind: 'gitlab' }
  | { kind: 'url' }
  | { kind: 'direct-url'; url: string };

function promptForCloneSource(): Promise<CloneSourceResult | undefined> {
  return new Promise<CloneSourceResult | undefined>((resolve) => {
    const qp = vscode.window.createQuickPick<CloneSourceQuickPickItem>();
    qp.title = t('Clone Git Repository');
    qp.placeholder = t('Select clone source or paste a repository URL');
    qp.ignoreFocusOut = true;

    const baseItems: CloneSourceQuickPickItem[] = [
      {
        id: 'github',
        label: `$(github) ${t('Clone from GitHub…')}`,
        detail: t('Search and clone from your GitHub repositories'),
      },
      {
        id: 'gitlab',
        label: `$(repo) ${t('Clone from GitLab…')}`,
        detail: t('Search and clone from your GitLab projects'),
      },
      {
        id: 'url',
        label: `$(link) ${t('Provide repository URL…')}`,
        detail: t('Clone from any URL (HTTPS, SSH, git@)'),
      },
    ];

    const updateItems = () => {
      const val = qp.value.trim();
      const isUrl = /^(https?|git|ssh|file):\/\//i.test(val) || /^git@[\w.-]+:/i.test(val);
      if (isUrl) {
        qp.items = [
          {
            id: 'direct-url',
            label: `$(cloud-download) ${t('Clone from URL: {0}', val)}`,
            detail: val,
            cloneUrl: val,
          },
          ...baseItems,
        ];
      } else {
        qp.items = baseItems;
      }
    };

    updateItems();
    qp.onDidChangeValue(updateItems);

    let acceptedResult: CloneSourceResult | undefined = undefined;

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      const val = qp.value.trim();
      if (!selected) {
        if (/^(https?|git|ssh|file):\/\//i.test(val) || /^git@[\w.-]+:/i.test(val)) {
          acceptedResult = { kind: 'direct-url', url: val };
        }
      } else if (selected.id === 'direct-url' && selected.cloneUrl) {
        acceptedResult = { kind: 'direct-url', url: selected.cloneUrl };
      } else if (selected.id === 'github') {
        acceptedResult = { kind: 'github' };
      } else if (selected.id === 'gitlab') {
        acceptedResult = { kind: 'gitlab' };
      } else if (selected.id === 'url') {
        acceptedResult = { kind: 'url' };
      }
      qp.hide();
    });

    qp.onDidHide(() => {
      qp.dispose();
      resolve(acceptedResult);
    });

    qp.show();
  });
}

async function promptForGitCloneUrl(remoteService?: RemoteRepositoryService): Promise<string | undefined> {
  if (!remoteService) {
    return await promptForManualUrl();
  }

  const source = await promptForCloneSource();
  if (!source) return undefined;

  if (source.kind === 'direct-url') {
    return source.url;
  }

  if (source.kind === 'url') {
    return await promptForManualUrl();
  }

  if (source.kind === 'github') {
    return await pickGitHubRepository(remoteService);
  }

  if (source.kind === 'gitlab') {
    return await pickGitLabRepository(remoteService);
  }

  return undefined;
}

/**
 * 从远端克隆 Git 仓库到当前工作区或指定目录
 */
export async function cloneGitRepository(
  manager?: WorkspaceGitManager,
  targetDir?: string,
  remoteService?: RemoteRepositoryService,
): Promise<void> {
  const effectiveRemoteService = remoteService ?? manager?.remoteService;

  // 1. 验证系统环境是否安装了 git
  try {
    await execCli('git', ['--version'], {
      cwd: os.homedir(),
      timeout: 10_000,
    });
  } catch (err: unknown) {
    const errorString = String(err);
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' || errorString.includes('ENOENT')) {
      void vscode.window.showErrorMessage(
        t("Git command-line tool is not found. Please install Git and ensure 'git' is available in your PATH.")
      );
      return;
    }
  }

  // 2. 提示输入或选择 Git 仓库 URL
  const gitUrl = await promptForGitCloneUrl(effectiveRemoteService);
  if (!gitUrl) return;
  const trimmedUrl = gitUrl.trim();

  // 3. 确定目标检出目录
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  let checkoutDir = targetDir;
  let isNewProjectWindow = false;

  const hasRepos = manager ? manager.getRepoMetas().length > 0 : false;

  let targetExistedBefore = false;

  const promptForBrowseDestination = async (): Promise<{ dir: string; isNewWindow: boolean; existedBefore: boolean } | undefined> => {
    const selectedFolders = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      title: t('Select Destination Folder for Git Clone'),
      openLabel: t('Select Destination'),
    });
    if (!selectedFolders || selectedFolders.length === 0) return undefined;
    const parentDir = selectedFolders[0].fsPath;

    // 根据 URL 末尾推导默认文件夹名
    const defaultFolderName = trimmedUrl
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop() || 'git-project';

    const folderName = await vscode.window.showInputBox({
      title: t('Git Clone Folder Name'),
      prompt: t('Specify the directory name for the cloned project'),
      value: defaultFolderName,
      ignoreFocusOut: true,
      validateInput: (val: string) => {
        const trimmed = val.trim();
        if (!trimmed) return t('Folder name cannot be empty');
        if (!isValidFolderName(trimmed)) {
          return t('Invalid folder name. It must be a single directory name and cannot contain path separators, "..", or special characters.');
        }
        return undefined;
      },
    });
    if (!folderName) return undefined;

    const chosenDir = path.join(parentDir, folderName.trim());
    const existedBefore = fs.existsSync(chosenDir);
    if (existedBefore && !isDirectoryEmpty(chosenDir)) {
      void vscode.window.showErrorMessage(
        t('Target directory {0} already exists and is not empty. Git clone requires an empty directory.', chosenDir)
      );
      return undefined;
    }
    return { dir: chosenDir, isNewWindow: true, existedBefore };
  };

  if (!checkoutDir) {
    if (workspaceFolder && !hasRepos) {
      interface CheckoutTargetQuickPickItem extends vscode.QuickPickItem {
        id: 'current' | 'browse';
      }

      const pick = await vscode.window.showQuickPick<CheckoutTargetQuickPickItem>(
        [
          {
            id: 'current',
            label: `$(folder) ${t('Clone to current folder ({0})', workspaceFolder.name)}`,
            description: workspaceFolder.uri.fsPath,
            detail: t('Use the currently opened workspace folder as clone destination'),
          },
          {
            id: 'browse',
            label: `$(file-directory-create) ${t('Choose another destination directory…')}`,
            detail: t('Browse for a destination folder and create a new project directory (like Git Clone)'),
          },
        ],
        {
          title: t('Select Destination Directory'),
          placeHolder: t('Select where to clone the Git repository'),
          ignoreFocusOut: true,
        }
      );

      if (!pick) return;

      if (pick.id === 'current') {
        const currentPath = workspaceFolder.uri.fsPath;
        if (!isDirectoryEmpty(currentPath)) {
          const proceed = await vscode.window.showWarningMessage(
            t('The current folder is not empty. Git clone into the current directory requires an empty folder.'),
            t('Choose another destination directory…'),
          );
          if (proceed === t('Choose another destination directory…')) {
            const result = await promptForBrowseDestination();
            if (!result) return;
            checkoutDir = result.dir;
            isNewProjectWindow = result.isNewWindow;
            targetExistedBefore = result.existedBefore;
          } else {
            return;
          }
        } else {
          checkoutDir = currentPath;
          isNewProjectWindow = false;
          targetExistedBefore = true;
        }
      } else {
        const result = await promptForBrowseDestination();
        if (!result) return;
        checkoutDir = result.dir;
        isNewProjectWindow = result.isNewWindow;
        targetExistedBefore = result.existedBefore;
      }
    } else {
      const result = await promptForBrowseDestination();
      if (!result) return;
      checkoutDir = result.dir;
      isNewProjectWindow = result.isNewWindow;
      targetExistedBefore = result.existedBefore;
    }
  } else {
    targetExistedBefore = fs.existsSync(checkoutDir);
  }

  // 4. 执行 git clone
  const finalDir = checkoutDir;
  const parentDir = path.dirname(finalDir);
  const folderName = path.basename(finalDir);
  const stagingDir = !targetExistedBefore
    ? path.join(parentDir, `.${folderName}.vd-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    : path.join(finalDir, `.vd-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const doClone = async (): Promise<boolean> => {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Cloning Git repository...'),
        cancellable: true,
      },
      async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
          abortController.abort();
        });

        progress.report({ message: trimmedUrl });

        const credentials = effectiveRemoteService ? await effectiveRemoteService.resolveCredentialsForUrl(trimmedUrl) : undefined;
        const helper = await prepareGitCredentialHelper(trimmedUrl, credentials);

        try {
          const config = vscode.workspace.getConfiguration('versiondock');
          const recurseSubmodules = config.get<boolean>('git.cloneRecursiveSubmodules', true);
          const baseCloneArgs = ['clone'];
          if (recurseSubmodules) {
            baseCloneArgs.push('--recurse-submodules');
          }

          if (!targetExistedBefore && !fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          await execCli('git', [...helper.args, ...baseCloneArgs, trimmedUrl, stagingDir], {
            cwd: targetExistedBefore ? finalDir : parentDir,
            timeout: 600_000,
            env: helper.env,
            signal: abortController.signal,
          });

          if (!targetExistedBefore) {
            if (fs.existsSync(finalDir)) {
              void vscode.window.showErrorMessage(
                t('Target directory {0} was created during the operation. Staging files are kept at {1}.', finalDir, stagingDir)
              );
              return false;
            }
            await fs.promises.rename(stagingDir, finalDir);
          } else {
            const remaining = fs.readdirSync(finalDir).filter(e => e !== path.basename(stagingDir) && e !== '.DS_Store' && e !== 'Thumbs.db');
            if (remaining.length > 0) {
              void vscode.window.showErrorMessage(
                t('Target directory {0} is no longer empty. Staging files are kept at {1}.', finalDir, stagingDir)
              );
              return false;
            }
            const entries = await fs.promises.readdir(stagingDir);
            for (const entry of entries) {
              await fs.promises.rename(path.join(stagingDir, entry), path.join(finalDir, entry));
            }
            await fs.promises.rm(stagingDir, { recursive: true, force: true });
          }
          return true;
        } catch (err: unknown) {
          if (fs.existsSync(stagingDir)) {
            try {
              await fs.promises.rm(stagingDir, { recursive: true, force: true });
            } catch {
              // 忽略清理临时目录的异常
            }
          }

          if (token.isCancellationRequested) {
            return false;
          }
          void vscode.window.showErrorMessage(
            t('Git Clone failed: {0}', (err as Error)?.message || String(err))
          );
          return false;
        } finally {
          await helper.cleanup();
        }
      }
    );
  };

  const success = manager
    ? await manager.runWithCheckoutSuppressed([finalDir, stagingDir], doClone)
    : await doClone();

  if (!success) {
    return;
  }

  // 5. 克隆成功后续动作
  if (isNewProjectWindow) {
    const choice = await vscode.window.showInformationMessage(
      t('Git clone completed successfully. Would you like to open the project?'),
      t('Open in Current Window'),
      t('Open in New Window'),
    );
    if (choice === t('Open in Current Window')) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(finalDir), false);
    } else if (choice === t('Open in New Window')) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(finalDir), true);
    }
  } else {
    void vscode.window.showInformationMessage(t('Git repository cloned successfully.'));
    manager?.reinitializeAndRefresh();
  }
}
