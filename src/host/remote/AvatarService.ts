import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import type { GitHubRemoteProvider } from './GitHubRemoteProvider';
import type { GitLabRemoteProvider } from './GitLabRemoteProvider';

const AVATAR_CACHE_KEY = 'versiondock.remote.avatar.cache';
const POSITIVE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_CACHE_TTL = 24 * 60 * 60 * 1000;      // 24 hours
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  url: string | null;
  timestamp: number;
}

export class AvatarService {
  private memoryCache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string | null>>();
  private saveDebounceTimer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly github: GitHubRemoteProvider,
    private readonly gitlab: GitLabRemoteProvider,
    private readonly logger: VersionDockLogger,
  ) {
    this.loadFromGlobalState();
  }

  private loadFromGlobalState(): void {
    try {
      const persisted = this.context.globalState.get<Record<string, CacheEntry>>(AVATAR_CACHE_KEY, {});
      const now = Date.now();
      for (const [key, entry] of Object.entries(persisted)) {
        const ttl = entry.url ? POSITIVE_CACHE_TTL : NEGATIVE_CACHE_TTL;
        if (now - entry.timestamp < ttl) {
          this.memoryCache.set(key, entry);
        }
      }
    } catch (error) {
      this.logger.debug('AvatarService', 'Failed to load avatar cache from globalState', { error: String(error) });
    }
  }

  private scheduleSave(): void {
    if (this.saveDebounceTimer) clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      try {
        if (this.memoryCache.size > MAX_CACHE_ENTRIES) {
          const entries = Array.from(this.memoryCache.entries())
            .sort((a, b) => b[1].timestamp - a[1].timestamp)
            .slice(0, MAX_CACHE_ENTRIES);
          this.memoryCache = new Map(entries);
        }
        const obj: Record<string, CacheEntry> = {};
        for (const [k, v] of this.memoryCache.entries()) {
          obj[k] = v;
        }
        void this.context.globalState.update(AVATAR_CACHE_KEY, obj);
      } catch (error) {
        this.logger.debug('AvatarService', 'Failed to save avatar cache to globalState', { error: String(error) });
      }
    }, 2000);
  }

  async resolveAvatars(
    emails: string[],
    repoRemotes: string[] = [],
    authorsMap?: Record<string, string>,
  ): Promise<Record<string, string | null>> {
    const result: Record<string, string | null> = {};
    const pending: string[] = [];

    const now = Date.now();
    for (const email of emails) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;

      const cached = this.memoryCache.get(normalized);
      const authorName = authorsMap?.[normalized];
      if (cached && cached.url) {
        if (now - cached.timestamp < POSITIVE_CACHE_TTL) {
          result[normalized] = cached.url;
          continue;
        }
      } else if (cached && !cached.url && !authorName) {
        if (now - cached.timestamp < NEGATIVE_CACHE_TTL) {
          result[normalized] = null;
          continue;
        }
      }
      pending.push(normalized);
    }

    if (pending.length === 0) {
      return result;
    }

    const concurrency = 4;
    for (let i = 0; i < pending.length; i += concurrency) {
      const chunk = pending.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async email => {
          const authorName = authorsMap?.[email];
          const url = await this.resolveSingleAvatar(email, repoRemotes, authorName);
          result[email] = url;
          this.memoryCache.set(email, { url, timestamp: Date.now() });
        }),
      );
    }

    this.scheduleSave();
    return result;
  }

  private async resolveSingleAvatar(email: string, repoRemotes: string[], authorName?: string): Promise<string | null> {
    const inFlightPromise = this.inFlight.get(email);
    if (inFlightPromise) return inFlightPromise;

    const promise = (async (): Promise<string | null> => {
      try {
        return await this.doResolveSingleAvatar(email, repoRemotes, authorName);
      } catch (error) {
        this.logger.debug('AvatarService', 'Error resolving avatar for email', { email, error: String(error) });
        return null;
      } finally {
        this.inFlight.delete(email);
      }
    })();

    this.inFlight.set(email, promise);
    return promise;
  }

  private async doResolveSingleAvatar(email: string, repoRemotes: string[], authorName?: string): Promise<string | null> {
    const norm = email.trim().toLowerCase();
    const cleanAuthorName = (authorName ?? '').trim().toLowerCase();
    const emailPrefix = norm.includes('@') ? norm.split('@')[0]! : norm;
    const strippedPrefix = emailPrefix.replace(/\d+$/, '');

    // 0. Fast-path: Check authenticated GitHub user
    try {
      const ghUser = await this.github.getAuthenticatedUser();
      if (ghUser?.avatar_url) {
        const ghLogin = ghUser.login.toLowerCase();
        const ghName = ghUser.name?.toLowerCase();
        const ghEmail = ghUser.email?.toLowerCase();
        const authorMatch = cleanAuthorName && (cleanAuthorName === ghLogin || cleanAuthorName === ghName);
        const emailMatch =
          (ghEmail && ghEmail === norm) ||
          ghLogin === norm ||
          ghLogin === emailPrefix ||
          (strippedPrefix.length >= 3 && strippedPrefix === ghLogin) ||
          (ghName && (ghName === norm || ghName === emailPrefix));
        if (authorMatch || emailMatch) {
          return ghUser.avatar_url;
        }
      }
    } catch {
      // Ignore
    }

    // 0.1 Fast-path: Check authenticated GitLab users
    try {
      const glAccounts = await this.gitlab.getAllAccounts();
      for (const acc of glAccounts) {
        const glUser = await this.gitlab.getCurrentUser(acc.host);
        if (glUser?.avatar_url) {
          let avatarUrl = glUser.avatar_url;
          if (avatarUrl.startsWith('/')) avatarUrl = `${acc.host}${avatarUrl}`;
          const glUsername = glUser.username.toLowerCase();
          const glName = glUser.name?.toLowerCase();
          const glEmail = glUser.email?.toLowerCase();
          const authorMatch = cleanAuthorName && (cleanAuthorName === glUsername || cleanAuthorName === glName);
          const emailMatch =
            (glEmail && glEmail === norm) ||
            glUsername === norm ||
            glUsername === emailPrefix ||
            (strippedPrefix.length >= 3 && strippedPrefix === glUsername) ||
            (glName && (glName === norm || glName === emailPrefix));
          if (authorMatch || emailMatch) {
            return this.handleGitLabAvatar(acc.host, avatarUrl);
          }
        }
      }
    } catch {
      // Ignore
    }

    // 1. Fast-path: GitHub noreply email
    if (email.endsWith('@users.noreply.github.com')) {
      const local = email.split('@')[0] ?? '';
      const username = local.includes('+') ? local.split('+')[1] : local;
      if (username) return `https://avatars.githubusercontent.com/${encodeURIComponent(username)}`;
    }

    // 2. Fast-path: GitLab noreply email
    if (email.endsWith('@users.noreply.gitlab.com') || email.endsWith('@noreply.gitlab.com')) {
      const local = email.split('@')[0] ?? '';
      const username = local.includes('-') ? local.split('-').slice(1).join('-') : local;
      if (username) {
        const gitlabUrl = await this.gitlab.resolveAvatarByEmail('https://gitlab.com', email);
        if (gitlabUrl) return gitlabUrl;
      }
    }

    // 3. Fast-path: Gitee noreply email
    if (email.endsWith('@user.noreply.gitee.com') || email.endsWith('@noreply.gitee.com')) {
      const local = email.split('@')[0] ?? '';
      const candidate = local.includes('+') ? local.split('+')[1] : local.includes('_') ? local.split('_').slice(1).join('_') : local;
      if (candidate) {
        const giteeUrl = await this.resolveGiteeAvatar(candidate);
        if (giteeUrl) return giteeUrl;
      }
    }

    const isGitHubRepo = repoRemotes.some(r => /github\.com/i.test(r));
    const matchedGitLabRemote = repoRemotes.find(r => !/github\.com/i.test(r));

    let matchedGitLabHost: string | undefined;
    if (matchedGitLabRemote) {
      try {
        const url = new URL(matchedGitLabRemote.startsWith('git@')
          ? `https://${matchedGitLabRemote.slice(4).replace(':', '/')}`
          : matchedGitLabRemote);
        matchedGitLabHost = url.origin;
      } catch {
        // Ignore parsing failure
      }
    }

    // Dynamic routing:
    if (isGitHubRepo) {
      const githubUrl = await this.github.resolveAvatarByEmail(email, authorName);
      if (githubUrl) return githubUrl;

      const gitlabUrl = await this.gitlab.resolveAvatarByEmail(matchedGitLabHost, email, authorName);
      if (gitlabUrl) return this.handleGitLabAvatar(matchedGitLabHost, gitlabUrl);
    } else if (matchedGitLabHost) {
      const gitlabUrl = await this.gitlab.resolveAvatarByEmail(matchedGitLabHost, email, authorName);
      if (gitlabUrl) return this.handleGitLabAvatar(matchedGitLabHost, gitlabUrl);

      const githubUrl = await this.github.resolveAvatarByEmail(email, authorName);
      if (githubUrl) return githubUrl;
    } else {
      // Remote remotes empty or unknown: check GitLab first if any account configured
      const accounts = await this.gitlab.getAllAccounts();
      for (const acc of accounts) {
        const gitlabUrl = await this.gitlab.resolveAvatarByEmail(acc.host, email, authorName);
        if (gitlabUrl) return this.handleGitLabAvatar(acc.host, gitlabUrl);
      }

      const githubUrl = await this.github.resolveAvatarByEmail(email, authorName);
      if (githubUrl) return githubUrl;
    }

    // 3. Fallback to Gravatar check
    const gravatarUrl = await this.checkGravatar(email);
    if (gravatarUrl) return gravatarUrl;

    return null;
  }

  private async handleGitLabAvatar(host: string | undefined, avatarUrl: string): Promise<string> {
    try {
      const avatarOrigin = new URL(avatarUrl).origin;
      const targetHost = host || avatarOrigin;
      if (!avatarOrigin.includes('gitlab.com')) {
        const dataUrl = await this.gitlab.fetchAuthenticatedImage(targetHost, avatarUrl);
        if (dataUrl) return dataUrl;
      }
    } catch {
      // Keep direct URL if parsing or proxy fails
    }
    return avatarUrl;
  }

  private async resolveGiteeAvatar(username: string): Promise<string | null> {
    try {
      const res = await fetch(`https://gitee.com/api/v5/users/${encodeURIComponent(username)}`);
      if (!res.ok) return null;
      const data = await res.json() as { avatar_url?: string };
      if (data.avatar_url && !data.avatar_url.includes('no_portrait.png')) {
        return data.avatar_url;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  private async checkGravatar(email: string): Promise<string | null> {
    try {
      const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
      const testUrl = `https://gravatar.com/avatar/${hash}?d=404&s=40`;
      const res = await fetch(testUrl, { method: 'HEAD' });
      if (res.ok) {
        return `https://gravatar.com/avatar/${hash}?d=404`;
      }
    } catch {
      // Network failure or 404
    }
    return null;
  }

  async getLocalAvatarUri(avatarUrl: string | undefined): Promise<vscode.Uri | undefined> {
    if (!avatarUrl) return undefined;
    try {
      const storageDir = path.join(this.context.globalStorageUri.fsPath, 'avatars');
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }

      const hash = crypto.createHash('sha256').update(avatarUrl).digest('hex').slice(0, 16);
      const filePath = path.join(storageDir, `${hash}.png`);

      if (fs.existsSync(filePath)) {
        return vscode.Uri.file(filePath);
      }

      if (avatarUrl.startsWith('data:')) {
        const commaIdx = avatarUrl.indexOf(',');
        if (commaIdx !== -1) {
          const base64Data = avatarUrl.slice(commaIdx + 1);
          fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));
          return vscode.Uri.file(filePath);
        }
      }

      // Fetch from remote
      let res: Response | undefined;
      try {
        res = await fetch(avatarUrl);
      } catch {
        res = undefined;
      }

      if (!res || !res.ok) {
        // Try proxying if it belongs to GitLab
        try {
          const origin = new URL(avatarUrl).origin;
          const dataUrl = await this.gitlab.fetchAuthenticatedImage(origin, avatarUrl);
          if (dataUrl) {
            const comma = dataUrl.indexOf(',');
            if (comma !== -1) {
              fs.writeFileSync(filePath, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
              return vscode.Uri.file(filePath);
            }
          }
        } catch {
          // Ignore
        }
        return undefined;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      return vscode.Uri.file(filePath);
    } catch (error) {
      this.logger.debug('AvatarService', 'Failed to get local avatar uri', { avatarUrl, error: String(error) });
      return undefined;
    }
  }

  clearCache(): void {
    this.memoryCache.clear();
    void this.context.globalState.update(AVATAR_CACHE_KEY, {});
  }
}
