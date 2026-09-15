import * as path from 'path';
import * as vscode from 'vscode';
import type { API, RemoteSource, RemoteSourcePublisher, RemoteSourceProvider } from '../git/git.d';
import { createGitClient, withGitWriteLock } from '../git/GitOperationLock';
import { getVscodeGitApi, getVscodeRepository } from '../git/VscodeGitApi';
import type { VersionDockLogger } from '../utils/Logger';
import { GitHubRemoteProvider } from './GitHubRemoteProvider';
import { GitLabRemoteProvider } from './GitLabRemoteProvider';
import { GiteeRemoteProvider } from './GiteeRemoteProvider';
import { AvatarService } from './AvatarService';
import type { RemoteAccountInfo } from '../types/messages';
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
  if (kind === 'github' || kind === 'gitee') {
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
  readonly gitee: GiteeRemoteProvider;
  readonly avatarService: AvatarService;
  private readonly providers: RemoteRepositoryProvider[];
  private readonly disposables: vscode.Disposable[] = [];
  private readonly apiDisposables: vscode.Disposable[] = [];
  private registeredApi: API | undefined;
  private apiStateListener: vscode.Disposable | undefined;
  private publishTails = new Map<string, Promise<void>>();

  private readonly _onDidChangeAccounts = new vscode.EventEmitter<void>();
  readonly onDidChangeAccounts: vscode.Event<void> = this._onDidChangeAccounts.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {
    this.github = new GitHubRemoteProvider(logger);
    this.gitlab = new GitLabRemoteProvider(context, logger);
    this.gitee = new GiteeRemoteProvider(context, logger);
    this.avatarService = new AvatarService(context, this.github, this.gitlab, this.gitee, logger);
    this.providers = [this.github, this.gitlab, this.gitee];
    this.disposables.push(this.gitlab);
    this.disposables.push(this.gitee);
    this.disposables.push(this.avatarService);
    this.disposables.push(this._onDidChangeAccounts);

    // 监听账号变更：仅在某平台账号被真正断开/移除时，才定向清理该平台的头像缓存，杜绝窗口初始化或普通 session 刷新时全量清空缓存
    let prevGiteeHasAccount = Boolean(context.globalState.get('versiondock.remote.gitee.account'));
    this.disposables.push(
      this.gitee.onDidChangeAccounts(() => {
        const curGiteeHasAccount = Boolean(context.globalState.get('versiondock.remote.gitee.account'));
        if (prevGiteeHasAccount && !curGiteeHasAccount) {
          this.avatarService.clearCacheForPlatform('gitee');
        }
        prevGiteeHasAccount = curGiteeHasAccount;
        this._onDidChangeAccounts.fire();
      })
    );

    let prevGitLabHosts = context.globalState.get<string[]>('versiondock.remote.gitlab.hosts', []);
    this.disposables.push(
      this.gitlab.onDidChangeAccounts(() => {
        const curGitLabHosts = context.globalState.get<string[]>('versiondock.remote.gitlab.hosts', []);
        if (prevGitLabHosts.length > 0 && curGitLabHosts.length === 0) {
          this.avatarService.clearCacheForPlatform('gitlab');
        }
        prevGitLabHosts = curGitLabHosts;
        this._onDidChangeAccounts.fire();
      })
    );

    this.disposables.push(
      vscode.authentication.onDidChangeSessions(e => {
        if (e.provider.id === 'github') {
          void this.github.getSession({ createIfNone: false }).then(session => {
            if (!session) {
              this.avatarService.clearCacheForPlatform('github');
            }
            this._onDidChangeAccounts.fire();
          }).catch(() => {});
        }
      })
    );
    this.disposables.push(vscode.extensions.onDidChange(() => this.tryRegisterGitApi()));
    this.tryRegisterGitApi();
  }

  get publishMissingRemote(): PublishMissingRemote {
    return (repoId, rootPath) => this.publishRepository(repoId, rootPath);
  }

  async getConnectedAccounts(): Promise<RemoteAccountInfo[]> {
    const accounts: RemoteAccountInfo[] = [];

    // 1. GitHub
    try {
      const user = await this.github.getAuthenticatedUser();
      if (user) {
        const emails: string[] = [];
        if (user.email) emails.push(user.email);
        const ghEmails = await this.github.getUserEmails().catch(() => []);
        for (const e of ghEmails) {
          if (!emails.some(x => x.toLowerCase() === e.toLowerCase())) {
            emails.push(e);
          }
        }
        accounts.push({
          provider: 'github',
          id: String(user.id),
          username: user.login,
          name: user.name ?? undefined,
          avatarUrl: user.avatar_url,
          host: 'https://github.com',
          emails: emails.length > 0 ? emails : undefined,
        });
      } else {
        const session = await this.github.getSession({ createIfNone: false }).catch(() => undefined);
        if (session?.account?.label) {
          const username = session.account.label;
          accounts.push({
            provider: 'github',
            id: session.account.id || username,
            username,
            avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`,
            host: 'https://github.com',
          });
        }
      }
    } catch {
      // Ignore error
    }

    // 2. GitLab
    try {
      const gitlabAccounts = await this.gitlab.getAllAccounts();
      for (const acc of gitlabAccounts) {
        const user = await this.gitlab.getCurrentUser(acc.host);
        if (user) {
          let avatarUrl = user.avatar_url;
          if (avatarUrl?.startsWith('/')) {
            avatarUrl = `${acc.host}${avatarUrl}`;
          }
          const emails: string[] = [];
          if (user.email) emails.push(user.email);
          const glEmails = await this.gitlab.getUserEmails(acc.host).catch(() => []);
          for (const e of glEmails) {
            if (!emails.some(x => x.toLowerCase() === e.toLowerCase())) {
              emails.push(e);
            }
          }
          accounts.push({
            provider: 'gitlab',
            id: String(user.id),
            username: user.username,
            name: user.name,
            avatarUrl,
            host: acc.host,
            emails: emails.length > 0 ? emails : undefined,
          });
        } else {
          accounts.push({
            provider: 'gitlab',
            username: acc.host,
            host: acc.host,
          });
        }
      }
    } catch {
      // Ignore error
    }

    // 3. Gitee
    try {
      const giteeAccounts = await this.gitee.getAllAccounts();
      for (const acc of giteeAccounts) {
        const emails: string[] = [];
        const gEmails = await this.gitee.getUserEmails(acc.token).catch(() => []);
        for (const e of gEmails) {
          if (!emails.some(x => x.toLowerCase() === e.toLowerCase())) {
            emails.push(e);
          }
        }
        accounts.push({
          provider: 'gitee',
          id: String(acc.id),
          username: acc.username,
          name: acc.name,
          avatarUrl: acc.avatarUrl,
          host: 'https://gitee.com',
          emails: emails.length > 0 ? emails : undefined,
        });
      }
    } catch {
      // Ignore error
    }

    return accounts;
  }

  async manageAccounts(): Promise<void> {
    type AccountAction = vscode.QuickPickItem & { action: 'github' | 'gitlab' | 'gitee' | 'clear-cache' };

    const [githubSession, connected] = await Promise.all([
      this.github.getSession({ createIfNone: false }).catch(() => undefined),
      this.getConnectedAccounts().catch(() => [] as RemoteAccountInfo[]),
    ]);

    let ghAccount = connected.find(a => a.provider === 'github');
    if (!ghAccount && githubSession?.account?.label) {
      const username = githubSession.account.label;
      ghAccount = {
        provider: 'github',
        id: githubSession.account.id || username,
        username,
        avatarUrl: `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`,
        host: 'https://github.com',
      };
    }
    const glAccounts = connected.filter(a => a.provider === 'gitlab');
    const gtAccount = connected.find(a => a.provider === 'gitee');

    const ghConnected = Boolean(ghAccount || githubSession);
    const glConnected = glAccounts.length > 0;
    const gtConnected = Boolean(gtAccount);

    // 1. Label（第一行左侧）：统一为平台名称与当前账号，避免“管理”、“登录”等前缀导致视觉参差不齐
    const githubLabel = ghAccount
      ? `GitHub (${ghAccount.username})`
      : githubSession
        ? `GitHub (${githubSession.account.label})`
        : 'GitHub';

    const gitlabLabel = glAccounts.length === 1
      ? `GitLab (${glAccounts[0].username})`
      : 'GitLab';

    const giteeLabel = gtAccount
      ? `Gitee (@${gtAccount.username})`
      : 'Gitee';

    // 2. Description（第一行右侧）：统一只显示状态徽章
    const githubDescription = ghConnected
      ? `$(check) ${vscode.l10n.t('Connected')}`
      : vscode.l10n.t('Not connected');

    const gitlabDescription = glConnected
      ? (glAccounts.length > 1
          ? `$(check) ${vscode.l10n.t('{0} account(s) connected', glAccounts.length)}`
          : `$(check) ${vscode.l10n.t('Connected')}`)
      : vscode.l10n.t('Not connected');

    const giteeDescription = gtConnected
      ? `$(check) ${vscode.l10n.t('Connected')}`
      : vscode.l10n.t('Not connected');

    // 3. Detail（第二行下方副标题）：统一展示账号信息或操作引导
    const githubDetail = ghAccount?.name
      ? `${ghAccount.name} (@${ghAccount.username})`
      : githubSession
        ? vscode.l10n.t('Connected as {0}. Click to manage account.', githubSession.account.label)
        : vscode.l10n.t('Use the VS Code GitHub authentication provider');

    const gitlabDetail = glConnected
      ? glAccounts.map(a => `${a.name || a.username} (${a.host})`).join(' • ')
      : vscode.l10n.t('Add, re-authenticate, or remove GitLab Personal Access Tokens');

    const giteeDetail = gtAccount?.name
      ? `${gtAccount.name} (@${gtAccount.username})`
      : gtAccount
        ? vscode.l10n.t('Connected as @{0}. Click to switch or manage account.', gtAccount.username)
        : vscode.l10n.t('Connect using a Gitee Personal Access Token');

    const [ghIconUri, glIconUri, gtIconUri] = await Promise.all([
      ghAccount?.avatarUrl ? this.avatarService.getLocalAvatarUri(ghAccount.avatarUrl) : undefined,
      glAccounts[0]?.avatarUrl ? this.avatarService.getLocalAvatarUri(glAccounts[0].avatarUrl) : undefined,
      gtAccount?.avatarUrl ? this.avatarService.getLocalAvatarUri(gtAccount.avatarUrl) : undefined,
    ]);

    const items: AccountAction[] = [
      {
        label: ghIconUri ? githubLabel : `$(github) ${githubLabel}`,
        description: githubDescription,
        detail: githubDetail,
        iconPath: ghIconUri,
        action: 'github',
      },
      {
        label: glIconUri ? gitlabLabel : `$(repo) ${gitlabLabel}`,
        description: gitlabDescription,
        detail: gitlabDetail,
        iconPath: glIconUri,
        action: 'gitlab',
      },
      {
        label: gtIconUri ? giteeLabel : `$(repo) ${giteeLabel}`,
        description: giteeDescription,
        detail: giteeDetail,
        iconPath: gtIconUri,
        action: 'gitee',
      },
      {
        label: `$(trash) ${vscode.l10n.t('Clear Avatar Cache')}`,
        description: vscode.l10n.t('Cache'),
        detail: vscode.l10n.t('Purge cached avatars and force reload'),
        action: 'clear-cache',
      },
    ];
    const selected = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('VersionDock — Remote Accounts') });
    if (!selected) return;
    if (selected.action === 'clear-cache') {
      this.avatarService.clearCache();
      this._onDidChangeAccounts.fire();
      void vscode.window.showInformationMessage(vscode.l10n.t('VersionDock: Avatar cache cleared.'));
      return;
    }
    if (selected.action === 'gitlab') {
      await this.gitlab.manageAccounts();
      return;
    }
    if (selected.action === 'gitee') {
      await this.gitee.manageAccounts();
      return;
    }

    await this.manageGitHubAccount(githubSession);
  }

  async manageGitHubAccount(currentSession?: vscode.AuthenticationSession): Promise<void> {
    if (!currentSession) {
      try {
        const session = await this.github.getSession({ createIfNone: true });
        if (session?.account.label) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('VersionDock: Connected to GitHub account "{0}".', session.account.label),
          );
        }
      } catch (error) {
        this.showRemoteError('GitHub', error);
      }
      return;
    }

    type GitHubAction = vscode.QuickPickItem & { action: 'switch' | 'profile' };
    const actions: GitHubAction[] = [
      {
        label: `$(account) ${vscode.l10n.t('Switch GitHub account…')}`,
        description: vscode.l10n.t('Sign in with a different GitHub account'),
        action: 'switch',
      },
      {
        label: `$(globe) ${vscode.l10n.t('Open GitHub Profile')}`,
        description: `https://github.com/${currentSession.account.label}`,
        action: 'profile',
      },
    ];

    const chosen = await vscode.window.showQuickPick(actions, {
      title: vscode.l10n.t('GitHub Account — {0}', currentSession.account.label),
    });
    if (!chosen) return;

    if (chosen.action === 'switch') {
      try {
        const newSession = await this.github.getSession({ forceNewSession: true, createIfNone: true });
        if (newSession?.account.label) {
          void vscode.window.showInformationMessage(
            vscode.l10n.t('VersionDock: Connected to GitHub account "{0}".', newSession.account.label),
          );
        }
      } catch (error) {
        this.showRemoteError('GitHub', error);
      }
    } else if (chosen.action === 'profile') {
      void vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${currentSession.account.label}`));
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
    this.logger.info('Remote', 'Registered remote providers (GitHub, GitLab, Gitee) with VS Code Git API');
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

  public async resolveCredentialsForUrl(url: string): Promise<{ username: string; password: string } | undefined> {
    try {
      const uri = vscode.Uri.parse(url);
      return await this.getCredentials(uri);
    } catch {
      return undefined;
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
        const repoName = path.basename(rootPath);
        vscode.window.showInformationMessage(vscode.l10n.t('VersionDock [{0}]: remote created and branch pushed successfully.', repoName));
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
      description: provider.kind === 'gitlab'
        ? vscode.l10n.t('GitLab.com or a configured self-hosted instance')
        : provider.kind === 'gitee'
          ? vscode.l10n.t('Gitee.com')
          : vscode.l10n.t('GitHub.com'),
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
    void vscode.window.showErrorMessage(vscode.l10n.t('VersionDock: {0}: {1}', provider, value));
  }

  async getProtectedBranches(url: string): Promise<string[]> {
    if (!url) return [];
    if (/github\.com/i.test(url)) {
      return this.github.getProtectedBranches(url);
    }
    if (/gitee\.com/i.test(url)) {
      return this.gitee.getProtectedBranches(url);
    }
    return this.gitlab.getProtectedBranches(url);
  }
}
