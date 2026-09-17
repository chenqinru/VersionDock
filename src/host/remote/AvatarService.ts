import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import type { GitHubRemoteProvider } from './GitHubRemoteProvider';
import type { GitLabRemoteProvider } from './GitLabRemoteProvider';
import type { GiteeRemoteProvider } from './GiteeRemoteProvider';

const AVATAR_CACHE_KEY = 'versiondock.remote.avatar.cache.v4';
const POSITIVE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_CACHE_TTL = 24 * 60 * 60 * 1000;      // 24 hours
const MAX_CACHE_ENTRIES = 2000;

interface CacheEntry {
  url: string | null;
  timestamp: number;
}

function extractHostname(urlOrHost: string): string | undefined {
  if (!urlOrHost) return undefined;
  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlOrHost)) {
      return new URL(urlOrHost).hostname.toLowerCase();
    }
    const sshMatch = /^(?:[\w.-]+@)?([\w.-]+)(?::\d+)?(?::|\/)/.exec(urlOrHost);
    if (sshMatch && sshMatch[1]) {
      return sshMatch[1].toLowerCase();
    }
    return new URL(`http://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isOfficialGitLabHost(urlOrHost: string | undefined): boolean {
  if (!urlOrHost) return false;
  const hostname = extractHostname(urlOrHost);
  if (!hostname) return false;
  return hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com');
}

function resolveSingleUrlPlatform(
  url: string,
  knownGitlabHosts: string[],
): 'github' | 'gitlab' | 'gitee' | 'generic' {
  const hostname = extractHostname(url);
  if (!hostname) return 'generic';

  // 1. 优先匹配已知/已连接的 GitLab 主机域名（自建私有 GitLab）
  for (const host of knownGitlabHosts) {
    const h = extractHostname(host);
    if (h && (hostname === h || hostname.endsWith(`.${h}`))) {
      return 'gitlab';
    }
  }

  // 2. 匹配公有云域名
  if (hostname === 'github.com' || hostname.endsWith('.github.com')) return 'github';
  if (hostname === 'gitee.com' || hostname.endsWith('.gitee.com')) return 'gitee';
  if (hostname === 'gitlab.com' || hostname.endsWith('.gitlab.com')) return 'gitlab';

  return 'generic';
}

export class AvatarService implements vscode.Disposable {
  private memoryCache = new Map<string, CacheEntry>();
  private inFlight = new Map<string, Promise<string | null>>();
  private localAvatarDownloads = new Map<string, Promise<void>>();
  private saveDebounceTimer?: NodeJS.Timeout;
  private cacheEpoch = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly github: GitHubRemoteProvider,
    private readonly gitlab: GitLabRemoteProvider,
    private readonly gitee: GiteeRemoteProvider,
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

      // 如果当前 v3 缓存为空，尝试向后兼容迁移 v2 及更早版本的缓存，防止用户切版本后头像全部失效
      if (this.memoryCache.size === 0) {
        this.migrateLegacyCaches(now);
      }
    } catch (error) {
      this.logger.debug('AvatarService', 'Failed to load avatar cache from globalState', { error: String(error) });
    }
  }

  private migrateLegacyCaches(now: number): void {
    try {
      const legacyV2 = this.context.globalState.get<Record<string, CacheEntry>>('versiondock.remote.avatar.cache.v2');
      const legacyV1 = this.context.globalState.get<Record<string, CacheEntry | string>>('versiondock.remote.avatar.cache');
      const candidates = legacyV2 || legacyV1;
      if (!candidates || typeof candidates !== 'object') return;

      let migratedCount = 0;
      for (const [emailOrKey, entryOrUrl] of Object.entries(candidates)) {
        let url: string | null = null;
        let timestamp = now;
        if (typeof entryOrUrl === 'string') {
          url = entryOrUrl;
        } else if (entryOrUrl && typeof entryOrUrl === 'object') {
          url = (entryOrUrl as CacheEntry).url ?? null;
          timestamp = (entryOrUrl as CacheEntry).timestamp || now;
        }

        const normalizedEmail = emailOrKey.includes(':') ? emailOrKey.split(':')[1] : emailOrKey.toLowerCase();
        if (!normalizedEmail) continue;

        let platform = 'generic';
        if (url) {
          if (/gitee\.com/i.test(url)) platform = 'gitee';
          else if (/githubusercontent\.com/i.test(url)) platform = 'github';
          else if (/gitlab/i.test(url)) platform = 'gitlab';
        }

        const newKey = `${platform}:${normalizedEmail}`;
        if (!this.memoryCache.has(newKey)) {
          this.memoryCache.set(newKey, { url, timestamp });
          migratedCount++;
        }
      }

      if (migratedCount > 0) {
        this.logger.debug('AvatarService', `Successfully migrated ${migratedCount} avatars from legacy cache`);
        this.scheduleSave(true);
      }
    } catch {
      // Ignore migration errors
    }
  }

  public flushSync(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
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
      this.logger.debug('AvatarService', 'Failed to flush avatar cache to globalState', { error: String(error) });
    }
  }

  public scheduleSave(immediate = false): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
    if (immediate) {
      this.flushSync();
      return;
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.saveDebounceTimer = undefined;
      this.flushSync();
    }, 400);
  }

  public dispose(): void {
    this.flushSync();
  }

  private getPlatformScope(repoRemotes: string[]): string {
    if (repoRemotes.length === 0) return 'generic';

    const globalHosts = this.context.globalState.get<string[]>('versiondock.remote.gitlab.hosts', []);
    const configHosts = vscode.workspace.getConfiguration('versiondock').get<string[]>('remote.gitlab.hosts', []);
    const knownGitlabHosts = Array.from(new Set([...globalHosts, ...configHosts]));

    // 优先从第 0 个 remote（主远程）判定平台，防止次要/上游远程篡改主平台作用域
    const primaryUrl = repoRemotes[0];
    const primaryPlatform = resolveSingleUrlPlatform(primaryUrl, knownGitlabHosts);
    if (primaryPlatform !== 'generic') {
      if (primaryPlatform === 'gitlab') {
        const host = extractHostname(primaryUrl);
        return host ? `gitlab:${host}` : 'gitlab';
      }
      return primaryPlatform;
    }

    // 若主远程未能明确识别，再检查其余 remotes
    for (let i = 1; i < repoRemotes.length; i++) {
      const p = resolveSingleUrlPlatform(repoRemotes[i], knownGitlabHosts);
      if (p !== 'generic') {
        if (p === 'gitlab') {
          const host = extractHostname(repoRemotes[i]);
          return host ? `gitlab:${host}` : 'gitlab';
        }
        return p;
      }
    }

    return 'generic';
  }

  private getValidCacheEntry(normalized: string, platform: string, now: number): CacheEntry | undefined {
    const cacheKey = `${platform}:${normalized}`;
    let cached = this.memoryCache.get(cacheKey);

    if (!cached) {
      const genericCached = this.memoryCache.get(`generic:${normalized}`);
      if (platform === 'generic') {
        if (genericCached && genericCached.url) {
          cached = genericCached;
        } else {
          for (const p of ['github', 'gitee', 'gitlab', 'gitlab:gitlab.com']) {
            const tryCached = this.memoryCache.get(`${p}:${normalized}`);
            if (tryCached && tryCached.url) {
              cached = tryCached;
              break;
            }
          }
        }
      } else if (
        platform === 'github' ||
        platform === 'gitee' ||
        platform === 'gitlab' ||
        platform === 'gitlab:gitlab.com'
      ) {
        if (genericCached && genericCached.url) {
          cached = genericCached;
        }
      }
      // 注意：私有自建 GitLab 实例（如 gitlab:internal.company.com）严禁跨实例或从通用缓存回退，保证数据隔离
    }

    if (!cached) return undefined;
    const ttl = cached.url ? POSITIVE_CACHE_TTL : NEGATIVE_CACHE_TTL;
    return now - cached.timestamp < ttl ? cached : undefined;
  }

  getCachedAvatars(emails: string[], repoRemotes: string[] = []): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    const platform = this.getPlatformScope(repoRemotes);
    const now = Date.now();
    for (const email of emails) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;
      const entry = this.getValidCacheEntry(normalized, platform, now);
      if (entry !== undefined) {
        result[normalized] = entry.url;
      }
    }
    return result;
  }

  async resolveAvatars(
    emails: string[],
    repoRemotes: string[] = [],
    authors?: Record<string, string> | Array<{ name?: string; email: string }>,
  ): Promise<Record<string, string | null>> {
    const resolveEpoch = this.cacheEpoch;
    const result: Record<string, string | null> = {};
    const pending: Array<{ email: string; cacheKey: string }> = [];

    const authorsMap: Record<string, string> = {};
    if (Array.isArray(authors)) {
      for (const a of authors) {
        if (a.name && a.email) authorsMap[a.email.trim().toLowerCase()] = a.name.trim();
      }
    } else if (authors) {
      Object.assign(authorsMap, authors);
    }

    const platform = this.getPlatformScope(repoRemotes);
    const now = Date.now();
    for (const email of emails) {
      const normalized = email.trim().toLowerCase();
      if (!normalized) continue;

      const authorName = authorsMap[normalized];
      const entry = this.getValidCacheEntry(normalized, platform, now);
      if (entry !== undefined) {
        if (entry.url !== null || !authorName) {
          result[normalized] = entry.url;
          continue;
        }
      }
      pending.push({ email: normalized, cacheKey: `${platform}:${normalized}` });
    }

    if (pending.length === 0) {
      return result;
    }

    const concurrency = 4;
    for (let i = 0; i < pending.length; i += concurrency) {
      const chunk = pending.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(async item => {
          const authorName = authorsMap[item.email];
          const url = await this.resolveSingleAvatar(item.email, repoRemotes, authorName, platform);
          if (resolveEpoch !== this.cacheEpoch) return;
          result[item.email] = url;
          this.memoryCache.set(item.cacheKey, { url, timestamp: Date.now() });
        }),
      );
    }

    if (resolveEpoch !== this.cacheEpoch) return {};
    this.scheduleSave();
    return result;
  }

  private async resolveSingleAvatar(
    email: string,
    repoRemotes: string[],
    authorName?: string,
    platform = 'generic',
  ): Promise<string | null> {
    const inFlightKey = `${platform}:${email.trim().toLowerCase()}`;
    const inFlightPromise = this.inFlight.get(inFlightKey);
    if (inFlightPromise) return inFlightPromise;

    const promise = this.doResolveSingleAvatar(email, repoRemotes, authorName, platform).catch(error => {
      this.logger.debug('AvatarService', 'Error resolving avatar for email', { email, error: String(error) });
      return null;
    });
    this.inFlight.set(inFlightKey, promise);
    void promise.finally(() => {
      // A cache clear may remove this promise and start a fresh request for
      // the same key. The stale request must not delete the new one.
      if (this.inFlight.get(inFlightKey) === promise) {
        this.inFlight.delete(inFlightKey);
      }
    });
    return promise;
  }

  private async doResolveSingleAvatar(
    email: string,
    repoRemotes: string[],
    authorName?: string,
    platform = 'generic',
  ): Promise<string | null> {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return null;

    const gitlabAccounts = await this.gitlab.getAllAccounts().catch(() => []);
    const gitlabHost = this.resolveGitLabHost(repoRemotes, gitlabAccounts);

    // 构建级联查询优先级队列：
    // 1. 主作用域平台（platform，如 gitlab:host 归为 gitlab）
    // 2. 当前仓库其他关联远程平台（Secondary Remotes，如 gitee / github）
    // 3. 其他已连接或支持的平台（仅在显式配置 crossPlatformFallback 时回退）
    const platformQueue: Array<'gitlab' | 'gitee' | 'github'> = [];

    const basePlatform = platform.startsWith('gitlab') ? 'gitlab' : platform;
    if (basePlatform === 'gitlab' || basePlatform === 'gitee' || basePlatform === 'github') {
      platformQueue.push(basePlatform);
    }

    // 收集关联远程对应的平台
    const globalHosts = this.context.globalState.get<string[]>('versiondock.remote.gitlab.hosts', []);
    const configHosts = vscode.workspace.getConfiguration('versiondock').get<string[]>('remote.gitlab.hosts', []);
    const knownHosts = [...globalHosts, ...configHosts, ...gitlabAccounts.map(a => a.host)];

    for (const remote of repoRemotes) {
      const p = resolveSingleUrlPlatform(remote, knownHosts);
      if (p !== 'generic' && !platformQueue.includes(p)) {
        platformQueue.push(p);
      }
    }

    // 默认仅查询仓库关联平台。仅在用户明确启用跨平台回退（opt-in）时，才尝试其他受支持平台
    const allowCrossPlatformFallback = vscode.workspace
      .getConfiguration('versiondock')
      .get<boolean>('avatar.crossPlatformFallback', false);

    if (allowCrossPlatformFallback) {
      for (const p of ['gitlab', 'gitee', 'github'] as const) {
        if (!platformQueue.includes(p)) {
          platformQueue.push(p);
        }
      }
    }

    // 如果没有任何关联平台且用户未允许跨平台回退，不主动向任何外部平台发起查询，保护隐私
    if (platformQueue.length === 0) {
      return null;
    }

    // 按优先级顺序级联查询
    for (const targetPlatform of platformQueue) {
      if (targetPlatform === 'gitlab') {
        const gitlabUrl = await this.gitlab.resolveAvatarByEmail(gitlabHost, trimmedEmail, authorName);
        if (gitlabUrl) {
          return await this.handleGitLabAvatar(gitlabHost, gitlabUrl);
        }
      } else if (targetPlatform === 'gitee') {
        const giteeUrl = await this.gitee.resolveAvatarByEmail(trimmedEmail, authorName);
        if (giteeUrl) return giteeUrl;
      } else if (targetPlatform === 'github') {
        const githubUrl = await this.github.resolveAvatarByEmail(trimmedEmail, authorName);
        if (githubUrl) return githubUrl;
      }
    }

    // Gravatar 属于第三方公网服务。为严格保护私有仓库（包括私有 GitHub/Gitee/GitLab 仓库）
    // 的员工邮箱隐私，仅在用户明确开启跨平台回退（opt-in）时才查询 Gravatar
    if (allowCrossPlatformFallback) {
      return await this.checkGravatar(trimmedEmail);
    }
    return null;
  }

  private resolveGitLabHost(repoRemotes: string[], gitlabAccounts: Array<{ host: string }>): string | undefined {
    // 1. 优先从 repoRemotes 中匹配已连接 GitLab 账号的主机（精准识别自建私有 GitLab）
    for (const remote of repoRemotes) {
      const remoteHostname = extractHostname(remote);
      if (!remoteHostname) continue;
      for (const acc of gitlabAccounts) {
        const accHostname = extractHostname(acc.host);
        if (accHostname && (remoteHostname === accHostname || remoteHostname.endsWith(`.${accHostname}`))) {
          return acc.host;
        }
      }
    }

    // 2. 匹配设置中配置的自定义 hosts
    const globalHosts = this.context.globalState.get<string[]>('versiondock.remote.gitlab.hosts', []);
    const configHosts = vscode.workspace.getConfiguration('versiondock').get<string[]>('remote.gitlab.hosts', []);
    for (const remote of repoRemotes) {
      const remoteHostname = extractHostname(remote);
      if (!remoteHostname) continue;
      for (const host of [...globalHosts, ...configHosts]) {
        const h = extractHostname(host);
        if (h && (remoteHostname === h || remoteHostname.endsWith(`.${h}`))) {
          return host;
        }
      }
    }

    // 3. 检查是否有包含 gitlab 关键字的 remote
    for (const remote of repoRemotes) {
      const h = extractHostname(remote);
      if (h && (h === 'gitlab.com' || h.endsWith('.gitlab.com') || /gitlab/i.test(h))) {
        return `https://${h}`;
      }
    }

    // 4. 回退为第一个已连接的 GitLab 账号的主机，或默认 https://gitlab.com
    return gitlabAccounts[0]?.host || 'https://gitlab.com';
  }

  private async handleGitLabAvatar(host: string | undefined, avatarUrl: string): Promise<string> {
    try {
      const avatarOrigin = new URL(avatarUrl).origin;
      const targetHost = host || avatarOrigin;
      if (!isOfficialGitLabHost(avatarOrigin)) {
        const dataUrl = await this.gitlab.fetchAuthenticatedImage(targetHost, avatarUrl);
        if (dataUrl) return dataUrl;
      }
    } catch {
      // Keep direct URL if parsing or proxy fails
    }
    return avatarUrl;
  }

  private async checkGravatar(email: string): Promise<string | null> {
    try {
      const hash = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
      const testUrl = `https://gravatar.com/avatar/${hash}?d=404&s=40`;
      const res = await fetch(testUrl, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
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

      let download = this.localAvatarDownloads.get(filePath);
      if (!download) {
        const downloadEpoch = this.cacheEpoch;
        download = this.fetchAndSaveAvatar(avatarUrl, filePath, downloadEpoch);
        this.localAvatarDownloads.set(filePath, download);
        void download.finally(() => {
          if (this.localAvatarDownloads.get(filePath) === download) {
            this.localAvatarDownloads.delete(filePath);
          }
        });
      }

      // QuickPick 已显示后不会自动刷新 iconPath。首次未命中时等待这批头像
      // 并行下载完成，使当前这次菜单打开就能显示；下载自身带超时，失败仍降级为平台图标。
      await download;
      return fs.existsSync(filePath) ? vscode.Uri.file(filePath) : undefined;
    } catch (error) {
      this.logger.debug('AvatarService', 'Failed to get local avatar uri', { avatarUrl, error: String(error) });
      return undefined;
    }
  }

  private async fetchAndSaveAvatar(avatarUrl: string, filePath: string, cacheEpoch: number): Promise<void> {
    try {
      let res: Response | undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        res = await fetch(avatarUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!res || !res.ok) {
        try {
          const origin = new URL(avatarUrl).origin;
          const dataUrl = await this.gitlab.fetchAuthenticatedImage(origin, avatarUrl);
          if (dataUrl) {
            const comma = dataUrl.indexOf(',');
            if (comma !== -1 && cacheEpoch === this.cacheEpoch) {
              fs.writeFileSync(filePath, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
            }
          }
        } catch {
          // ignore
        }
        return;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (cacheEpoch === this.cacheEpoch) {
        fs.writeFileSync(filePath, buffer);
      }
    } catch {
      // ignore
    }
  }


  clearCacheForPlatform(platform: 'github' | 'gitee' | 'gitlab'): void {
    this.cacheEpoch++;
    const prefix = `${platform}:`;
    let changed = false;
    for (const key of Array.from(this.memoryCache.keys())) {
      if (key.startsWith(prefix)) {
        this.memoryCache.delete(key);
        changed = true;
      }
    }
    for (const key of Array.from(this.inFlight.keys())) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    if (platform === 'gitee') {
      this.gitee.clearCache();
    }
    if (changed) {
      this.scheduleSave(true);
    }
  }

  clearCache(): void {
    this.cacheEpoch++;
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = undefined;
    }
    this.memoryCache.clear();
    this.inFlight.clear();
    this.localAvatarDownloads.clear();
    this.gitee.clearCache();
    void this.context.globalState.update(AVATAR_CACHE_KEY, {});
    try {
      fs.rmSync(path.join(this.context.globalStorageUri.fsPath, 'avatars'), { recursive: true, force: true });
    } catch (error) {
      this.logger.debug('AvatarService', 'Failed to clear local avatar files', { error: String(error) });
    }
  }
}
