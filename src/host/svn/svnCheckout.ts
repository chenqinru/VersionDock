import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { execCli } from '../vcs/cli';
import { t } from '../utils/l10n';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';

const SVN_AUTH_CACHE_ARGS = [
  '--config-option', 'servers:global:store-passwords=yes',
  '--config-option', 'servers:global:store-auth-creds=yes',
];

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

  const promptForBrowseDestination = async (): Promise<{ dir: string; isNewWindow: boolean } | undefined> => {
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
      validateInput: (val: string) => !val.trim() ? t('Folder name cannot be empty') : undefined,
    });
    if (!folderName) return undefined;

    const chosenDir = path.join(parentDir, folderName.trim());
    if (!fs.existsSync(chosenDir)) {
      try {
        fs.mkdirSync(chosenDir, { recursive: true });
      } catch (mkdirError) {
        void vscode.window.showErrorMessage(
          t('Failed to create target directory {0}: {1}', chosenDir, String(mkdirError))
        );
        return undefined;
      }
    }

    return { dir: chosenDir, isNewWindow: true };
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
        checkoutDir = workspaceFolder.uri.fsPath;
        isNewProjectWindow = false;
      } else {
        const result = await promptForBrowseDestination();
        if (!result) return;
        checkoutDir = result.dir;
        isNewProjectWindow = result.isNewWindow;
      }
    } else {
      const result = await promptForBrowseDestination();
      if (!result) return;
      checkoutDir = result.dir;
      isNewProjectWindow = result.isNewWindow;
    }
  }

  // 5. 执行 svn checkout 并处理凭据与进度
  const finalDir = checkoutDir;
  const svnExistedBefore = fs.existsSync(path.join(finalDir, '.svn'));

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

        const executeCheckout = async (credentials?: { username: string; password: string }) => {
          const args = ['checkout', '--force', trimmedUrl, '.'];
          if (credentials) {
            args.push(
              '--username', credentials.username,
              '--password', credentials.password,
              '--non-interactive',
              ...SVN_AUTH_CACHE_ARGS,
            );
          } else {
            args.push('--non-interactive');
          }

          return await execCli('svn', args, {
            cwd: finalDir,
            timeout: 300_000,
            signal: abortController.signal,
          });
        };

        try {
          progress.report({ message: trimmedUrl });
          await executeCheckout();
          return true;
        } catch (err: unknown) {
          if (token.isCancellationRequested) {
            return false;
          }

          if (isAuthError(err)) {
            // 需要认证，弹窗收集用户名与密码并重试一次
            const username = await vscode.window.showInputBox({
              title: t('SVN Authentication Required'),
              prompt: t('Please enter SVN username for {0}', trimmedUrl),
              placeHolder: t('Username'),
              ignoreFocusOut: true,
            });
            if (username === undefined) return false;

            const password = await vscode.window.showInputBox({
              title: t('SVN Authentication Required'),
              prompt: t('Please enter SVN password for {0}', trimmedUrl),
              placeHolder: t('Password'),
              password: true,
              ignoreFocusOut: true,
            });
            if (password === undefined) return false;

            try {
              progress.report({ message: t('Authenticating and checking out...') });
              await executeCheckout({ username, password });
              return true;
            } catch (retryErr: unknown) {
              if (token.isCancellationRequested) return false;
              void vscode.window.showErrorMessage(
                t('SVN Checkout failed: {0}', (retryErr as Error)?.message || String(retryErr))
              );
              return false;
            }
          }

          void vscode.window.showErrorMessage(
            t('SVN Checkout failed: {0}', (err as Error)?.message || String(err))
          );
          return false;
        }
      }
    );
  };

  const success = manager
    ? await manager.runWithCheckoutSuppressed(finalDir, doCheckout)
    : await doCheckout();

  if (!success) {
    if (!svnExistedBefore) {
      try {
        const incompleteSvn = path.join(finalDir, '.svn');
        if (fs.existsSync(incompleteSvn)) {
          fs.rmSync(incompleteSvn, { recursive: true, force: true });
        }
      } catch {
        // 忽略清理半成品 .svn 的异常
      }
    }
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
