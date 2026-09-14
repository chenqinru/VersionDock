import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import { encodePath, pageUrl, requestJson, isSameHost } from './api';
import type {
  CreateRepositoryInput,
  GitCredentials,
  RemoteNamespace,
  RemoteRepository,
  RemoteRepositoryProvider,
} from './types';

const API_URL = 'https://api.github.com';
const GITHUB_HOST = 'https://github.com';
const BASE_SCOPES = ['repo', 'read:org'];

interface GithubUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  email?: string | null;
}

interface GithubOrganization {
  id: number;
  login: string;
}

interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  html_url?: string;
  default_branch?: string | null;
  owner: { login: string; type?: string };
}

interface GithubBranch {
  name: string;
}

function mapNamespace(login: string, kind: 'user' | 'organization', id: number): RemoteNamespace {
  return {
    id: String(id),
    name: login,
    fullPath: login,
    kind,
    host: GITHUB_HOST,
  };
}

export class GitHubRemoteProvider implements RemoteRepositoryProvider {
  readonly kind = 'github' as const;
  readonly name = 'GitHub';
  readonly host = GITHUB_HOST;

  constructor(private readonly logger: VersionDockLogger) {}

  async authenticate(): Promise<void> {
    await this.getAccessToken(true);
  }

  async getSession(options?: vscode.AuthenticationGetSessionOptions): Promise<vscode.AuthenticationSession | undefined> {
    return vscode.authentication.getSession('github', BASE_SCOPES, options);
  }

  async getAuthenticatedUser(): Promise<GithubUser | undefined> {
    try {
      const session = await this.getSession({ createIfNone: false });
      if (!session?.accessToken) return undefined;
      return await this.request<GithubUser>('/user', session.accessToken);
    } catch (error) {
      this.logger.debug('GitHub', 'Failed to fetch authenticated user', { error: String(error) });
      return undefined;
    }
  }

  async getUserEmails(): Promise<string[]> {
    try {
      const session = await this.getSession({ createIfNone: false });
      if (!session?.accessToken) return [];
      const res = await this.request<Array<{ email: string; primary?: boolean; verified?: boolean }>>('/user/emails', session.accessToken);
      if (Array.isArray(res)) {
        return res.map(r => r.email).filter(Boolean);
      }
      return [];
    } catch {
      return [];
    }
  }

  async resolveAvatarByEmail(email: string, authorName?: string): Promise<string | undefined> {
    const trimmed = email.trim();
    const cleanAuthorName = (authorName ?? '').trim().toLowerCase();
    if (!trimmed && !cleanAuthorName) return undefined;

    // 0. Check authenticated user first (zero-latency match for current user)
    try {
      const user = await this.getAuthenticatedUser();
      if (user?.avatar_url) {
        const loginLower = user.login.toLowerCase();
        const displayNameLower = user.name?.toLowerCase();
        const userEmailLower = user.email?.toLowerCase();

        // Match by author name
        if (cleanAuthorName && (cleanAuthorName === loginLower || cleanAuthorName === displayNameLower)) {
          return user.avatar_url;
        }

        if (trimmed) {
          const norm = trimmed.toLowerCase();
          const emailPrefix = norm.includes('@') ? norm.split('@')[0]! : norm;
          const strippedPrefix = emailPrefix.replace(/\d+$/, '');

          if (
            (userEmailLower && userEmailLower === norm) ||
            loginLower === norm ||
            loginLower === emailPrefix ||
            (strippedPrefix.length >= 3 && strippedPrefix === loginLower) ||
            (displayNameLower && (displayNameLower === norm || displayNameLower === emailPrefix))
          ) {
            return user.avatar_url;
          }
        }
      }
    } catch {
      // Ignore authenticated user check failure
    }

    if (!trimmed) return undefined;

    // Fast-path: GitHub noreply email (e.g. 12345+username@users.noreply.github.com or username@users.noreply.github.com)
    if (trimmed.toLowerCase().endsWith('@users.noreply.github.com')) {
      const local = trimmed.split('@')[0] ?? '';
      const username = local.includes('+') ? local.split('+')[1] : local;
      if (username) return `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`;
    }

    try {
      const session = await this.getSession({ createIfNone: false });
      if (!session?.accessToken) return undefined;

      const result = await this.request<{ total_count: number; items?: Array<{ login: string; avatar_url: string }> }>(
        `/search/users?q=${encodeURIComponent(trimmed)}+in:email`,
        session.accessToken,
      );
      if (result.items && result.items.length > 0 && result.items[0]?.avatar_url) {
        return result.items[0].avatar_url;
      }
    } catch (error) {
      this.logger.debug('GitHub', 'Failed to resolve avatar by email', { email: trimmed, error: String(error) });
    }
    return undefined;
  }

  async listRepositories(query?: string): Promise<RemoteRepository[]> {
    const token = await this.getAccessToken(true);
    const repositories = await this.fetchPages<GithubRepository>(
      '/user/repos',
      token,
      { affiliation: 'owner,collaborator,organization_member', visibility: 'all', sort: 'updated' },
    );
    const normalizedQuery = query?.trim().toLowerCase();
    return repositories
      .filter(repository => !normalizedQuery || repository.name.toLowerCase().includes(normalizedQuery) || repository.full_name.toLowerCase().includes(normalizedQuery))
      .map(repository => this.mapRepository(repository));
  }

  async listNamespaces(): Promise<RemoteNamespace[]> {
    const token = await this.getAccessToken(true);
    const [user, organizations] = await Promise.all([
      this.request<GithubUser>('/user', token),
      this.fetchPages<GithubOrganization>('/user/orgs', token),
    ]);
    return [
      mapNamespace(user.login, 'user', user.id),
      ...organizations.map(org => mapNamespace(org.login, 'organization', org.id)),
    ];
  }

  async getBranches(url: string): Promise<string[]> {
    const repository = this.parseRepositoryUrl(url);
    if (!repository) return [];
    const token = await this.getAccessToken(true);
    const branches = await this.fetchPages<GithubBranch>(
      `/repos/${encodePath(repository.owner)}/${encodePath(repository.name)}/branches`,
      token,
      { protected: undefined },
    );
    return branches.map(branch => branch.name);
  }

  async getProtectedBranches(url: string): Promise<string[]> {
    const repository = this.parseRepositoryUrl(url);
    if (!repository) return [];
    try {
      const token = await this.getAccessToken(false);
      if (!token) return [];
      const branches = await this.fetchPages<GithubBranch>(
        `/repos/${encodePath(repository.owner)}/${encodePath(repository.name)}/branches`,
        token,
        { protected: 'true' },
      );
      return branches.map(branch => branch.name);
    } catch (error) {
      this.logger.debug('GitHub', 'Failed to fetch protected branches', { url, error: String(error) });
      return [];
    }
  }

  async createRepository(input: CreateRepositoryInput): Promise<RemoteRepository> {
    const token = await this.getAccessToken(true);
    const isOrganization = input.namespace?.kind === 'organization';
    const endpoint = isOrganization
      ? `/orgs/${encodePath(input.namespace!.fullPath)}/repos`
      : '/user/repos';
    const body = isOrganization
      ? { name: input.name, visibility: input.visibility }
      : { name: input.name, private: input.visibility === 'private' };
    const repository = await this.request<GithubRepository>(endpoint, token, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapRepository(repository);
  }

  async getCredentials(host: vscode.Uri): Promise<GitCredentials | undefined> {
    let parsed: URL;
    try {
      parsed = new URL(host.toString());
    } catch {
      return undefined;
    }
    if (!isSameHost(parsed, GITHUB_HOST)) return undefined;
    const token = await this.getAccessToken(false).catch(() => '');
    return token ? { username: 'x-access-token', password: token } : undefined;
  }

  private async getAccessToken(interactive: boolean): Promise<string> {
    const scopes = BASE_SCOPES;
    let session: vscode.AuthenticationSession | undefined;
    if (interactive) {
      session = await vscode.authentication.getSession('github', scopes, { createIfNone: true });
    } else {
      session = await vscode.authentication.getSession('github', scopes, { createIfNone: false });
    }
    if (!session?.accessToken) {
      throw new Error('GitHub authentication is required. Sign in to GitHub in VS Code and try again.');
    }
    return session.accessToken;
  }

  private async request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
    return requestJson<T>(`${API_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init.headers ?? {}),
      },
    }, this.logger, 'GitHub');
  }

  private async fetchPages<T>(path: string, token: string, params: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= 20; page++) {
      const payload = await this.request<T[] | { items?: T[] }>(
        pageUrl(`${API_URL}${path}`, { ...params, per_page: 100, page }).slice(API_URL.length),
        token,
      );
      const items = Array.isArray(payload) ? payload : payload.items ?? [];
      values.push(...items);
      if (items.length < 100) break;
    }
    return values;
  }

  private mapRepository(repository: GithubRepository): RemoteRepository {
    const kind = repository.owner.type?.toLowerCase() === 'organization' ? 'organization' : 'user';
    const namespace = mapNamespace(repository.owner.login, kind, 0);
    return {
      id: String(repository.id),
      provider: this.kind,
      host: GITHUB_HOST,
      name: repository.name,
      fullName: repository.full_name,
      cloneUrl: repository.clone_url,
      webUrl: repository.html_url,
      defaultBranch: repository.default_branch ?? undefined,
      namespace,
      private: repository.private,
    };
  }

  private parseRepositoryUrl(value: string): { owner: string; name: string } | undefined {
    try {
      const url = new URL(value);
      if (!isSameHost(url, GITHUB_HOST)) return undefined;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length < 2) return undefined;
      return { owner: parts[0], name: parts[1].replace(/\.git$/, '') };
    } catch {
      return undefined;
    }
  }
}
