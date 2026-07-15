import * as vscode from 'vscode';

export function toWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  ...pathSegments: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathSegments));
}

export function toGitUri(filePath: string, ref: string): vscode.Uri {
  const fileUri = vscode.Uri.file(filePath);
  // Preserve the file URI path so Windows drive letters remain valid URI paths (/C:/...).
  return fileUri.with({
    scheme: 'git',
    query: JSON.stringify({ path: fileUri.fsPath, ref }),
  });
}
