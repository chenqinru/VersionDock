import * as vscode from 'vscode';
import * as path from 'path';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { getWebviewHtml } from '../utils/webviewHtml';
import { loadIconTheme } from '../utils/IconThemeService';
import type { ConflictsToHostMsg, ConflictListFile, HostToConflictsMsg } from '../types/messages';
import type { MergeEditorProvider } from './MergeEditorProvider';
import { t } from '../utils/l10n';

export class ConflictsPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly mergeEditorProvider: MergeEditorProvider,
  ) {}

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      void this.refresh();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'versiondock.conflicts',
      t('Conflicts'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(vscode.env.appRoot),
          ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
        ],
      },
    );

    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'conflicts', t('Conflicts'));
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
        void this.refresh();
      }
    });
    panel.webview.onDidReceiveMessage((msg: ConflictsToHostMsg) => this.handleMessage(msg));
    panel.onDidDispose(() => {
      configWatcher.dispose();
      this.panel = undefined;
    });
    this.panel = panel;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    const [status, states, iconTheme] = await Promise.all([
      this.manager.getAllStatusesFresh(),
      Promise.all(this.manager.getRepoMetas().map(async meta => {
        const repo = this.manager.getRepo(meta.id);
        return repo ? repo.getMergeRebaseState().catch(() => null) : null;
      })),
      loadIconTheme(this.panel.webview).catch(() => undefined),
    ]);
    const metaMap = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const files: ConflictListFile[] = [];
    for (const repoStatus of status.repos) {
      const meta = metaMap.get(repoStatus.repoId);
      const repo = this.manager.getRepo(repoStatus.repoId);
      const conflictStatuses = await repo?.getConflictFileStatuses().catch(() => new Map()) ?? new Map();
      const seen = new Set<string>();
      for (const file of [...repoStatus.unstagedFiles, ...repoStatus.stagedFiles]) {
        if (file.status !== 'conflicted' || seen.has(file.path)) continue;
        seen.add(file.path);
        const sideStatus = conflictStatuses.get(file.path) ?? { currentStatus: 'modified' as const, incomingStatus: 'modified' as const };
        files.push({
          repoId: repoStatus.repoId,
          repoName: meta?.name ?? path.basename(repoStatus.repoId),
          repoColor: meta?.color ?? '#4ec9b0',
          path: file.path,
          absolutePath: file.absolutePath,
          currentStatus: sideStatus.currentStatus,
          incomingStatus: sideStatus.incomingStatus,
        });
      }
    }

    this.post({
      type: 'CONFLICTS_DATA',
      files,
      isMerging: states.some(Boolean),
      operationLabel: states.some(state => state === 'rebase') ? t('Rebase in progress') : t('Merge in progress'),
      iconTheme,
    });
  }

  private post(msg: HostToConflictsMsg): void {
    this.panel?.webview.postMessage(msg);
  }

  private async handleMessage(msg: ConflictsToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'CONFLICTS_REQUEST_DATA':
        await this.refresh();
        break;
      case 'CONFLICTS_OPEN_MERGE_EDITOR': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        this.mergeEditorProvider.openForFile(resolvedPath.absolutePath, msg.repoId, resolvedPath.relativePath);
        break;
      }
      case 'CONFLICTS_ACCEPT_OURS':
      case 'CONFLICTS_ACCEPT_THEIRS': {
        try {
          for (const file of msg.files) {
            const repo = this.manager.getRepo(file.repoId);
            if (!repo) throw new Error(t('Repo not found'));
            const relativePath = repo.resolveRepoPath(file.path).relativePath;
            if (msg.type === 'CONFLICTS_ACCEPT_OURS') await repo.acceptOurs(relativePath);
            else await repo.acceptTheirs(relativePath);
          }
          this.post({ type: 'CONFLICTS_OP_RESULT', requestId: msg.requestId, ok: true });
          await this.refresh();
          await vscode.commands.executeCommand('versiondock.refreshCommitPanel');
        } catch (e: unknown) {
          this.post({ type: 'CONFLICTS_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
