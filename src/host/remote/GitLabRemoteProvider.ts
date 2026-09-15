import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import { encodePath, isSameHost, normalizeHost, pageUrl, requestJson } from './api';
import type {
  CreateRepositoryInput,
  GitCredentials,
  RemoteNamespace,
  RemoteRepository,
  RemoteRepositoryProvider,
} from './types';

const HOSTS_KEY = 'versiondock.remote.gitlab.hosts';
const TOKEN_KEY_PREFIX = 'versiondock.remote.gitlab.token.';
const DEFAULT_HOST = 'https://gitlab.com';

interface GitLabAccount {
  host: string;
  token: string;
}

interface GitLabNamespace {
  id: number;
  name: string;
  path?: string;
  full_path: string;
  kind?: string;
}

interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  http_url_to_repo: string;
  web_url?: string;
  default_branch?: string | null;
  visibility: 'private' | 'internal' | 'public';
  namespace?: GitLabNamespace;
}

interface GitLabBranch {
  name: string;
}

function tokenKey(host: string): string {
  return `${TOKEN_KEY_PREFIX}${encodeURIComponent(host)}`;
}

function namespaceKind(value: string | undefined): 'user' | 'group' {
  return value === 'group' ? 'group' : 'user';
}

interface GitLabUser {
  id: number;
  username: string;
  name?: string;
  avatar_url?: string;
  email?: string;
}

export class GitLabRemoteProvider implements RemoteRepositoryProvider, vscode.Disposable {
  readonly kind = 'gitlab' as const;
  readonly name = 'GitLab';
  readonly host = DEFAULT_HOST;
  private readonly _onDidChangeAccounts = new vscode.EventEmitter<void>();
  readonly onDidChangeAccounts: vscode.Event<void> = this._onDidChangeAccounts.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {}

  dispose(): void {
    this._onDidChangeAccounts.dispose();
  }

  async getAllAccounts(): Promise<GitLabAccount[]> {
    return this.getAccounts(false);
  }

  async getCurrentUser(host: string): Promise<GitLabUser | undefined> {
    try {
      const account = await this.getAccount(host, false);
      if (!account) return undefined;
      return await this.request<GitLabUser>(account, '/user');
    } catch (error) {
      this.logger.debug('GitLab', 'Failed to fetch current user', { host, error: String(error) });
      return undefined;
    }
  }

  async getUserEmails(host: string): Promise<string[]> {
    try {
      const account = await this.getAccount(host, false);
      if (!account) return [];
      const res = await this.request<Array<{ id: number; email: string }>>(account, '/user/emails');
      if (Array.isArray(res)) {
        return res.map(r => r.email).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  async resolveAvatarByEmail(targetHost: string | undefined, email: string, authorName?: string): Promise<string | undefined> {
    const trimmed = email.trim();
    const cleanAuthorName = (authorName ?? '').trim().toLowerCase();
    if (!trimmed && !cleanAuthorName) return undefined;

    const accounts = await this.getAccounts(false);
    if (accounts.length === 0) return undefined;

    // 1. Check connected accounts' current user first (instant match for the developer)
    const norm = trimmed.toLowerCase();
    const emailPrefix = norm.includes('@') ? norm.split('@')[0]! : norm;
    const strippedPrefix = emailPrefix.replace(/\d+$/, '');

    for (const acc of accounts) {
      if (targetHost && normalizeHost(acc.host) !== normalizeHost(targetHost)) continue;
      const currentUser = await this.getCurrentUser(acc.host);
      if (currentUser) {
        const usernameLower = currentUser.username.toLowerCase();
        const displayNameLower = currentUser.name?.toLowerCase();
        const userEmailLower = currentUser.email?.toLowerCase();

        // Match by author name
        const authorNameMatch = cleanAuthorName && (cleanAuthorName === usernameLower || cleanAuthorName === displayNameLower);

        const emailMatch = userEmailLower && userEmailLower === norm;
        const usernameMatch =
          usernameLower === norm ||
          usernameLower === emailPrefix ||
          (strippedPrefix.length >= 3 && strippedPrefix === usernameLower) ||
          norm.startsWith(`${usernameLower}@`);
        const nameMatch = displayNameLower && (displayNameLower === norm || displayNameLower === emailPrefix);

        if (authorNameMatch || emailMatch || usernameMatch || nameMatch) {
          if (currentUser.avatar_url) {
            let avatarUrl = currentUser.avatar_url;
            if (avatarUrl.startsWith('/')) avatarUrl = `${acc.host}${avatarUrl}`;
            return avatarUrl;
          }
        }
      }
    }

    // Determine which account to use for general search
    let account: GitLabAccount | undefined;
    if (targetHost) {
      account = await this.getAccount(targetHost, false);
    }
    if (!account) {
      account = accounts[0];
    }
    if (!account) return undefined;

    // Fast-path: GitLab noreply email (e.g. 12345-username@users.noreply.gitlab.com or username@noreply.gitlab.com)
    let candidateUsername: string | undefined;
    if (norm.endsWith('@users.noreply.gitlab.com') || norm.endsWith('@noreply.gitlab.com')) {
      const local = norm.split('@')[0] ?? '';
      candidateUsername = local.includes('-') ? local.split('-').slice(1).join('-') : local;
    }

    try {
      let avatarUrl: string | undefined;

      // 收集候选用户名（包括 noreply 候选、非纯数字邮箱前缀、authorName 等）
      const candidateUsernames: string[] = [];
      if (candidateUsername) candidateUsernames.push(candidateUsername);
      const rawEmailPrefix = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed;
      if (rawEmailPrefix && !/^\d+$/.test(rawEmailPrefix) && !candidateUsernames.includes(rawEmailPrefix)) {
        candidateUsernames.push(rawEmailPrefix);
      }
      if (cleanAuthorName && /^[a-zA-Z0-9_.-]+$/.test(cleanAuthorName) && !candidateUsernames.includes(cleanAuthorName)) {
        candidateUsernames.push(cleanAuthorName);
      }

      // 1. Query users by search (优先根据提交邮箱，其次根据作者姓名检索真实 GitLab 用户实体)
      const searchTerms = [trimmed, cleanAuthorName].filter(Boolean);
      for (const term of searchTerms) {
        const users = await this.request<GitLabUser[]>(
          account,
          `/users?search=${encodeURIComponent(term)}`,
        ).catch(() => [] as GitLabUser[]);
        if (users && users.length > 0) {
          const matched = users.find(u =>
            (cleanAuthorName && (u.name?.toLowerCase() === cleanAuthorName || u.username.toLowerCase() === cleanAuthorName)) ||
            (u.email?.toLowerCase() === norm)
          ) || users[0];
          if (matched?.avatar_url) {
            avatarUrl = matched.avatar_url;
            break;
          }
        }
      }

      // 2. Query users by username candidates (备选候选用户名精确查询)
      if (!avatarUrl) {
        for (const u of candidateUsernames) {
          const users = await this.request<GitLabUser[]>(
            account,
            `/users?username=${encodeURIComponent(u)}`,
          ).catch(() => [] as GitLabUser[]);
          if (users && users.length > 0 && users[0]?.avatar_url) {
            avatarUrl = users[0].avatar_url;
            break;
          }
        }
      }

      if (!avatarUrl) return undefined;

      if (avatarUrl.startsWith('/')) {
        avatarUrl = `${account.host}${avatarUrl}`;
      }

      return avatarUrl;
    } catch (error) {
      this.logger.debug('GitLab', 'Failed to resolve avatar by email', { email: trimmed, error: String(error) });
      return undefined;
    }
  }

  async fetchAuthenticatedImage(host: string, imageUrl: string): Promise<string | undefined> {
    try {
      const account = await this.getAccount(host, false);
      const headers: Record<string, string> = {};
      if (account?.token) {
        headers['PRIVATE-TOKEN'] = account.token;
      }
      const response = await fetch(imageUrl, { headers });
      if (!response.ok) return undefined;
      const contentType = response.headers.get('content-type') || 'image/png';
      const arrayBuffer = await response.arrayBuffer();
      const base64 = Buffer.from(arrayBuffer).toString('base64');
      return `data:${contentType};base64,${base64}`;
    } catch (error) {
      this.logger.debug('GitLab', 'Failed to fetch authenticated image', { host, imageUrl, error: String(error) });
      return undefined;
    }
  }

  async listRepositories(query?: string): Promise<RemoteRepository[]> {
    const accounts = await this.getAccounts(true);
    const results = await Promise.allSettled(accounts.map(account => this.listRepositoriesForAccount(account, query)));
    const repositories: RemoteRepository[] = [];
    let firstError: unknown;
    for (const result of results) {
      if (result.status === 'fulfilled') repositories.push(...result.value);
      else if (firstError === undefined) firstError = result.reason;
    }
    if (repositories.length === 0 && firstError !== undefined) throw firstError;
    return repositories;
  }

  async listNamespaces(): Promise<RemoteNamespace[]> {
    const accounts = await this.getAccounts(true);
    const results = await Promise.allSettled(accounts.map(account => this.listNamespacesForAccount(account)));
    const namespaces = new Map<string, RemoteNamespace>();
    let firstError: unknown;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const namespace of result.value) namespaces.set(`${namespace.host}:${namespace.id}`, namespace);
      } else if (firstError === undefined) {
        firstError = result.reason;
      }
    }
    if (namespaces.size === 0 && firstError !== undefined) throw firstError;
    return [...namespaces.values()];
  }

  async getBranches(url: string): Promise<string[]> {
    const parsed = await this.parseProjectUrl(url);
    if (!parsed) return [];
    const account = await this.getAccount(parsed.host, false);
    if (!account) return [];
    const branches = await this.fetchPages<GitLabBranch>(
      account,
      `/projects/${encodePath(parsed.path)}/repository/branches`,
      {},
    );
    return branches.map(branch => branch.name);
  }

  async getProtectedBranches(url: string): Promise<string[]> {
    const parsed = await this.parseProjectUrl(url);
    if (!parsed) return [];
    try {
      const account = await this.getAccount(parsed.host, false);
      if (!account) return [];
      const protectedBranches = await this.fetchPages<{ name: string }>(
        account,
        `/projects/${encodePath(parsed.path)}/protected_branches`,
        {},
      );
      return protectedBranches.map(b => b.name);
    } catch (error) {
      this.logger.debug('GitLab', 'Failed to fetch protected branches', { url, error: String(error) });
      return [];
    }
  }

  async createRepository(input: CreateRepositoryInput): Promise<RemoteRepository> {
    const host = input.namespace?.host ?? await this.chooseHost();
    const account = await this.getAccount(host, true);
    if (!account) throw new Error('GitLab authentication is required.');
    const body: Record<string, string | number> = {
      name: input.name,
      visibility: input.visibility,
    };
    if (input.namespace?.kind === 'group') body.namespace_id = Number(input.namespace.id);
    const project = await this.request<GitLabProject>(account, '/projects', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapProject(project, account.host);
  }

  async getCredentials(host: vscode.Uri): Promise<GitCredentials | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(host.toString());
    } catch {
      return undefined;
    }
    const configuredHost = (await this.getHosts()).find(value => {
      try {
        return new URL(value).origin === parsed.origin;
      } catch {
        return false;
      }
    });
    const configured = configuredHost ? await this.getAccount(configuredHost, false) : undefined;
    return configured && isSameHost(parsed, configured.host)
      ? { username: 'oauth2', password: configured.token }
      : undefined;
  }

  async manageAccounts(): Promise<void> {
    const accounts = await this.getAccounts(false);
    const userMap = new Map<string, GitLabUser | undefined>();
    await Promise.all(
      accounts.map(async account => {
        const user = await this.getCurrentUser(account.host).catch(() => undefined);
        userMap.set(account.host, user);
      }),
    );

    type AccountPick = vscode.QuickPickItem & { action: 'add' | 'reauth' | 'remove'; host?: string };
    const items: AccountPick[] = [
      { label: `$(add) ${vscode.l10n.t('Add GitLab account…')}`, action: 'add' },
      ...accounts.flatMap(account => {
        const user = userMap.get(account.host);
        const displayName = user ? `${user.name || user.username} (@${user.username})` : account.host;
        return [
          {
            label: `$(key) ${displayName}`,
            description: account.host,
            detail: vscode.l10n.t('Re-authenticate'),
            action: 'reauth' as const,
            host: account.host,
          },
          {
            label: `$(trash) ${displayName}`,
            description: account.host,
            detail: vscode.l10n.t('Remove saved Token'),
            action: 'remove' as const,
            host: account.host,
          },
        ];
      }),
    ];
    const pick = await vscode.window.showQuickPick(items, { title: vscode.l10n.t('VersionDock — GitLab Accounts') });
    if (!pick) return;
    if (pick.action === 'add') {
      await this.promptAccount();
    } else if (pick.host && pick.action === 'reauth') {
      await this.promptAccount(pick.host);
    } else if (pick.host) {
      await this.removeAccount(pick.host);
    }
  }

  private async listRepositoriesForAccount(account: GitLabAccount, query?: string): Promise<RemoteRepository[]> {
    const projects = await this.fetchPages<GitLabProject>(account, '/projects', {
      membership: 'true',
      order_by: 'last_activity_at',
      sort: 'desc',
      search: query?.trim() || undefined,
    });
    return projects.map(project => this.mapProject(project, account.host));
  }

  private async listNamespacesForAccount(account: GitLabAccount): Promise<RemoteNamespace[]> {
    const namespaces = await this.fetchPages<GitLabNamespace>(account, '/namespaces', {});
    return namespaces.map(namespace => ({
      id: String(namespace.id),
      name: namespace.name,
      fullPath: namespace.full_path,
      kind: namespaceKind(namespace.kind),
      host: account.host,
    }));
  }

  private mapProject(project: GitLabProject, host: string): RemoteRepository {
    const namespace = project.namespace
      ? {
          id: String(project.namespace.id),
          name: project.namespace.name,
          fullPath: project.namespace.full_path,
          kind: namespaceKind(project.namespace.kind),
          host,
        }
      : undefined;
    return {
      id: String(project.id),
      provider: this.kind,
      host,
      name: project.name,
      fullName: project.path_with_namespace,
      cloneUrl: project.http_url_to_repo,
      webUrl: project.web_url,
      defaultBranch: project.default_branch ?? undefined,
      namespace,
      private: project.visibility === 'private',
    };
  }

  private async chooseHost(): Promise<string> {
    const hosts = await this.getHosts();
    if (hosts.length === 1) return hosts[0];
    const selected = await vscode.window.showQuickPick(hosts, { title: vscode.l10n.t('Select GitLab instance') });
    if (!selected) throw new Error('GitLab account selection cancelled.');
    return selected;
  }

  private async getAccounts(interactive: boolean): Promise<GitLabAccount[]> {
    let hosts = await this.getHosts();
    if (hosts.length === 0 && interactive) {
      await this.promptAccount();
      hosts = await this.getHosts();
    }
    const accounts = await Promise.all(hosts.map(async host => {
      const token = await this.context.secrets.get(tokenKey(host));
      return token ? { host, token } : undefined;
    }));
    return accounts.filter((account): account is GitLabAccount => Boolean(account));
  }

  private async getAccount(host: string, interactive: boolean): Promise<GitLabAccount | undefined> {
    const normalized = normalizeHost(host);
    const token = await this.context.secrets.get(tokenKey(normalized));
    if (token) return { host: normalized, token };
    if (!interactive) return undefined;
    await this.promptAccount(normalized);
    const updated = await this.context.secrets.get(tokenKey(normalized));
    return updated ? { host: normalized, token: updated } : undefined;
  }

  private async getHosts(): Promise<string[]> {
    const configured = this.context.globalState.get<string[]>(HOSTS_KEY, []);
    return [...new Set(configured.map(value => normalizeHost(value)))];
  }

  private async promptAccount(existingHost?: string): Promise<void> {
    const hostValue = await vscode.window.showInputBox({
      title: vscode.l10n.t('GitLab instance'),
      prompt: vscode.l10n.t('Enter gitlab.com or a self-hosted GitLab URL'),
      value: existingHost ?? DEFAULT_HOST,
      validateInput: value => {
        try {
          const normalized = normalizeHost(value);
          return normalized.startsWith('https://') ? undefined : vscode.l10n.t('GitLab URL must use HTTPS.');
        } catch {
          return vscode.l10n.t('GitLab URL is invalid.');
        }
      },
    });
    if (!hostValue) return;
    const host = normalizeHost(hostValue);
    const token = await vscode.window.showInputBox({
      title: vscode.l10n.t('GitLab Personal Access Token'),
      prompt: vscode.l10n.t('The Token needs the api scope and will be stored securely in VS Code.'),
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : vscode.l10n.t('Token cannot be empty.'),
    });
    if (!token?.trim()) return;
    await this.request<unknown>({ host, token: token.trim() }, '/user');
    await this.context.secrets.store(tokenKey(host), token.trim());
    const hosts = await this.getHosts();
    await this.context.globalState.update(HOSTS_KEY, [...new Set([...hosts, host])]);
    this._onDidChangeAccounts.fire();
    vscode.window.showInformationMessage(vscode.l10n.t('VersionDock: GitLab account connected: {0}', host));
  }

  private async removeAccount(host: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('VersionDock: Remove the saved GitLab Token for {0}?', host),
      vscode.l10n.t('Remove'),
      vscode.l10n.t('Cancel'),
    );
    if (choice !== vscode.l10n.t('Remove')) return;
    await this.context.secrets.delete(tokenKey(host));
    const hosts = (await this.getHosts()).filter(value => value !== host);
    await this.context.globalState.update(HOSTS_KEY, hosts);
    this._onDidChangeAccounts.fire();
  }

  private async request<T>(account: GitLabAccount, path: string, init: RequestInit = {}): Promise<T> {
    return requestJson<T>(`${account.host}/api/v4${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': account.token,
        ...(init.headers ?? {}),
      },
    }, this.logger, 'GitLab');
  }

  private async fetchPages<T>(account: GitLabAccount, path: string, params: Record<string, string | number | undefined>): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const base = `${account.host}/api/v4${path}`;
      const url = pageUrl(base, { ...params, per_page: 100, page });
      const payload = await this.request<T[]>(account, url.slice(`${account.host}/api/v4`.length));
      values.push(...payload);
      if (payload.length < 100) break;
    }
    return values;
  }

  private async parseProjectUrl(value: string): Promise<{ host: string; path: string } | undefined> {
    try {
      const url = new URL(value);
      const configuredHost = (await this.getHosts()).find(value => {
        try {
          return new URL(value).origin === url.origin;
        } catch {
          return false;
        }
      });
      const basePath = configuredHost ? new URL(configuredHost).pathname.replace(/\/+$/, '') : '';
      const projectPath = url.pathname.slice(basePath.length).replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
      if (projectPath.split('/').length < 2) return undefined;
      return { host: configuredHost ?? normalizeHost(url.origin), path: projectPath };
    } catch {
      return undefined;
    }
  }
}
