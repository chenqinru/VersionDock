import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import { encodePath, isSameHost, pageUrl, requestJson } from './api';
import type {
  CreateRepositoryInput,
  GitCredentials,
  RemoteNamespace,
  RemoteRepository,
  RemoteRepositoryProvider,
} from './types';

const ACCOUNT_KEY = 'versiondock.remote.gitee.account';
const TOKEN_KEY = 'versiondock.remote.gitee.token';
const API_URL = 'https://gitee.com/api/v5';
const GITEE_HOST = 'https://gitee.com';

export interface GiteeAccountMeta {
  id: number;
  username: string;
  name?: string;
  avatarUrl?: string;
}

export interface GiteeAccount extends GiteeAccountMeta {
  token: string;
}

interface GiteeUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  email?: string | null;
}

interface GiteeOrg {
  id: number;
  login: string;
  name?: string | null;
}

interface GiteeBranch {
  name: string;
  protected?: boolean;
}

interface GiteeRepository {
  id: number;
  name: string;
  full_name: string;
  path: string;
  private: boolean;
  html_url?: string;
  default_branch?: string | null;
  owner: {
    login: string;
    type?: string;
  };
  namespace?: {
    id?: number;
    type?: string;
    name?: string;
    path?: string;
  };
}

export class GiteeRemoteProvider implements RemoteRepositoryProvider, vscode.Disposable {
  readonly kind = 'gitee' as const;
  readonly name = 'Gitee';
  readonly host = GITEE_HOST;

  private readonly _onDidChangeAccounts = new vscode.EventEmitter<void>();
  readonly onDidChangeAccounts: vscode.Event<void> = this._onDidChangeAccounts.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {}

  dispose(): void {
    this._onDidChangeAccounts.dispose();
  }

  async getAccount(interactive = false): Promise<GiteeAccount | undefined> {
    const meta = this.context.globalState.get<GiteeAccountMeta>(ACCOUNT_KEY);
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (meta && token) {
      return { ...meta, token };
    }

    if (!interactive) return undefined;
    await this.promptToken('connect');
    const updatedMeta = this.context.globalState.get<GiteeAccountMeta>(ACCOUNT_KEY);
    const updatedToken = await this.context.secrets.get(TOKEN_KEY);
    return updatedMeta && updatedToken ? { ...updatedMeta, token: updatedToken } : undefined;
  }

  async getAllAccounts(): Promise<GiteeAccount[]> {
    const account = await this.getAccount(false);
    return account ? [account] : [];
  }

  async getCurrentUser(token?: string): Promise<GiteeUser | undefined> {
    const authToken = token ?? (await this.getAccount(false))?.token;
    if (!authToken) return undefined;
    try {
      return await this.request<GiteeUser>('/user', authToken);
    } catch (error) {
      this.logger.debug('Gitee', 'Failed to fetch current user', { error: String(error) });
      return undefined;
    }
  }

  async getUserEmails(token?: string): Promise<string[]> {
    const authToken = token ?? (await this.getAccount(false))?.token;
    if (!authToken) return [];
    try {
      const res = await this.request<Array<{ email: string; state?: string }>>('/emails', authToken);
      if (Array.isArray(res)) {
        return res.map(r => r.email).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  private usernameAvatarCache = new Map<string, string | null>();

  clearCache(): void {
    this.usernameAvatarCache.clear();
  }

  async resolveAvatarByEmail(email: string, authorName?: string): Promise<string | undefined> {
    const trimmed = email.trim();
    const cleanAuthorName = (authorName ?? '').trim().toLowerCase();
    if (!trimmed && !cleanAuthorName) return undefined;

    const account = await this.getAccount(false);
    if (!account?.token) return undefined;

    // 1. Match against connected account
    const norm = trimmed.toLowerCase();
    const emailPrefix = norm.includes('@') ? norm.split('@')[0]! : norm;
    const strippedPrefix = emailPrefix.replace(/\d+$/, '');

    if (account) {
      const usernameLower = account.username.toLowerCase();
      const displayNameLower = account.name?.toLowerCase();

      const authorNameMatch =
        cleanAuthorName && (cleanAuthorName === usernameLower || cleanAuthorName === displayNameLower);
      const emailMatch =
        usernameLower === norm ||
        usernameLower === emailPrefix ||
        (strippedPrefix.length >= 3 && strippedPrefix === usernameLower) ||
        norm.startsWith(`${usernameLower}@`);
      const nameMatch = displayNameLower && (displayNameLower === norm || displayNameLower === emailPrefix);

      if (authorNameMatch || emailMatch || nameMatch) {
        if (account.avatarUrl && !account.avatarUrl.includes('no_portrait.png')) {
          return account.avatarUrl;
        }
      }
    }

    // 2. Fast-path: Gitee noreply email (e.g. 12345+username@user.noreply.gitee.com)
    if (trimmed.toLowerCase().endsWith('@user.noreply.gitee.com') || trimmed.toLowerCase().endsWith('@noreply.gitee.com')) {
      const local = trimmed.split('@')[0] ?? '';
      const candidate = local.includes('+')
        ? local.split('+')[1]
        : local.includes('_')
          ? local.split('_').slice(1).join('_')
          : local;
      if (candidate) {
        const url = await this.resolveAvatarByUsername(candidate);
        if (url) return url;
      }
    }

    // 3. Search Gitee users using candidates in priority order:
    // Email prefix is the most reliable match for Gitee users (e.g. zhijiantianya@gmail.com -> zhijiantianya)
    const candidates: string[] = [];
    if (emailPrefix && emailPrefix.length >= 2) {
      candidates.push(emailPrefix);
      if (strippedPrefix.length >= 2 && strippedPrefix !== emailPrefix) {
        candidates.push(strippedPrefix);
      }
    }
    if (cleanAuthorName && cleanAuthorName.length >= 2) {
      candidates.push(cleanAuthorName);
      const strippedName = cleanAuthorName.replace(/\d+$/, '');
      if (strippedName.length >= 2 && strippedName !== cleanAuthorName) {
        candidates.push(strippedName);
      }
    }

    const uniqueCandidates = [...new Set(candidates)];
    for (const candidate of uniqueCandidates) {
      const url = await this.resolveAvatarByUsername(candidate);
      if (url) return url;
    }

    return undefined;
  }

  private async resolveAvatarByUsername(username: string): Promise<string | undefined> {
    const key = username.toLowerCase();
    if (this.usernameAvatarCache.has(key)) {
      const cached = this.usernameAvatarCache.get(key);
      return cached ?? undefined;
    }

    try {
      const account = await this.getAccount(false);
      if (!account?.token) return undefined;

      const data = await this.request<{ avatar_url?: string }>(
        `/users/${encodeURIComponent(username)}`,
        account.token,
      ).catch(() => undefined);

      if (data?.avatar_url && !data.avatar_url.includes('no_portrait.png')) {
        this.usernameAvatarCache.set(key, data.avatar_url);
        return data.avatar_url;
      }
    } catch {
      // Ignore network errors
    }

    this.usernameAvatarCache.set(key, null);
    return undefined;
  }

  async listRepositories(query?: string): Promise<RemoteRepository[]> {
    const account = await this.getAccount(true);
    if (!account) return [];

    const repos = await this.fetchPages<GiteeRepository>(account.token, '/user/repos', {
      type: 'all',
      sort: 'updated',
    });

    const normalizedQuery = query?.trim().toLowerCase();
    return repos
      .filter(repo => {
        if (!normalizedQuery) return true;
        return (
          repo.name.toLowerCase().includes(normalizedQuery) ||
          repo.full_name.toLowerCase().includes(normalizedQuery)
        );
      })
      .map(repo => this.mapRepository(repo));
  }

  async listNamespaces(): Promise<RemoteNamespace[]> {
    const account = await this.getAccount(true);
    if (!account) return [];

    const userNs: RemoteNamespace = {
      id: String(account.id),
      name: account.username,
      fullPath: account.username,
      kind: 'user',
      host: GITEE_HOST,
    };

    try {
      const orgs = await this.fetchPages<GiteeOrg>(account.token, '/user/orgs', {});
      const orgNamespaces: RemoteNamespace[] = orgs.map(org => ({
        id: String(org.id),
        name: org.name || org.login,
        fullPath: org.login,
        kind: 'organization',
        host: GITEE_HOST,
      }));
      return [userNs, ...orgNamespaces];
    } catch (error) {
      this.logger.debug('Gitee', 'Failed to fetch user orgs', { username: account.username, error: String(error) });
      return [userNs];
    }
  }

  async getBranches(url: string): Promise<string[]> {
    const repo = this.parseRepositoryUrl(url);
    if (!repo) return [];
    const account = await this.getAccount(false);
    if (!account) return [];

    const branches = await this.fetchPages<GiteeBranch>(
      account.token,
      `/repos/${encodePath(repo.owner)}/${encodePath(repo.name)}/branches`,
      {},
    );
    return branches.map(b => b.name);
  }

  async getProtectedBranches(url: string): Promise<string[]> {
    const repo = this.parseRepositoryUrl(url);
    if (!repo) return [];
    try {
      const account = await this.getAccount(false);
      if (!account) return [];

      const branches = await this.fetchPages<GiteeBranch>(
        account.token,
        `/repos/${encodePath(repo.owner)}/${encodePath(repo.name)}/branches`,
        {},
      );
      return branches.filter(b => Boolean(b.protected)).map(b => b.name);
    } catch (error) {
      this.logger.debug('Gitee', 'Failed to fetch protected branches', { url, error: String(error) });
      return [];
    }
  }

  async createRepository(input: CreateRepositoryInput): Promise<RemoteRepository> {
    const account = await this.getAccount(true);
    if (!account) throw new Error('Gitee authentication is required.');

    const isOrganization = input.namespace?.kind === 'organization';
    const endpoint = isOrganization
      ? `/orgs/${encodePath(input.namespace!.fullPath)}/repos`
      : '/user/repos';

    const body: Record<string, unknown> = {
      name: input.name,
      private: input.visibility === 'private',
    };

    const created = await this.request<GiteeRepository>(endpoint, account.token, {
      method: 'POST',
      body: JSON.stringify(body),
    });

    return this.mapRepository(created);
  }

  async getCredentials(host: vscode.Uri): Promise<GitCredentials | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(host.toString());
    } catch {
      return undefined;
    }
    if (!isSameHost(parsed, GITEE_HOST)) return undefined;

    const account = await this.getAccount(false);
    if (!account) return undefined;

    return { username: account.username, password: account.token };
  }

  async manageAccounts(): Promise<void> {
    const account = await this.getAccount(false);

    if (!account) {
      await this.promptToken('connect');
      return;
    }

    type GiteeAction = vscode.QuickPickItem & { action: 'switch' | 'reauth' | 'profile' | 'remove' };
    const displayName = account.name ? `${account.name} (@${account.username})` : `@${account.username}`;

    const items: GiteeAction[] = [
      {
        label: `$(account) ${vscode.l10n.t('Switch Gitee account…')}`,
        description: vscode.l10n.t('Sign in with a different Gitee account'),
        action: 'switch',
      },
      {
        label: `$(key) ${vscode.l10n.t('Re-authenticate')}`,
        description: vscode.l10n.t('Update Personal Access Token for @{0}', account.username),
        action: 'reauth',
      },
      {
        label: `$(globe) ${vscode.l10n.t('Open Gitee Profile')}`,
        description: `https://gitee.com/${account.username}`,
        action: 'profile',
      },
      {
        label: `$(trash) ${vscode.l10n.t('Remove saved Token')}`,
        description: vscode.l10n.t('Disconnect from Gitee'),
        action: 'remove',
      },
    ];

    const pick = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Gitee Account — {0}', displayName),
    });
    if (!pick) return;

    if (pick.action === 'switch') {
      await this.promptToken('switch');
    } else if (pick.action === 'reauth') {
      await this.promptToken('reauth');
    } else if (pick.action === 'profile') {
      void vscode.env.openExternal(vscode.Uri.parse(`https://gitee.com/${account.username}`));
    } else if (pick.action === 'remove') {
      await this.removeAccount();
    }
  }

  private mapRepository(repository: GiteeRepository): RemoteRepository {
    const isOrg = repository.owner?.type?.toLowerCase() === 'organization';
    const namespace: RemoteNamespace = {
      id: String(repository.namespace?.id ?? repository.owner?.login ?? ''),
      name: repository.namespace?.name ?? repository.owner?.login ?? '',
      fullPath: repository.namespace?.path ?? repository.owner?.login ?? '',
      kind: isOrg ? 'organization' : 'user',
      host: GITEE_HOST,
    };

    const cloneUrl = `https://gitee.com/${repository.full_name}.git`;
    return {
      id: String(repository.id),
      provider: this.kind,
      host: GITEE_HOST,
      name: repository.name,
      fullName: repository.full_name,
      cloneUrl,
      webUrl: repository.html_url || `https://gitee.com/${repository.full_name}`,
      defaultBranch: repository.default_branch ?? undefined,
      namespace,
      private: Boolean(repository.private),
    };
  }

  private async promptToken(action: 'connect' | 'switch' | 'reauth'): Promise<void> {
    const titleMap = {
      connect: vscode.l10n.t('Connect Gitee Account'),
      switch: vscode.l10n.t('Switch Gitee Account'),
      reauth: vscode.l10n.t('Re-authenticate Gitee Account'),
    };

    const token = await vscode.window.showInputBox({
      title: titleMap[action],
      prompt: vscode.l10n.t(
        'Enter your Gitee Personal Access Token (requires "projects" and "user_info" scopes).',
      ),
      password: true,
      ignoreFocusOut: true,
      validateInput: value => (value.trim() ? undefined : vscode.l10n.t('Token cannot be empty.')),
    });

    if (!token?.trim()) return;
    const cleanToken = token.trim();

    // Verify token by requesting /user
    let user: GiteeUser;
    try {
      user = await this.request<GiteeUser>('/user', cleanToken);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Failed to authenticate with Gitee: {0}', msg),
      );
      return;
    }

    if (!user?.login) {
      void vscode.window.showErrorMessage(vscode.l10n.t('Gitee authentication failed: Invalid user profile.'));
      return;
    }

    await this.context.secrets.store(TOKEN_KEY, cleanToken);
    const meta: GiteeAccountMeta = {
      id: user.id,
      username: user.login,
      name: user.name ?? undefined,
      avatarUrl: user.avatar_url,
    };
    await this.context.globalState.update(ACCOUNT_KEY, meta);
    this._onDidChangeAccounts.fire();

    const infoMsg =
      action === 'switch'
        ? vscode.l10n.t('VersionDock: Switched to Gitee account "@{0}".', user.login)
        : vscode.l10n.t('VersionDock: Gitee account connected: "@{0}".', user.login);
    void vscode.window.showInformationMessage(infoMsg);
  }

  private async removeAccount(): Promise<void> {
    const meta = this.context.globalState.get<GiteeAccountMeta>(ACCOUNT_KEY);
    const targetLabel = meta?.username ? `@${meta.username}` : 'Gitee';

    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('VersionDock: Disconnect and remove saved Token for {0}?', targetLabel),
      vscode.l10n.t('Disconnect'),
      vscode.l10n.t('Cancel'),
    );
    if (choice !== vscode.l10n.t('Disconnect')) return;

    await this.context.secrets.delete(TOKEN_KEY);
    await this.context.globalState.update(ACCOUNT_KEY, undefined);
    this.clearCache();
    this._onDidChangeAccounts.fire();
    void vscode.window.showInformationMessage(vscode.l10n.t('VersionDock: Gitee account disconnected.'));
  }

  private parseRepositoryUrl(value: string): { owner: string; name: string } | undefined {
    try {
      const clean = value.trim();
      if (clean.startsWith('git@gitee.com:')) {
        const pathPart = clean.slice('git@gitee.com:'.length).replace(/\.git$/, '');
        const parts = pathPart.split('/').filter(Boolean);
        if (parts.length >= 2) return { owner: parts[0], name: parts[1] };
      }
      const url = new URL(clean);
      if (!isSameHost(url, GITEE_HOST)) return undefined;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return undefined;
      return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
    } catch {
      return undefined;
    }
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    const targetUrl = `${API_URL}${path}`;

    return requestJson<T>(
      targetUrl,
      {
        ...init,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(init.headers ?? {}),
        },
      },
      this.logger,
      'Gitee',
    );
  }

  private async fetchPages<T>(
    token: string,
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const url = pageUrl(path, { ...params, per_page: 100, page });
      const payload = await this.request<T[]>(url, token);
      if (Array.isArray(payload)) {
        values.push(...payload);
        if (payload.length < 100) break;
      } else {
        break;
      }
    }
    return values;
  }
}
