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
