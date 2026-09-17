import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execCli, CliError } from '../vcs/cli';
import { t } from '../utils/l10n';
import { isValidTargetDirName } from '../utils/repoPath';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

const SVN_AUTH_CACHE_ARGS = [
  '--config-option', 'servers:global:store-passwords=yes',
  '--config-option', 'servers:global:store-auth-creds=yes',
];

function isDirectoryEmpty(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    const meaningfulEntries = entries.filter(e => e !== '.DS_Store' && e !== 'Thumbs.db');
    return meaningfulEntries.length === 0;
  } catch {
    return true;
  }
}

const isValidFolderName = isValidTargetDirName;

async function checkSvnPasswordFromStdinSupport(cwd: string): Promise<boolean> {
  return execCli('svn', ['--version', '--quiet'], { cwd, timeout: 15_000 })
    .then(result => {
      const match = result.stdout.match(/(\d+)\.(\d+)/);
      if (!match) return false;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      return major > 1 || (major === 1 && minor >= 10);
    })
    .catch(() => false);
}

function redactPassword(error: unknown, password: string): unknown {
  if (!(error instanceof CliError)) return error;
  const args = error.args.map((arg, index, all) => all[index - 1] === '--password' ? '<redacted>' : arg);
  const redact = (value: string): string => password ? value.split(password).join('<redacted>') : value;
  return new CliError(
    redact(error.message),
    error.command,
    args,
    redact(error.stdout),
    redact(error.stderr),
    error.code,
  );
}

function isAuthError(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return text.includes('e170001')
    || text.includes('e215004')
    || text.includes("can't get username or password")
    || text.includes('authentication failed')
    || text.includes('authorization failed')
    || text.includes('could not authenticate');
}

/**
 * 检出远端 SVN 仓库到当前工作区或指定目录
 */
export async function checkoutSvnRepository(
  manager?: WorkspaceGitManager,
  targetDir?: string,
): Promise<void> {
  // 1. 验证系统环境是否安装了 svn
  try {
    await execCli('svn', ['--version', '--quiet'], {
      cwd: os.homedir(),
      timeout: 10_000,
    });
  } catch (err: unknown) {
    const errorString = String(err);
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' || errorString.includes('ENOENT')) {
      void vscode.window.showErrorMessage(
        t("Subversion (svn) command-line tool is not found. Please install Subversion and ensure 'svn' is available in your PATH.")
      );
      return;
    }
  }

  // 2. 提示输入 SVN 仓库 URL
  const svnUrl = await vscode.window.showInputBox({
    title: t('Checkout SVN Repository'),
    prompt: t('Enter the SVN repository URL (e.g. https://... or svn://...)'),
    placeHolder: 'https://svn.example.com/project/trunk',
    ignoreFocusOut: true,
    validateInput: (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        return t('SVN URL cannot be empty');
      }
      if (!/^(https?|svn(\+[a-z0-9]+)?|file):\/\//i.test(trimmed)) {
        return t('Invalid SVN URL protocol. Expected http://, https://, svn://, svn+ssh://, or file://');
      }
      return undefined;
    },
  });

  if (!svnUrl) return;
  const trimmedUrl = svnUrl.trim();

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
      title: t('Select Destination Folder for SVN Checkout'),
      openLabel: t('Select Destination'),
    });
    if (!selectedFolders || selectedFolders.length === 0) return undefined;
    const parentDir = selectedFolders[0].fsPath;

    // 根据 URL 末尾推导默认文件夹名
    let defaultFolderName = trimmedUrl.replace(/\/+$/, '').split('/').pop() || 'svn-project';
    if (defaultFolderName === 'trunk') {
      const parts = trimmedUrl.replace(/\/+$/, '').split('/');
      if (parts.length >= 2 && parts[parts.length - 2]) {
        defaultFolderName = parts[parts.length - 2];
      }
    }

    const folderName = await vscode.window.showInputBox({
      title: t('SVN Checkout Folder Name'),
      prompt: t('Specify the directory name for the checked out project'),
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
        t('Target directory {0} already exists and is not empty. SVN checkout requires an empty directory.', chosenDir)
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
            label: `$(folder) ${t('Checkout to current folder ({0})', workspaceFolder.name)}`,
            description: workspaceFolder.uri.fsPath,
            detail: t('Use the currently opened workspace folder as checkout destination'),
          },
          {
            id: 'browse',
            label: `$(file-directory-create) ${t('Choose another destination directory…')}`,
            detail: t('Browse for a destination folder and create a new project directory (like Git Clone)'),
          },
        ],
        {
          title: t('Select Destination Directory'),
          placeHolder: t('Select where to checkout the SVN repository'),
          ignoreFocusOut: true,
        }
      );

      if (!pick) return;

      if (pick.id === 'current') {
        const currentPath = workspaceFolder.uri.fsPath;
        if (!isDirectoryEmpty(currentPath)) {
          const proceed = await vscode.window.showWarningMessage(
            t('The current folder is not empty. SVN checkout into the current directory requires an empty folder to prevent conflicts.'),
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

  // 5. 执行 svn checkout 并处理凭据与进度
  const finalDir = checkoutDir;
  const parentDir = path.dirname(finalDir);
  const folderName = path.basename(finalDir);
  const stagingDir = !targetExistedBefore
    ? path.join(parentDir, `.${folderName}.vd-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    : path.join(finalDir, `.vd-staging-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const doCheckout = async (): Promise<boolean> => {
    return await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: t('Checking out SVN repository...'),
        cancellable: true,
      },
      async (progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => {
          abortController.abort();
        });

        if (!fs.existsSync(stagingDir)) {
          fs.mkdirSync(stagingDir, { recursive: true });
        }

        const executeCheckout = async (credentials?: { username: string; password: string }) => {
          const supportsPasswordFromStdin = credentials ? await checkSvnPasswordFromStdinSupport(stagingDir) : false;
          const args = ['checkout', '--force', trimmedUrl, '.'];
          if (credentials) {
            args.push(
              '--username', credentials.username,
              ...(supportsPasswordFromStdin ? ['--password-from-stdin'] : ['--password', credentials.password]),
              '--non-interactive',
              ...SVN_AUTH_CACHE_ARGS,
            );
          } else {
            args.push('--non-interactive');
          }

          try {
            return await execCli('svn', args, {
              cwd: stagingDir,
              timeout: 300_000,
              stdin: supportsPasswordFromStdin && credentials ? `${credentials.password}\n` : undefined,
              signal: abortController.signal,
            });
          } catch (err: unknown) {
            if (credentials && !supportsPasswordFromStdin) {
              throw redactPassword(err, credentials.password);
            }
            throw err;
          }
        };

        const cleanupStagingDir = async () => {
          if (fs.existsSync(stagingDir)) {
            try {
              await fs.promises.rm(stagingDir, { recursive: true, force: true });
            } catch {
              // 忽略清理临时目录的异常
            }
          }
        };

        let isFinalizing = false;
        const finalizeSuccess = async (): Promise<boolean> => {
          if (!targetExistedBefore) {
            isFinalizing = true;
            if (fs.existsSync(finalDir)) {
              void vscode.window.showErrorMessage(
                t('Target directory {0} was created during the operation. Staging files are kept at {1}.', finalDir, stagingDir)
              );
              return false;
            }
            try {
              await fs.promises.rename(stagingDir, finalDir);
            } catch (renameErr) {
              void vscode.window.showErrorMessage(
                t('Failed to rename staging directory to {0}: {1}. Staging files are preserved at {2}.', finalDir, (renameErr as Error)?.message || String(renameErr), stagingDir)
              );
              return false;
            }
          } else {
            isFinalizing = true;
            const remaining = fs.readdirSync(finalDir).filter(e => e !== path.basename(stagingDir) && e !== '.DS_Store' && e !== 'Thumbs.db');
            if (remaining.length > 0) {
              void vscode.window.showErrorMessage(
                t('Target directory {0} is no longer empty. Staging files are kept at {1}.', finalDir, stagingDir)
              );
              return false;
            }

            // 预先清理目标目录中遗留的系统文件（.DS_Store, Thumbs.db），避免重命名时与仓库同名文件发生碰撞
            for (const systemFile of ['.DS_Store', 'Thumbs.db']) {
              const targetSysPath = path.join(finalDir, systemFile);
              if (fs.existsSync(targetSysPath)) {
                try {
                  await fs.promises.unlink(targetSysPath);
                } catch {
                  // 忽略清理失败
                }
              }
            }

            const entries = await fs.promises.readdir(stagingDir);
            const movedEntries: string[] = [];
            try {
              for (const entry of entries) {
                await fs.promises.rename(path.join(stagingDir, entry), path.join(finalDir, entry));
                movedEntries.push(entry);
              }
              await fs.promises.rm(stagingDir, { recursive: true, force: true });
            } catch (moveErr) {
              // 逐项移动失败，执行逆向回滚：将已移入 finalDir 的条目移回 stagingDir
              for (const moved of movedEntries.reverse()) {
                try {
                  await fs.promises.rename(path.join(finalDir, moved), path.join(stagingDir, moved));
                } catch {
                  // 尽力回滚
                }
              }
              void vscode.window.showErrorMessage(
                t('Failed to finalize checkout to {0}: {1}. Staging files are preserved at {2}.', finalDir, (moveErr as Error)?.message || String(moveErr), stagingDir)
              );
              return false;
            }
          }
          return true;
        };

        try {
          progress.report({ message: trimmedUrl });
          await executeCheckout();
          return await finalizeSuccess();
        } catch (err: unknown) {
          if (token.isCancellationRequested) {
            if (!isFinalizing) await cleanupStagingDir();
            return false;
          }

          if (isAuthError(err)) {
            // 需要认证，保留 stagingDir，弹窗收集用户名与密码并重试一次
            const username = await vscode.window.showInputBox({
              title: t('SVN Authentication Required'),
              prompt: t('Please enter SVN username for {0}', trimmedUrl),
              placeHolder: t('Username'),
              ignoreFocusOut: true,
            });
            if (username === undefined) {
              await cleanupStagingDir();
              return false;
            }

            const password = await vscode.window.showInputBox({
              title: t('SVN Authentication Required'),
              prompt: t('Please enter SVN password for {0}', trimmedUrl),
              placeHolder: t('Password'),
              password: true,
              ignoreFocusOut: true,
            });
            if (password === undefined) {
              await cleanupStagingDir();
              return false;
            }

            try {
              progress.report({ message: t('Authenticating and checking out...') });
              await executeCheckout({ username, password });
              return await finalizeSuccess();
            } catch (retryErr: unknown) {
              if (!isFinalizing) await cleanupStagingDir();
              if (token.isCancellationRequested) return false;
              if (!isFinalizing) {
                void vscode.window.showErrorMessage(
                  t('SVN Checkout failed: {0}', (retryErr as Error)?.message || String(retryErr))
                );
              }
              return false;
            }
          }

          if (!isFinalizing) {
            await cleanupStagingDir();
            void vscode.window.showErrorMessage(
              t('SVN Checkout failed: {0}', (err as Error)?.message || String(err))
            );
          }
          return false;
        }
      }
    );
  };

  const success = manager
    ? await manager.runWithCheckoutSuppressed([finalDir, stagingDir], doCheckout)
    : await doCheckout();

  if (!success) {
    return;
  }

  // 6. 检出完成后续动作
  if (isNewProjectWindow) {
    const choice = await vscode.window.showInformationMessage(
      t('SVN checkout completed successfully. Would you like to open the project?'),
      t('Open in Current Window'),
      t('Open in New Window'),
    );
    if (choice === t('Open in Current Window')) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(finalDir), false);
    } else if (choice === t('Open in New Window')) {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(finalDir), true);
    }
  } else {
    void vscode.window.showInformationMessage(t('SVN repository checked out successfully.'));
    manager?.reinitializeAndRefresh();
  }
}
