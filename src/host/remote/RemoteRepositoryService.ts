import * as path from 'path';
import * as vscode from 'vscode';
import type { API, RemoteSource, RemoteSourcePublisher, RemoteSourceProvider } from '../git/git.d';
import { createGitClient, withGitWriteLock } from '../git/GitOperationLock';
import { getVscodeGitApi, getVscodeRepository } from '../git/VscodeGitApi';
import type { VersionDockLogger } from '../utils/Logger';
import { GitHubRemoteProvider } from './GitHubRemoteProvider';
import { GitLabRemoteProvider } from './GitLabRemoteProvider';
import { RemoteApiError } from './api';
import { RemoteRepositoryCancelledError } from './types';
import type {
  CreateRepositoryInput,
  RemoteNamespace,
  RemoteProviderKind,
  RemoteRepositoryProvider,
  PublishMissingRemote,
  RemoteVisibility,
} from './types';

function providerIcon(kind: RemoteProviderKind): string {
  return kind === 'github' ? 'github' : 'repo';
}

function visibilityOptions(kind: RemoteProviderKind): Array<{ label: string; value: RemoteVisibility; description: string }> {
  if (kind === 'github') {
    return [
      { label: `$(lock) ${vscode.l10n.t('Private')}`, value: 'private', description: vscode.l10n.t('Only people with access can view this repository.') },
      { label: `$(globe) ${vscode.l10n.t('Public')}`, value: 'public', description: vscode.l10n.t('Anyone on the internet can view this repository.') },
    ];
  }
  return [
    { label: `$(lock) ${vscode.l10n.t('Private')}`, value: 'private', description: vscode.l10n.t('Only members with access can view this project.') },
    { label: `$(organization) ${vscode.l10n.t('Internal')}`, value: 'internal', description: vscode.l10n.t('Only authenticated users of this GitLab instance can view this project.') },
    { label: `$(globe) ${vscode.l10n.t('Public')}`, value: 'public', description: vscode.l10n.t('Anyone on the internet can view this project.') },
  ];
}

export class RemoteRepositoryService implements vscode.Disposable {
  readonly github: GitHubRemoteProvider;
  readonly gitlab: GitLabRemoteProvider;
  private readonly providers: RemoteRepositoryProvider[];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly apiDisposables: vscode.Disposable[] = [];
  private registeredApi: API | undefined;
  private apiStateListener: vscode.Disposable | undefined;
  private publishTails = new Map<string, Promise<void>>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {
    this.github = new GitHubRemoteProvider(logger);
    this.gitlab = new GitLabRemoteProvider(context, logger);
    this.providers = [this.github, this.gitlab];
    this.disposables.push(vscode.extensions.onDidChange(() => this.tryRegisterGitApi()));
    this.tryRegisterGitApi();
  }

  get publishMissingRemote(): PublishMissingRemote {
    return (repoId, rootPath) => this.publishRepository(repoId, rootPath);
  }

  async manageAccounts(): Promise<void> {
    type AccountAction = vscode.QuickPickItem & { action: 'github' | 'gitlab' };
    const items: AccountAction[] = [
      {
        label: `$(github) ${vscode.l10n.t('Sign in to GitHub')}`,
        description: vscode.l10n.t('Use the VS Code GitHub authentication provider'),
        action: 'github',
      },
      {
        label: `$(repo) ${vscode.l10n.t('Manage GitLab accounts')}`,
        description: vscode.l10n.t('Add, re-authenticate, or remove GitLab Personal Access Tokens'),
        action: 'gitlab',
      },
    ];
    const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('VersionDock — Remote Accounts') });
    if (!selected) return;
    if (selected.action === 'gitlab') {
      await this.gitlab.manageAccounts();
      return;
    }
    try {
      await this.github.authenticate();
      vscode.window.showInformationMessage(vscode.l10n.t('GitHub account is connected through VS Code.'));
    } catch (error) {
      this.showRemoteError('GitHub', error);
    }
  }

  async publishRepository(repoId: string, rootPath: string, preferredKind?: RemoteProviderKind, pushAfterCreate = false): Promise<void> {
    const key = path.resolve(rootPath);
    const previous = this.publishTails.get(key);
    // Serialize publish flows per repository, but do not hold the Git write
    // lock while the user is choosing a provider/namespace or while a remote
    // API request is in flight. The lock is reacquired around the short Git
    // read/write sections below.
    const current = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => this.publishRepositoryFlow(
      repoId,
      rootPath,
      preferredKind,
      pushAfterCreate,
    ));
    this.publishTails.set(key, current);
    try {
      await current;
    } finally {
      if (this.publishTails.get(key) === current) this.publishTails.delete(key);
    }
  }

  dispose(): void {
    this.apiStateListener?.dispose();
    this.apiStateListener = undefined;
    this.apiDisposables.splice(0).forEach(disposable => disposable.dispose());
    this.disposables.splice(0).forEach(disposable => disposable.dispose());
  }

  private tryRegisterGitApi(): void {
    const api = getVscodeGitApi();
    if (!api) return;
    if (this.registeredApi === api && this.apiDisposables.length > 0) return;
    this.registeredApi = api;
    if (api.state !== 'initialized') {
      if (!this.apiStateListener) {
        this.apiStateListener = api.onDidChangeState(state => {
          if (state === 'initialized') this.tryRegisterGitApi();
        });
      }
      return;
    }
    this.apiStateListener?.dispose();
    this.apiStateListener = undefined;
    this.apiDisposables.splice(0).forEach(disposable => disposable.dispose());

    for (const provider of this.providers) {
      const sourceProvider: RemoteSourceProvider = {
        name: provider.name,
        icon: providerIcon(provider.kind),
        supportsQuery: true,
        getRemoteSources: query => this.getRemoteSources(provider, query),
        getBranches: url => provider.getBranches(url),
      };
      this.apiDisposables.push(
        api.registerRemoteSourceProvider(sourceProvider),
        this.makePublisher(provider, api),
      );
    }
    this.apiDisposables.push(api.registerCredentialsProvider({
      getCredentials: host => this.getCredentials(host),
    }));
    this.logger.info('Remote', 'Registered GitHub and GitLab providers with VS Code Git API');
  }

  private makePublisher(provider: RemoteRepositoryProvider, api: API): vscode.Disposable {
    const publisher: RemoteSourcePublisher = {
      name: `VersionDock ${provider.name}`,
      icon: providerIcon(provider.kind),
      publishRepository: repository => this.publishRepository(repository.rootUri.fsPath, repository.rootUri.fsPath, provider.kind, true),
    };
    return api.registerRemoteSourcePublisher(publisher);
  }

  private async getRemoteSources(provider: RemoteRepositoryProvider, query?: string): Promise<RemoteSource[]> {
    try {
      const repositories = await provider.listRepositories(query);
      return repositories.map(repository => ({
        name: repository.fullName,
        description: `${provider.name} · ${repository.host}${repository.defaultBranch ? ` · ${repository.defaultBranch}` : ''}`,
        url: repository.cloneUrl,
      }));
    } catch (error) {
      this.showRemoteError(provider.name, error);
      return [];
    }
  }

  private async getCredentials(host: vscode.Uri): Promise<{ username: string; password: string } | undefined> {
    for (const provider of this.providers) {
      try {
        const credentials = await provider.getCredentials(host);
        if (credentials) return credentials;
      } catch (error) {
        this.logger.debug('Remote', 'Credentials provider could not resolve a token', { host: host.authority, provider: provider.kind, error: String(error) });
      }
    }
    return undefined;
  }

  private async publishRepositoryFlow(repoId: string, rootPath: string, preferredKind?: RemoteProviderKind, pushAfterCreate = false): Promise<void> {
    if (!(await this.getPublishState(rootPath))) return;

    const provider = await this.chooseProvider(preferredKind);
    const namespaces = await provider.listNamespaces();
    const namespace = await this.chooseNamespace(provider, namespaces);
    const name = await vscode.window.showInputBox({
      title: vscode.l10n.t('Create {0} repository', provider.name),
      prompt: vscode.l10n.t('Repository name'),
      value: path.basename(rootPath),
      validateInput: value => {
        const trimmed = value.trim();
        if (!trimmed) return vscode.l10n.t('Repository name cannot be empty.');
        if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return vscode.l10n.t('Repository name can contain only letters, numbers, dots, underscores, and hyphens.');
        return undefined;
      },
    });
    if (!name?.trim()) throw new RemoteRepositoryCancelledError(vscode.l10n.t('Remote repository creation cancelled.'));

    const visibility = await this.chooseVisibility(provider.kind);
    const input: CreateRepositoryInput = { name: name.trim(), visibility, namespace };

    // The user may have configured a remote or changed the repository state
    // while the prompts were open. Re-check immediately before creating the
    // remote project so the common concurrent case does not create a second
    // repository.
    if (!(await this.getPublishState(rootPath))) return;
    const created = await provider.createRepository(input);

    await withGitWriteLock(rootPath, async () => {
      const git = createGitClient(rootPath);
      const after = await git.getRemotes(false);
      if (after.length > 0) {
        this.logger.info('Remote', 'Remote appeared while publishing; keeping the newly-created project untouched', {
          repoId,
          provider: provider.kind,
          host: created.host,
          repository: created.fullName,
        });
        return;
      }

      const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
      if (!branch) throw new Error(vscode.l10n.t('Cannot publish a detached HEAD. Check out a local branch first.'));
      const head = (await git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
      if (!head) throw new Error(vscode.l10n.t('Create the initial Git commit before publishing this repository.'));

      const repository = getVscodeRepository(rootPath);
      if (repository) await repository.addRemote('origin', created.cloneUrl);
      else await git.addRemote('origin', created.cloneUrl);

      this.logger.info('Remote', 'Created remote repository and configured origin', {
        repoId,
        provider: provider.kind,
        host: created.host,
        repository: created.fullName,
        branch,
      });
      if (pushAfterCreate) {
        await this.pushPublishedBranch(rootPath, branch);
        vscode.window.showInformationMessage(vscode.l10n.t('VersionDock: Remote created and branch pushed successfully.'));
      }
    });
  }

  private async getPublishState(rootPath: string): Promise<boolean> {
    return withGitWriteLock(rootPath, async () => {
      const git = createGitClient(rootPath);
      if ((await git.getRemotes(false)).length > 0) return false;

      const branch = (await git.raw(['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
      if (!branch) throw new Error(vscode.l10n.t('Cannot publish a detached HEAD. Check out a local branch first.'));
      const head = (await git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim();
      if (!head) throw new Error(vscode.l10n.t('Create the initial Git commit before publishing this repository.'));
      return true;
    });
  }

  private async pushPublishedBranch(rootPath: string, branch: string): Promise<void> {
    const repository = getVscodeRepository(rootPath);
    if (repository) {
      await repository.status().catch(() => {});
      if (repository.state.remotes.some(remote => remote.name === 'origin')) {
        await repository.push('origin', branch, !repository.state.HEAD?.upstream);
        return;
      }
    }
    await createGitClient(rootPath).raw(['push', '--set-upstream', 'origin', branch]);
  }

  private async chooseProvider(preferredKind?: RemoteProviderKind): Promise<RemoteRepositoryProvider> {
    if (preferredKind) return this.providers.find(provider => provider.kind === preferredKind)!;
    type ProviderPick = vscode.QuickPickItem & { provider: RemoteRepositoryProvider };
    const items: ProviderPick[] = this.providers.map(provider => ({
      label: `${providerIcon(provider.kind) === 'github' ? '$(github)' : '$(repo)'} ${provider.name}`,
      description: provider.kind === 'gitlab' ? vscode.l10n.t('GitLab.com or a configured self-hosted instance') : vscode.l10n.t('GitHub.com'),
      provider,
    }));
    const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Select remote provider') });
    if (!selected) throw new RemoteRepositoryCancelledError(vscode.l10n.t('Remote repository creation cancelled.'));
    return selected.provider;
  }

  private async chooseNamespace(provider: RemoteRepositoryProvider, namespaces: RemoteNamespace[]): Promise<RemoteNamespace | undefined> {
    if (namespaces.length === 0) throw new Error(vscode.l10n.t('No namespace is available for creating a repository.'));
    type NamespacePick = vscode.QuickPickItem & { namespace: RemoteNamespace };
    const items: NamespacePick[] = namespaces.map(namespace => ({
      label: `$(organization) ${namespace.fullPath}`,
      description: `${provider.name} · ${namespace.kind === 'group' || namespace.kind === 'organization' ? vscode.l10n.t('Organization or group') : vscode.l10n.t('Personal')}`,
      namespace,
    }));
    if (items.length === 1) return items[0].namespace;
    const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('Select namespace for the new repository') });
    if (!selected) throw new RemoteRepositoryCancelledError(vscode.l10n.t('Remote repository creation cancelled.'));
    return selected.namespace;
  }

  private async chooseVisibility(kind: RemoteProviderKind): Promise<RemoteVisibility> {
    type VisibilityPick = vscode.QuickPickItem & { value: RemoteVisibility };
    const selected = await vscode.window.showQuickPick(
      visibilityOptions(kind) as VisibilityPick[],
      { title: vscode.l10n.t('Select repository visibility'), matchOnDescription: true },
    );
    if (!selected) throw new RemoteRepositoryCancelledError(vscode.l10n.t('Remote repository creation cancelled.'));
    return selected.value;
  }

  private showRemoteError(provider: string, error: unknown): void {
    const value = error instanceof RemoteApiError
      ? error.message
      : error instanceof Error ? error.message : String(error);
    this.logger.error('Remote', `${provider} operation failed`, error);
    void vscode.window.showErrorMessage(vscode.l10n.t('{0}: {1}', provider, value));
  }

  async getProtectedBranches(url: string): Promise<string[]> {
    if (!url) return [];
    if (/github\.com/i.test(url)) {
      return this.github.getProtectedBranches(url);
    }
    return this.gitlab.getProtectedBranches(url);
  }
}
