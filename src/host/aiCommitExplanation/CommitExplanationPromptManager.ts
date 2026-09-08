import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getDefaultCommitExplanationPrompt } from './explanationPrompts';
import type { AiCommitExplanationPromptSource } from './types';

const WORKSPACE_PROMPT_RELATIVE_PATH = '.vscode/ai-commit-explanation.prompt.md';
const GLOBAL_PROMPT_FILENAME = 'ai-commit-explanation.prompt.md';

type PromptScope = 'workspace' | 'global';

export interface CommitExplanationPromptResolution {
  prompt: string;
  source: AiCommitExplanationPromptSource;
}

export class CommitExplanationPromptManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolve(repoRootPaths: string[]): Promise<CommitExplanationPromptResolution> {
    const workspaceFolders = this.getTargetWorkspaceFolders(repoRootPaths);
    if (workspaceFolders.length === 1) {
      const workspacePrompt = await this.readPrompt(this.getWorkspacePromptUri(workspaceFolders[0]));
      if (workspacePrompt) return { prompt: workspacePrompt, source: 'workspace' };
    }

    const globalPrompt = await this.readPrompt(this.getGlobalPromptUri());
    if (globalPrompt) return { prompt: globalPrompt, source: 'global' };
    return { prompt: getDefaultCommitExplanationPrompt(), source: 'builtin' };
  }

  async edit(): Promise<void> {
    const target = await this.pickPromptTarget();
    if (!target) return;

    const existing = await this.readPrompt(target.uri);
    if (!existing) await this.writePrompt(target.uri, `${getDefaultCommitExplanationPrompt()}\n`);

    const document = await vscode.workspace.openTextDocument(target.uri);
    await vscode.window.showTextDocument(document, { preview: false });
    vscode.window.showInformationMessage(t('VersionDock: Commit Explanation Prompt opened: {0}', target.uri.fsPath));
  }

  async reset(): Promise<void> {
    const target = await this.pickPromptTarget();
    if (!target) return;

    try {
      await vscode.workspace.fs.delete(target.uri, { recursive: false, useTrash: false });
    } catch (error: unknown) {
      if (!this.isFileNotFound(error)) throw error;
    }
    vscode.window.showInformationMessage(
      target.scope === 'workspace'
        ? t('VersionDock: Workspace Commit Explanation Prompt reset to the built-in default.')
        : t('VersionDock: Global Commit Explanation Prompt reset to the built-in default.'),
    );
  }

  private getGlobalPromptUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, GLOBAL_PROMPT_FILENAME);
  }

  private getWorkspacePromptUri(folder: vscode.WorkspaceFolder): vscode.Uri {
    return vscode.Uri.joinPath(folder.uri, ...WORKSPACE_PROMPT_RELATIVE_PATH.split('/'));
  }

  private getTargetWorkspaceFolders(repoRootPaths: string[]): vscode.WorkspaceFolder[] {
    const folders = new Map<string, vscode.WorkspaceFolder>();
    for (const repoRootPath of repoRootPaths) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(repoRootPath));
      if (folder) folders.set(folder.uri.toString(), folder);
    }
    return Array.from(folders.values());
  }

  private async pickPromptTarget(): Promise<{ scope: PromptScope; uri: vscode.Uri } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const choices: Array<vscode.QuickPickItem & { scope: PromptScope }> = [];
    if (folders.length > 0) {
      choices.push({
        label: t('Workspace Commit Explanation Prompt'),
        description: WORKSPACE_PROMPT_RELATIVE_PATH,
        scope: 'workspace',
      });
    }
    choices.push({
      label: t('Global Commit Explanation Prompt'),
      description: t('Applies when no single workspace Commit Explanation Prompt is available'),
      scope: 'global',
    });

    const picked = await vscode.window.showQuickPick(choices, {
      title: t('Select Commit Explanation Prompt scope'),
      placeHolder: t('Choose where to edit or reset the Commit Explanation Prompt'),
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.scope === 'global') return { scope: 'global', uri: this.getGlobalPromptUri() };

    const folder = await this.pickWorkspaceFolder(folders);
    return folder ? { scope: 'workspace', uri: this.getWorkspacePromptUri(folder) } : undefined;
  }

  private async pickWorkspaceFolder(folders: readonly vscode.WorkspaceFolder[]): Promise<vscode.WorkspaceFolder | undefined> {
    if (folders.length === 1) return folders[0];

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
    if (activeFolder) return activeFolder;

    const picked = await vscode.window.showQuickPick(
      folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      {
        title: t('Select workspace for Commit Explanation Prompt'),
        placeHolder: t('Choose a workspace folder'),
        ignoreFocusOut: true,
      },
    );
    return picked?.folder;
  }

  private async readPrompt(uri: vscode.Uri): Promise<string | undefined> {
    try {
      const content = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').trim();
      return content || undefined;
    } catch (error: unknown) {
      if (this.isFileNotFound(error)) return undefined;
      throw error;
    }
  }

  private async writePrompt(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  private isFileNotFound(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error
      && (error as { code?: unknown }).code === 'FileNotFound';
  }
}
