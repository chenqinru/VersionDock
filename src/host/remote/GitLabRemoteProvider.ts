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

export class GitLabRemoteProvider implements RemoteRepositoryProvider {
  readonly kind = 'gitlab' as const;
  readonly name = 'GitLab';
  readonly host = DEFAULT_HOST;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {}

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
    type AccountPick = vscode.QuickPickItem & { action: 'add' | 'reauth' | 'remove'; host?: string };
    const items: AccountPick[] = [
      { label: `$(add) ${vscode.l10n.t('Add GitLab account…')}`, action: 'add' },
      ...accounts.flatMap(account => [
        { label: `$(key) ${account.host}`, description: vscode.l10n.t('Re-authenticate'), action: 'reauth' as const, host: account.host },
        { label: `$(trash) ${account.host}`, description: vscode.l10n.t('Remove saved Token'), action: 'remove' as const, host: account.host },
      ]),
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
