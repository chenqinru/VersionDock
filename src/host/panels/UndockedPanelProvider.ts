import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { t } from '../utils/l10n';
import type { CommitToHostMsg, HostToCommitMsg, HostToLogMsg, LogToHostMsg } from '../types/messages';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';

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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commitPanel: CommitPanelProvider,
    private readonly logPanel: GitLogPanelProvider,
  ) {}

  open(target: 'editorTab' | 'newWindow', showCommit = true): void {
    if (this.panel) {
      this.panel.reveal();
      if (this.currentShowCommit !== showCommit) {
        this.currentShowCommit = showCommit;
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

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.movedToNewWindow = false;
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
    this.panel?.webview.postMessage({ target: 'commit', msg } satisfies HostToUndockedMsg);
  }

  postToLog(msg: HostToLogMsg): void {
    this.panel?.webview.postMessage({ target: 'log', msg } satisfies HostToUndockedMsg);
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(disposable => disposable.dispose());
  }
}
