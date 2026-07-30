import * as vscode from 'vscode';
import * as path from 'path';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { parseConflictFile, hasConflictMarkers } from '../git/ConflictParser';
import type { MergeToHostMsg, HostToMergeMsg } from '../types/messages';
import type { MergeConflictFile, MergeFileVersions } from '../types/git';
import { t } from '../utils/l10n';
import { loadIconTheme } from '../utils/IconThemeService';
import { scopedKey } from '../utils/scopedKey';

interface ResolvedMergeFileContext {
  repoId: string;
  relativePath: string;
  absolutePath: string;
}

interface InitialMergeFileResult {
  file: MergeConflictFile;
  versionsError?: string;
}

export class MergeEditorProvider implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager
  ) {}

  openForFile(filePath: string, repoId?: string, relativePath?: string): void {
    void this.openForFileResolved(filePath, repoId, relativePath).catch(error => {
      vscode.window.showErrorMessage(t('VersionDock: {0}', error instanceof Error ? error.message : String(error)));
    });
  }

  private async openForFileResolved(filePath: string, repoId?: string, relativePath?: string): Promise<void> {
    const resolved = await this.resolveFileContext(filePath, repoId, relativePath);
    if (!resolved) {
      return;
    }

    const panelKey = scopedKey(resolved.repoId, resolved.relativePath);
    if (this.panels.has(panelKey)) {
      this.panels.get(panelKey)!.reveal();
      return;
    }

    const fileName = path.basename(resolved.absolutePath);
    const panel = vscode.window.createWebviewPanel(
      'versiondock.mergeEditor',
      t('Merge: {0}', fileName),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(vscode.env.appRoot),
          ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
        ],
      }
    );

    // Start loading immediately, but only deliver the result after the webview
    // has installed its message listener and explicitly announced readiness.
    const initialFilePromise = this.loadInitialFile(resolved);
    const postInitialFile = async () => {
      try {
        const result = await initialFilePromise;
        const iconTheme = await loadIconTheme(panel.webview).catch(() => undefined);
        await panel.webview.postMessage({
          type: 'MERGE_FILE_LOADED',
          file: result.file,
          iconTheme,
        } satisfies HostToMergeMsg);
        if (result.versionsError) {
          await panel.webview.postMessage({
            type: 'MERGE_FILE_VERSIONS_LOADED',
            requestId: 'initial',
            error: result.versionsError,
          } satisfies HostToMergeMsg);
        }
      } catch (error) {
        await panel.webview.postMessage({
          type: 'MERGE_FILE_LOAD_FAILED',
          error: error instanceof Error ? error.message : String(error),
        } satisfies HostToMergeMsg);
      }
    };

    panel.webview.onDidReceiveMessage((msg: MergeToHostMsg) => {
      if (msg.type === 'MERGE_READY') {
        void postInitialFile();
        return;
      }
      void this.handleMessage(msg, resolved.repoId, resolved.relativePath, resolved.absolutePath, panelKey, panel.webview);
    });

    panel.onDidDispose(() => this.panels.delete(panelKey));
    this.panels.set(panelKey, panel);

    // Register the host listener before assigning HTML so a very fast webview
    // cannot send MERGE_READY before the extension is listening.
    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      'mergeEditor',
      t('Merge: {0}', fileName)
    );
  }

  private async resolveFileContext(filePath: string, repoId?: string, relativePath?: string): Promise<ResolvedMergeFileContext | undefined> {
    if (repoId) {
      const repo = this.manager.getRepo(repoId);
      if (!repo) return undefined;
      const candidatePath = relativePath ?? path.relative(repo.rootPath, filePath);
      const resolvedPath = repo.resolveRepoPath(candidatePath);
      return { repoId, relativePath: resolvedPath.relativePath, absolutePath: resolvedPath.absolutePath };
    }

    const service = await this.manager.resolveServiceForFile(filePath, 'prompt', {
      title: t('Select Git or SVN Repository'),
      placeHolder: t('Select which repository to use for this conflict file…'),
      notFoundMessage: t('VersionDock: File is not inside a known Git or SVN repository'),
    });
    if (!service) return undefined;
    const resolvedPath = service.resolveRepoPath(path.relative(service.rootPath, filePath));
    return {
      repoId: service.repoId,
      relativePath: resolvedPath.relativePath,
      absolutePath: resolvedPath.absolutePath,
    };
  }

  private async loadVersions(repoId: string, relativePath: string) {
    const repo = this.manager.getRepo(repoId);
    if (!repo) throw new Error(t('Repo not found'));
    return repo.getFileVersions(relativePath);
  }

  private async loadInitialFile(resolved: ResolvedMergeFileContext): Promise<InitialMergeFileResult> {
    const conflictFile = parseConflictFile(resolved.absolutePath, resolved.repoId, resolved.relativePath);
    if (conflictFile) {
      try {
        const versions = await this.loadVersions(resolved.repoId, resolved.relativePath);
        return {
          file: {
            ...conflictFile,
            baseContent: versions.base,
            oursContent: versions.ours,
            theirsContent: versions.theirs,
            language: versions.language,
          },
        };
      } catch (error) {
        return {
          file: conflictFile,
          versionsError: error instanceof Error ? error.message : String(error),
        };
      }
    }

    try {
      const [versions, sideStatus] = await Promise.all([
        this.loadVersions(resolved.repoId, resolved.relativePath),
        this.loadConflictSideStatus(resolved.repoId, resolved.relativePath),
      ]);
      return { file: this.buildSyntheticConflictFile(resolved, versions, sideStatus) };
    } catch (error) {
      const fileName = path.basename(resolved.absolutePath);
      const noMarkersMessage = t('VersionDock: No conflict markers found in {0}', fileName);
      throw new Error(`${noMarkersMessage}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadConflictSideStatus(repoId: string, relativePath: string) {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return undefined;
    const statuses = await repo.getConflictFileStatuses().catch(() => undefined);
    return statuses?.get(relativePath);
  }

  private buildSyntheticConflictFile(
    resolved: ResolvedMergeFileContext,
    versions: MergeFileVersions,
    sideStatus?: { currentStatus: MergeConflictFile['oursStatus']; incomingStatus: MergeConflictFile['theirsStatus'] },
  ): MergeConflictFile {
    const oursLines = this.contentToLines(versions.ours);
    const baseLines = this.contentToLines(versions.base);
    const theirsLines = this.contentToLines(versions.theirs);
    const markerContent = this.buildSyntheticMarkerContent(oursLines, baseLines, theirsLines);
    const markerLineCount = this.contentToLines(markerContent).length;

    return {
      absolutePath: resolved.absolutePath,
      relativePath: resolved.relativePath,
      repoId: resolved.repoId,
      conflicts: [{
        index: 0,
        oursLabel: 'OURS',
        theirsLabel: 'THEIRS',
        oursLines,
        baseLines,
        theirsLines,
        startLine: 0,
        endLine: Math.max(0, markerLineCount - 1),
      }],
      oursLabel: 'OURS',
      theirsLabel: 'THEIRS',
      content: markerContent,
      oursStatus: sideStatus?.currentStatus,
      theirsStatus: sideStatus?.incomingStatus,
      baseContent: versions.base,
      oursContent: versions.ours,
      theirsContent: versions.theirs,
      language: versions.language,
    };
  }

  private contentToLines(content: string): string[] {
    return content === '' ? [] : content.split('\n');
  }

  private buildSyntheticMarkerContent(oursLines: string[], baseLines: string[], theirsLines: string[]): string {
    const lines = ['<<<<<<< OURS', ...oursLines];
    if (baseLines.length > 0) lines.push('||||||| base', ...baseLines);
    lines.push('=======', ...theirsLines, '>>>>>>> THEIRS');
    return lines.join('\n');
  }

  private async refreshCommitPanel(): Promise<void> {
    await vscode.commands.executeCommand('versiondock.refreshCommitPanel');
  }

  private closePanel(panelKey: string): void {
    this.panels.get(panelKey)?.dispose();
  }

  private async handleMessage(msg: MergeToHostMsg, repoId: string, relativePath: string, absolutePath: string, panelKey: string, webview: vscode.Webview): Promise<void> {
    const post = (m: HostToMergeMsg) => webview.postMessage(m);

    switch (msg.type) {
      case 'MERGE_REQUEST_FILE_VERSIONS': {
        try {
          const versions = await this.loadVersions(repoId, relativePath);
          post({ type: 'MERGE_FILE_VERSIONS_LOADED', requestId: msg.requestId, versions });
        } catch (e: unknown) {
          post({ type: 'MERGE_FILE_VERSIONS_LOADED', requestId: msg.requestId, error: String(e) });
        }
        break;
      }

      case 'MERGE_SAVE_FILE': {
        try {
          const repo = this.manager.getRepo(repoId);
          if (!repo) throw new Error(t('Repo not found'));
          if (msg.deleteFile) await repo.deleteMergedFile(relativePath);
          else await repo.saveMergedContent(relativePath, msg.resolvedContent);
          await repo.stageFiles([relativePath]);
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: true });
          vscode.window.showInformationMessage(t('VersionDock: File resolved and staged: {0}', path.basename(relativePath)));
          await this.refreshCommitPanel();
          vscode.commands.executeCommand('versiondock.commitPanel.focus');
          this.closePanel(panelKey);
        } catch (e: unknown) {
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'MERGE_ACCEPT_OURS':
      case 'MERGE_ACCEPT_THEIRS': {
        try {
          const repo = this.manager.getRepo(repoId);
          if (!repo) throw new Error(t('Repo not found'));
          if (msg.type === 'MERGE_ACCEPT_OURS') await repo.acceptOurs(relativePath);
          else await repo.acceptTheirs(relativePath);
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: true });
          await this.refreshCommitPanel();
          vscode.commands.executeCommand('versiondock.commitPanel.focus');
          this.closePanel(panelKey);
        } catch (e: unknown) {
          post({ type: 'MERGE_SAVE_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'MERGE_OPEN_FILE': {
        const uri = vscode.Uri.file(absolutePath);
        await vscode.window.showTextDocument(uri, { viewColumn: vscode.ViewColumn.Beside });
        break;
      }

      case 'MERGE_CLOSE': {
        this.closePanel(panelKey);
        break;
      }
    }
  }

  openCurrentEditorFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage(t('VersionDock: No active file'));
      return;
    }
    const filePath = editor.document.uri.fsPath;
    const content = editor.document.getText();
    if (!hasConflictMarkers(content)) {
      vscode.window.showWarningMessage(t('VersionDock: No conflict markers found in the current file'));
      return;
    }
    this.openForFile(filePath);
  }

  dispose(): void {
    this.panels.forEach(p => p.dispose());
    this.panels.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
