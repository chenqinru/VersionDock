import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { t } from '../utils/l10n';
import type { CommitToHostMsg, HostToCommitMsg, HostToLogMsg, LogToHostMsg } from '../types/messages';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';
import { loadIconTheme } from '../utils/IconThemeService';
import type { VersionDockLogger } from '../utils/Logger';

type UndockedToHostMsg = CommitToHostMsg | LogToHostMsg;

type HostToUndockedMsg =
  | { target: 'commit'; msg: HostToCommitMsg }
  | { target: 'log'; msg: HostToLogMsg };

function isLogMsg(msg: UndockedToHostMsg): msg is LogToHostMsg {
  return msg.type.startsWith('LOG_');
}

export class UndockedPanelProvider implements vscode.Disposable {
  public static readonly viewType = 'versiondock.undocked';

  private panel: vscode.WebviewPanel | null = null;
  private disposables: vscode.Disposable[] = [];
  private currentShowCommit = true;
  private movedToNewWindow = false;
  private iconThemeGeneration = 0;
  private iconThemeLoaded = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commitPanel: CommitPanelProvider,
    private readonly logPanel: GitLogPanelProvider,
    private readonly logger: VersionDockLogger,
  ) {}

  hasCommitPane(): boolean {
    return this.panel !== null && this.currentShowCommit;
  }

  open(target: 'editorTab' | 'newWindow', showCommit = true): void {
    if (this.panel) {
      this.panel.reveal();
      if (this.currentShowCommit !== showCommit) {
        this.currentShowCommit = showCommit;
        this.iconThemeGeneration++;
        this.iconThemeLoaded = false;
        this.panel.webview.html = getWebviewHtml(
          this.panel.webview,
          this.extensionUri,
          'undockedPanel',
          'VersionDock',
          { showCommit },
        );
      }
      if (target === 'newWindow' && !this.movedToNewWindow) {
        this.movedToNewWindow = true;
        vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
      }
      return;
    }

    this.currentShowCommit = showCommit;
    this.iconThemeGeneration++;
    this.iconThemeLoaded = false;
    this.panel = vscode.window.createWebviewPanel(
      UndockedPanelProvider.viewType,
      'VersionDock',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(vscode.env.appRoot),
          ...vscode.extensions.all.map(extension => vscode.Uri.file(extension.extensionPath)),
        ],
      },
    );

    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      this.extensionUri,
      'undockedPanel',
      'VersionDock',
      { showCommit },
    );

    this.panel.webview.onDidReceiveMessage((msg: UndockedToHostMsg) => {
      if (isLogMsg(msg)) {
        if (msg.type === 'LOG_UNDOCK') return;
        this.logPanel.handleUndockedMessage(msg, this);
      } else {
        this.commitPanel.handleUndockedMessage(msg, this);
      }
    }, null, this.disposables);

    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('workbench.iconTheme') || event.affectsConfiguration('workbench.colorTheme')) {
        this.refreshIconTheme(true);
      }
    }, null, this.disposables);

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.movedToNewWindow = false;
      this.iconThemeGeneration++;
      this.iconThemeLoaded = false;
      this.disposables.forEach(disposable => disposable.dispose());
      this.disposables = [];
    }, null, this.disposables);

    if (target === 'newWindow') {
      this.movedToNewWindow = true;
      vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow').then(undefined, () => {});
    }
  }

  async pickAndOpen(): Promise<void> {
    type Item = vscode.QuickPickItem & { value: 'editorTab' | 'newWindow'; showCommit: boolean };
    const pick = await vscode.window.showQuickPick<Item>(
      [
        { label: `$(editor-layout) ${t('Undock in Editor Tab (Log & Commit)')}`, value: 'editorTab', showCommit: true },
        { label: `$(empty-window) ${t('Undock in New Window (Log & Commit)')}`, value: 'newWindow', showCommit: true },
        { label: `$(editor-layout) ${t('Undock in Editor Tab (Only Log)')}`, value: 'editorTab', showCommit: false },
        { label: `$(empty-window) ${t('Undock in New Window (Only Log)')}`, value: 'newWindow', showCommit: false },
      ],
      { title: t('VersionDock: Undock'), placeHolder: t('Choose where to open the panel') },
    );
    if (pick) this.open(pick.value, pick.showCommit);
  }

  postToCommit(msg: HostToCommitMsg): void {
    const panel = this.panel;
    if (!panel) return;
    if (msg.type === 'COMMIT_STATUS_UPDATE') {
      const forceThemeRefresh = msg.iconTheme !== undefined;
      const status: HostToCommitMsg = { ...msg, iconTheme: undefined };
      panel.webview.postMessage({ target: 'commit', msg: status } satisfies HostToUndockedMsg);
      this.refreshIconTheme(forceThemeRefresh);
      return;
    }
    panel.webview.postMessage({ target: 'commit', msg } satisfies HostToUndockedMsg);
  }

  postToLog(msg: HostToLogMsg): void {
    const panel = this.panel;
    if (!panel) return;
    if (msg.type === 'LOG_INIT_DATA') {
      const forceThemeRefresh = msg.iconTheme !== undefined;
      const initData: HostToLogMsg = { ...msg, iconTheme: undefined };
      panel.webview.postMessage({ target: 'log', msg: initData } satisfies HostToUndockedMsg);
      this.refreshIconTheme(forceThemeRefresh);
      return;
    }
    if (msg.type === 'LOG_ICON_THEME_UPDATE') {
      this.refreshIconTheme(true);
      return;
    }
    panel.webview.postMessage({ target: 'log', msg } satisfies HostToUndockedMsg);
  }

  private refreshIconTheme(force = false): void {
    const panel = this.panel;
    if (!panel || (this.iconThemeLoaded && !force)) return;
    const generation = ++this.iconThemeGeneration;
    void loadIconTheme(panel.webview).then(iconTheme => {
      if (this.panel !== panel || generation !== this.iconThemeGeneration) return;
      this.iconThemeLoaded = true;
      panel.webview.postMessage({
        target: 'commit',
        msg: { type: 'COMMIT_ICON_THEME_UPDATE', iconTheme },
      } satisfies HostToUndockedMsg);
      panel.webview.postMessage({
        target: 'log',
        msg: { type: 'LOG_ICON_THEME_UPDATE', iconTheme },
      } satisfies HostToUndockedMsg);
    }).catch(error => {
      this.logger.error('UndockedPanel', 'Failed to load icon theme', error);
    });
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
  }
}
