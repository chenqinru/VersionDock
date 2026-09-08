import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getDefaultComposerPrompt } from './composerPrompts';

const WORKSPACE_PROMPT = '.vscode/ai-commit-composer.prompt.md';
const GLOBAL_PROMPT = 'ai-commit-composer.prompt.md';

export class ComposerPromptManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolve(repoRootPath: string): Promise<{ prompt: string; source: 'workspace' | 'global' | 'builtin' }> {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(repoRootPath));
    if (folder) {
      const workspacePrompt = await this.read(vscode.Uri.joinPath(folder.uri, ...WORKSPACE_PROMPT.split('/')));
      if (workspacePrompt) return { prompt: workspacePrompt, source: 'workspace' };
    }
    const globalPrompt = await this.read(vscode.Uri.joinPath(this.context.globalStorageUri, GLOBAL_PROMPT));
    return globalPrompt ? { prompt: globalPrompt, source: 'global' } : { prompt: getDefaultComposerPrompt(), source: 'builtin' };
  }

  async edit(): Promise<void> {
    const target = await this.pickTarget();
    if (!target) return;
    if (!await this.read(target)) await this.write(target, `${getDefaultComposerPrompt()}\n`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target), { preview: false });
    vscode.window.showInformationMessage(t('VersionDock: AI Commit Composer Prompt opened: {0}', target.fsPath));
  }

  async reset(): Promise<void> {
    const target = await this.pickTarget();
    if (!target) return;
    try { await vscode.workspace.fs.delete(target, { recursive: false, useTrash: false }); }
    catch (error: unknown) {
      if (!error || typeof error !== 'object' || !('code' in error) || (error as { code?: unknown }).code !== 'FileNotFound') throw error;
    }
    vscode.window.showInformationMessage(t('VersionDock: AI Commit Composer Prompt reset to the built-in default.'));
  }

  private async pickTarget(): Promise<vscode.Uri | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const choices: Array<vscode.QuickPickItem & { uri: vscode.Uri }> = folders.map(folder => ({
      label: t('Workspace AI Commit Composer Prompt'),
      description: `${folder.name}/${WORKSPACE_PROMPT}`,
      uri: vscode.Uri.joinPath(folder.uri, ...WORKSPACE_PROMPT.split('/')),
    }));
    choices.push({
      label: t('Global AI Commit Composer Prompt'),
      description: t('Applies when no workspace Composer Prompt is available'),
      uri: vscode.Uri.joinPath(this.context.globalStorageUri, GLOBAL_PROMPT),
    });
    return (await vscode.window.showQuickPick(choices, {
      title: t('Select AI Commit Composer Prompt scope'),
      placeHolder: t('Choose where to edit or reset the Composer Prompt'),
      ignoreFocusOut: true,
    }))?.uri;
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').trim() || undefined; }
    catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'FileNotFound') return undefined;
      throw error;
    }
  }

  private async write(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }
}

