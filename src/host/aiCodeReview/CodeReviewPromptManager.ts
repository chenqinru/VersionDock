import * as path from 'path';
import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getDefaultCodeReviewPrompt } from './reviewPrompts';
import type { CodeReviewPromptSource } from './types';

const WORKSPACE_PROMPT = '.vscode/ai-code-review.prompt.md';
const GLOBAL_PROMPT = 'ai-code-review.prompt.md';
type PromptScope = 'workspace' | 'global';

export class CodeReviewPromptManager {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolve(repoRootPaths: string[]): Promise<{ prompt: string; source: CodeReviewPromptSource }> {
    const folders = new Map<string, vscode.WorkspaceFolder>();
    for (const rootPath of repoRootPaths) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(rootPath));
      if (folder) folders.set(folder.uri.toString(), folder);
    }
    if (folders.size === 1) {
      const folder = Array.from(folders.values())[0];
      const prompt = await this.read(vscode.Uri.joinPath(folder.uri, ...WORKSPACE_PROMPT.split('/')));
      if (prompt) return { prompt, source: 'workspace' };
    }
    const global = await this.read(this.globalUri());
    return global ? { prompt: global, source: 'global' } : { prompt: getDefaultCodeReviewPrompt(), source: 'builtin' };
  }

  async edit(): Promise<void> {
    const target = await this.pickTarget();
    if (!target) return;
    if (!await this.read(target.uri)) await this.write(target.uri, `${getDefaultCodeReviewPrompt()}\n`);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target.uri), { preview: false });
    vscode.window.showInformationMessage(t('AI Code Review Prompt opened: {0}', target.uri.fsPath));
  }

  async reset(): Promise<void> {
    const target = await this.pickTarget();
    if (!target) return;
    try { await vscode.workspace.fs.delete(target.uri, { recursive: false, useTrash: false }); }
    catch (error: unknown) {
      if (!this.isMissing(error)) throw error;
    }
    vscode.window.showInformationMessage(t('AI Code Review Prompt reset to the built-in default.'));
  }

  private globalUri(): vscode.Uri { return vscode.Uri.joinPath(this.context.globalStorageUri, GLOBAL_PROMPT); }

  private async pickTarget(): Promise<{ scope: PromptScope; uri: vscode.Uri } | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const choices: Array<vscode.QuickPickItem & { scope: PromptScope; uri: vscode.Uri }> = folders.map(folder => ({
      label: t('Workspace AI Code Review Prompt'),
      description: `${folder.name}/${WORKSPACE_PROMPT}`,
      scope: 'workspace',
      uri: vscode.Uri.joinPath(folder.uri, ...WORKSPACE_PROMPT.split('/')),
    }));
    choices.push({
      label: t('Global AI Code Review Prompt'),
      description: t('Applies when no single workspace review prompt is available'),
      scope: 'global',
      uri: this.globalUri(),
    });
    return vscode.window.showQuickPick(choices, {
      title: t('Select AI Code Review Prompt scope'),
      placeHolder: t('Choose where to edit or reset the Code Review Prompt'),
      ignoreFocusOut: true,
    });
  }

  private async read(uri: vscode.Uri): Promise<string | undefined> {
    try { return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').trim() || undefined; }
    catch (error: unknown) { if (this.isMissing(error)) return undefined; throw error; }
  }

  private async write(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  }

  private isMissing(error: unknown): boolean {
    return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'FileNotFound';
  }
}
