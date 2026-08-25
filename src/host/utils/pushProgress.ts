import * as vscode from 'vscode';

type RemoteAwareRepository = {
  getRemotes(): Promise<string[]>;
};

/**
 * Keep the progress notification away from the interactive publish flow.
 * Providers may open QuickPick/InputBox controls when a repository has no
 * remote, so a notification must only wrap an ordinary push with a known
 * remote.
 */
export async function withGitPushProgress<T>(
  repository: RemoteAwareRepository,
  title: string,
  operation: () => Promise<T>,
): Promise<T> {
  const remotes = await repository.getRemotes().catch(() => [] as string[]);
  if (remotes.length === 0) return operation();
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    operation,
  );
}
