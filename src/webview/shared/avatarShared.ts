import { useEffect, useState } from 'react';
import type { RemoteAccountInfo } from '../../host/types/messages';

export function isAccountCompatibleWithRepo(
  acc: RemoteAccountInfo,
  repoRemoteUrl?: string | string[]
): boolean {
  const remotes = repoRemoteUrl
    ? (Array.isArray(repoRemoteUrl) ? repoRemoteUrl : [repoRemoteUrl])
    : [];
  const lowerRemotes = remotes.map(r => r.toLowerCase());
  const isGitHubRepo = lowerRemotes.some(r => r.includes('github.com') || r.includes('github'));
  const isGiteeRepo = lowerRemotes.some(r => r.includes('gitee.com') || r.includes('gitee'));
  let isGitLabRepo = lowerRemotes.some(r => r.includes('gitlab'));

  if (!isGitLabRepo && acc.provider === 'gitlab' && acc.host) {
    try {
      const parsedHost = new URL(acc.host).hostname.toLowerCase();
      if (parsedHost && lowerRemotes.some(r => r.includes(parsedHost))) {
        isGitLabRepo = true;
      }
    } catch {
      // Ignore URL parse error
    }
  }

  if (acc.provider === 'github') return isGitHubRepo;
  if (acc.provider === 'gitee') return isGiteeRepo;
  if (acc.provider === 'gitlab') return isGitLabRepo;
  return false;
}

/**
 * Checks whether an author matches any connected remote account (GitHub, GitLab or Gitee)
 * based on username, name, emails, or email prefix patterns.
 */
export function findConnectedAvatar(
  authorName: string,
  authorEmail: string,
  remoteAccounts: RemoteAccountInfo[],
  repoRemoteUrl?: string | string[]
): string | null {
  if (!remoteAccounts || remoteAccounts.length === 0) return null;

  const compatibleAccounts = remoteAccounts.filter(acc => isAccountCompatibleWithRepo(acc, repoRemoteUrl));
  if (compatibleAccounts.length === 0) return null;

  // 在多远程场景下，优先匹配当前仓库排在第 0 位的主远程平台账号
  const remotes = repoRemoteUrl
    ? (Array.isArray(repoRemoteUrl) ? repoRemoteUrl : [repoRemoteUrl])
    : [];
  const primaryRemote = remotes[0]?.toLowerCase() || '';

  compatibleAccounts.sort((a, b) => {
    let aPrimary = false;
    let bPrimary = false;
    try {
      if (a.host && primaryRemote.includes(new URL(a.host).hostname.toLowerCase())) aPrimary = true;
      if (b.host && primaryRemote.includes(new URL(b.host).hostname.toLowerCase())) bPrimary = true;
    } catch {
      // ignore
    }
    if (a.provider === 'gitee' && primaryRemote.includes('gitee')) aPrimary = true;
    if (b.provider === 'gitee' && primaryRemote.includes('gitee')) bPrimary = true;
    if (a.provider === 'github' && primaryRemote.includes('github')) aPrimary = true;
    if (b.provider === 'github' && primaryRemote.includes('github')) bPrimary = true;
    if (aPrimary && !bPrimary) return -1;
    if (!aPrimary && bPrimary) return 1;
    return 0;
  });

  const cleanName = (authorName || '').trim().toLowerCase();
  const cleanEmail = (authorEmail || '').trim().toLowerCase();
  const emailPrefix = cleanEmail.includes('@') ? cleanEmail.split('@')[0]! : cleanEmail;
  const strippedEmailPrefix = emailPrefix.replace(/\d+$/, '');
  const strippedName = cleanName.replace(/\d+$/, '');

  for (const acc of compatibleAccounts) {
    if (!acc.avatarUrl) continue;
    const username = (acc.username || '').trim().toLowerCase();
    const displayName = (acc.name || '').trim().toLowerCase();
    const emails = (acc.emails || []).map(e => e.trim().toLowerCase());

    if (cleanName && cleanName === username) return acc.avatarUrl;
    if (cleanName && displayName && cleanName === displayName) return acc.avatarUrl;
    if (cleanEmail && emails.includes(cleanEmail)) return acc.avatarUrl;
    if (emailPrefix && emailPrefix === username) return acc.avatarUrl;
    if (strippedEmailPrefix.length >= 3 && strippedEmailPrefix === username) return acc.avatarUrl;
    if (strippedName.length >= 3 && strippedName === username) return acc.avatarUrl;
    if (displayName && strippedName.length >= 3 && strippedName === displayName.replace(/\d+$/, '')) {
      return acc.avatarUrl;
    }
  }

  return null;
}

export function githubAvatarUrl(email: string, size: number): string | null {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? '';
  const username = local.includes('+') ? local.split('+')[1] : local;
  return username ? `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?size=${size * 2}` : null;
}

function canRenderConnectedAvatarDirectly(
  avatarUrl: string | null,
  remoteAccounts: RemoteAccountInfo[],
): avatarUrl is string {
  if (!avatarUrl) return false;
  if (avatarUrl.startsWith('data:')) return true;

  for (const account of remoteAccounts) {
    if (account.provider !== 'gitlab' || !account.host) continue;
    try {
      const accountHost = new URL(account.host).hostname.toLowerCase();
      const avatarHost = new URL(avatarUrl).hostname.toLowerCase();
      if (accountHost !== 'gitlab.com' && (accountHost === avatarHost || account.avatarUrl === avatarUrl)) {
        // Self-hosted GitLab avatars may require PRIVATE-TOKEN authentication.
        // Let AvatarService proxy them into a data URL instead of rendering the
        // private URL directly in the Webview.
        return false;
      }
    } catch {
      // Fall back to the direct URL when the provider returned a non-standard URL.
    }
  }

  return true;
}

export interface AvatarCacheEntry {
  url: string | null;
  ts: number;
}

export const AVATAR_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 成功头像缓存 24 小时
export const AVATAR_NEGATIVE_TTL_MS = 10 * 60 * 1000; // 失败/未找到缓存 10 分钟，避免临时网络抖动导致永久不可用

export function isAvatarCacheValid(entry: AvatarCacheEntry | undefined, now = Date.now()): entry is AvatarCacheEntry {
  if (!entry) return false;
  const ttl = entry.url !== null ? AVATAR_POSITIVE_TTL_MS : AVATAR_NEGATIVE_TTL_MS;
  return now - entry.ts < ttl;
}

const LOCAL_STORAGE_KEY = 'versiondock.avatar.cache.v3';
const MAX_LOCAL_ENTRIES = 1000;

function loadStorageAvatars(): Map<string, AvatarCacheEntry> {
  const map = new Map<string, AvatarCacheEntry>();
  try {
    // 清理旧版本 v1/v2 无时间戳遗留数据，防止永久架空 Host
    localStorage.removeItem('versiondock.avatar.cache.v1');
    localStorage.removeItem('versiondock.avatar.cache.v2');

    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const now = Date.now();
        for (const [k, v] of Object.entries(parsed)) {
          if (k.includes(':') && typeof v === 'object' && v !== null && 'ts' in v) {
            const potential = v as { url?: unknown; ts?: unknown };
            if (typeof potential.ts === 'number' && (typeof potential.url === 'string' || potential.url === null)) {
              const entry: AvatarCacheEntry = { url: potential.url, ts: potential.ts };
              if (isAvatarCacheValid(entry, now)) {
                map.set(k.toLowerCase(), entry);
              }
            }
          }
        }
      }
    }
  } catch {
    // Ignore parse error
  }
  return map;
}

const hostResolvedAvatars = loadStorageAvatars();
const avatarListeners = new Set<(email: string, url: string | null, repoId?: string) => void>();
const avatarResolutionInFlight = new Set<string>();
const avatarResolutionTimeouts = new Map<string, number>();

export function buildAvatarCacheKey(email: string, scope?: string): string {
  const normEmail = email.trim().toLowerCase();
  const cleanScope = (scope || 'generic').trim().toLowerCase();
  return `${cleanScope}:${normEmail}`;
}

export function getStoredAvatar(email: string, scope?: string): string | null | undefined {
  const normEmail = email.trim().toLowerCase();
  if (!normEmail) return undefined;

  // 若指定了具体仓库作用域（非 generic），必须严格只查当前 scope，
  // 严禁回退到 generic 或无作用域旧键，避免不同仓库之间串用头像
  const cleanScope = scope?.trim().toLowerCase();
  const key = (cleanScope && cleanScope !== 'generic')
    ? `${cleanScope}:${normEmail}`
    : `generic:${normEmail}`;

  const entry = hostResolvedAvatars.get(key);
  if (entry) {
    if (isAvatarCacheValid(entry)) {
      return entry.url;
    }
    // 已过期，从内存中移除
    hostResolvedAvatars.delete(key);
  }
  return undefined;
}

function markAvatarResolutionInFlight(key: string): void {
  avatarResolutionInFlight.add(key);
  const previousTimer = avatarResolutionTimeouts.get(key);
  if (previousTimer !== undefined) window.clearTimeout(previousTimer);
  const timer = window.setTimeout(() => {
    avatarResolutionInFlight.delete(key);
    avatarResolutionTimeouts.delete(key);
  }, 15000);
  avatarResolutionTimeouts.set(key, timer);
}

function releaseAvatarResolution(email: string, repoId?: string): void {
  const key = buildAvatarCacheKey(email, repoId);
  avatarResolutionInFlight.delete(key);
  const timer = avatarResolutionTimeouts.get(key);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    avatarResolutionTimeouts.delete(key);
  }
}

function clearAvatarResolutionsInFlight(): void {
  avatarResolutionInFlight.clear();
  for (const timer of avatarResolutionTimeouts.values()) {
    window.clearTimeout(timer);
  }
  avatarResolutionTimeouts.clear();
}

let saveStorageTimer: number | null = null;
function persistStorageAvatars(): void {
  if (saveStorageTimer !== null) return;
  saveStorageTimer = window.setTimeout(() => {
    saveStorageTimer = null;
    try {
      const now = Date.now();
      for (const [k, entry] of hostResolvedAvatars.entries()) {
        if (!isAvatarCacheValid(entry, now)) {
          hostResolvedAvatars.delete(k);
        }
      }

      if (hostResolvedAvatars.size > MAX_LOCAL_ENTRIES) {
        const entries = Array.from(hostResolvedAvatars.entries()).slice(-MAX_LOCAL_ENTRIES);
        hostResolvedAvatars.clear();
        for (const [k, v] of entries) hostResolvedAvatars.set(k, v);
      }
      const obj: Record<string, { url: string | null; ts: number }> = {};
      for (const [k, entry] of hostResolvedAvatars.entries()) {
        // 私有 GitLab 生成的 data: URL 仅存在于内存，绝不持久化到 localStorage，避免撑爆配额
        if (entry.url && entry.url.startsWith('data:')) continue;
        obj[k] = { url: entry.url, ts: entry.ts };
      }
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // Ignore quota error
    }
  }, 1000);
}

export function notifyAvatarsResolved(avatars: Record<string, string | null>, repoId?: string): void {
  let changed = false;
  const scope = repoId || 'generic';
  const now = Date.now();
  for (const [email, url] of Object.entries(avatars)) {
    const normEmail = email.trim().toLowerCase();
    if (!normEmail) continue;
    releaseAvatarResolution(normEmail, repoId);
    const key = buildAvatarCacheKey(normEmail, scope);
    const current = hostResolvedAvatars.get(key);

    if (!current || current.url !== url || !isAvatarCacheValid(current, now)) {
      hostResolvedAvatars.set(key, { url, ts: now });
      changed = true;
    }
    avatarListeners.forEach(fn => fn(normEmail, url, repoId));
  }
  if (changed) {
    persistStorageAvatars();
  }
}

let avatarCacheEpoch = 0;
const cacheEpochListeners = new Set<() => void>();

export function clearFrontendAvatarCache(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
    localStorage.removeItem('versiondock.avatar.cache.v2');
  } catch {
    // Ignore
  }
  hostResolvedAvatars.clear();
  clearAvatarResolutionsInFlight();
  avatarCacheEpoch++;
  cacheEpochListeners.forEach(fn => fn());
}

export function avatarColor(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = email.charCodeAt(i) + ((hash << 5) - hash);
  }
  return `hsl(${Math.abs(hash) % 360}, 55%, 45%)`;
}

export function formatAuthorIdentity(authorName: string, authorEmail?: string): string {
  const name = authorName.trim();
  const email = (authorEmail ?? '').trim();
  if (name && email) return `${name} <${email}>`;
  return name || email;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    const w = parts[0] ?? '';
    return (w.length > 1 ? w[0] + w[1] : w[0] ?? '?').toUpperCase();
  }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

export function createAvatarResolverQueue(
  sendRequest: (emails: string[], repoId?: string, authors?: Array<{ email: string; name?: string }>) => void
): (email: string, repoId?: string, authorName?: string) => void {
  const pendingBatches = new Map<string, {
    repoId?: string;
    emails: Set<string>;
    authors: Map<string, string>;
  }>();
  let batchTimer: number | null = null;

  return function queueEmailResolution(email: string, repoId?: string, authorName?: string): void {
    const normalized = email.trim().toLowerCase();
    if (!normalized) return;
    const scopedKey = buildAvatarCacheKey(normalized, repoId);
    const entry = hostResolvedAvatars.get(scopedKey);
    if (isAvatarCacheValid(entry)) return;
    if (avatarResolutionInFlight.has(scopedKey)) return;

    markAvatarResolutionInFlight(scopedKey);

    const batchKey = repoId ?? '';
    let batch = pendingBatches.get(batchKey);
    if (!batch) {
      batch = { repoId, emails: new Set<string>(), authors: new Map<string, string>() };
      pendingBatches.set(batchKey, batch);
    }
    batch.emails.add(normalized);
    if (authorName) batch.authors.set(normalized, authorName);
    if (batchTimer === null) {
      batchTimer = window.setTimeout(() => {
        batchTimer = null;
        const batches = Array.from(pendingBatches.values());
        pendingBatches.clear();
        for (const pending of batches) {
          if (pending.emails.size === 0) continue;
          const emails = Array.from(pending.emails);
          const authors = emails.map(e => ({ email: e, name: pending.authors.get(e) }));
          sendRequest(emails, pending.repoId, authors);
        }
      }, 60);
    }
  };
}

export interface UseResolvedAvatarOptions {
  authorName: string;
  authorEmail?: string;
  repoId?: string;
  size?: number;
  remoteAccounts?: RemoteAccountInfo[];
  repoRemoteUrl?: string | string[];
  queueResolution: (email: string, repoId?: string, authorName?: string) => void;
}

export function useResolvedAvatar(options: UseResolvedAvatarOptions) {
  const { authorName, authorEmail = '', repoId, size = 16, remoteAccounts = [], repoRemoteUrl, queueResolution } = options;

  const normalizedEmail = authorEmail.trim().toLowerCase();
  const cleanName = authorName.trim();

  // 1. Instant match for connected accounts (GitHub, GitLab, Gitee)
  const connectedAvatar = findConnectedAvatar(cleanName, authorEmail, remoteAccounts, repoRemoteUrl);
  const directConnectedAvatar = canRenderConnectedAvatarDirectly(connectedAvatar, remoteAccounts)
    ? connectedAvatar
    : null;
  const connectedAvatarRequiresHost = Boolean(connectedAvatar && !directConnectedAvatar);

  // 2. Instant match for static fast-paths (e.g. GitHub noreply CDN URL)
  const remotes = repoRemoteUrl ? (Array.isArray(repoRemoteUrl) ? repoRemoteUrl : [repoRemoteUrl]) : [];
  const isGitHubRepo = remotes.some(r => /github/i.test(r));
  const staticAvatar = isGitHubRepo && normalizedEmail ? githubAvatarUrl(authorEmail, size) : null;

  // 3. Instant match from hostResolvedAvatars (scoped by repoId/platform)
  const hostCached = normalizedEmail
    ? getStoredAvatar(normalizedEmail, repoId)
    : undefined;
  const unusablePrivateHostCache = typeof hostCached === 'string'
    && !canRenderConnectedAvatarDirectly(hostCached, remoteAccounts);
  const hostCacheRequiresRefresh = unusablePrivateHostCache
    || (connectedAvatarRequiresHost && hostCached === null);
  const usableHostCached = hostCacheRequiresRefresh ? undefined : hostCached;

  // Connected public-account data is freshest and keeps its original priority.
  // Self-hosted GitLab must instead use the authenticated/proxied host result.
  const immediateAvatar = connectedAvatarRequiresHost
    ? (usableHostCached !== undefined ? usableHostCached : undefined)
    : directConnectedAvatar || staticAvatar || (usableHostCached !== undefined ? usableHostCached : undefined);

  const [epoch, setEpoch] = useState(() => avatarCacheEpoch);
  const [url, setUrl] = useState<string | null | 'loading'>(() => immediateAvatar !== undefined ? immediateAvatar : 'loading');
  const authorTitle = formatAuthorIdentity(authorName, authorEmail);
  const avatarSeed = authorEmail.trim() || authorName.trim();

  useEffect(() => {
    const onEpoch = () => {
      setEpoch(avatarCacheEpoch);
      setUrl('loading');
    };
    cacheEpochListeners.add(onEpoch);
    return () => {
      cacheEpochListeners.delete(onEpoch);
    };
  }, []);

  // When immediate avatar becomes available or changes (e.g., remoteAccounts loaded)
  useEffect(() => {
    if (immediateAvatar !== undefined) {
      setUrl(prev => (prev === immediateAvatar ? prev : immediateAvatar));
    }
  }, [immediateAvatar]);

  // Query Host asynchronously only if we don't have an immediate avatar yet
  useEffect(() => {
    if (immediateAvatar !== undefined) return;
    if (!normalizedEmail && !cleanName) {
      setUrl(null);
      return;
    }
    if (hostCacheRequiresRefresh && normalizedEmail) {
      hostResolvedAvatars.delete(buildAvatarCacheKey(normalizedEmail, repoId));
      hostResolvedAvatars.delete(normalizedEmail);
    }
    queueResolution(authorEmail, repoId, authorName);
  }, [immediateAvatar, hostCacheRequiresRefresh, normalizedEmail, cleanName, authorEmail, authorName, repoId, epoch, queueResolution]);

  useEffect(() => {
    if (!normalizedEmail) return;

    const onResolve = (resolvedEmail: string, resolvedUrl: string | null, resolvedRepoId?: string) => {
      if (resolvedEmail === normalizedEmail) {
        if (resolvedRepoId && repoId && resolvedRepoId !== repoId) {
          return;
        }
        setUrl(resolvedUrl ?? immediateAvatar ?? null);
      }
    };
    avatarListeners.add(onResolve);
    return () => {
      avatarListeners.delete(onResolve);
    };
  }, [normalizedEmail, immediateAvatar, repoId]);

  return {
    url,
    setUrl,
    authorTitle,
    avatarSeed,
    initials: initials(authorName),
    avatarColor: avatarColor(avatarSeed),
  };
}
