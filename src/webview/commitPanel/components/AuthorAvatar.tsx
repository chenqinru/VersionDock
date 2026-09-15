import React, { useState, useEffect } from 'react';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { useCommitStore } from '../store/commitStore';
import type { RemoteAccountInfo } from '../../../host/types/messages';

interface Props {
  authorName: string;
  authorEmail?: string;
  repoId?: string;
  size?: number;
  fontSize?: number;
}

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

  if (acc.provider === 'github') {
    return isGitHubRepo;
  }

  if (acc.provider === 'gitee') {
    return isGiteeRepo;
  }

  if (acc.provider === 'gitlab') {
    return isGitLabRepo && !isGitHubRepo && !isGiteeRepo;
  }

  return false;
}

/**
 * Checks whether an author matches any connected remote account (GitHub or GitLab)
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

    // 1. Author name exactly matches account username
    if (cleanName && cleanName === username) return acc.avatarUrl;

    // 2. Author name exactly matches account display name
    if (cleanName && displayName && cleanName === displayName) return acc.avatarUrl;

    // 3. Known account emails exact match
    if (cleanEmail && emails.includes(cleanEmail)) return acc.avatarUrl;

    // 4. Email prefix exact match with username
    if (emailPrefix && emailPrefix === username) return acc.avatarUrl;

    // 5. Stripped email prefix matches username (e.g. chenqinru0@qq.com -> chenqinru)
    if (strippedEmailPrefix.length >= 3 && strippedEmailPrefix === username) return acc.avatarUrl;

    // 6. Stripped author name matches username
    if (strippedName.length >= 3 && strippedName === username) return acc.avatarUrl;

    // 7. Author name matches display name without digits
    if (displayName && strippedName.length >= 3 && strippedName === displayName.replace(/\d+$/, '')) {
      return acc.avatarUrl;
    }
  }

  return null;
}

function githubAvatarUrl(email: string, size: number): string | null {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? '';
  const username = local.includes('+') ? local.split('+')[1] : local;
  return username ? `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?size=${size * 2}` : null;
}

const LOCAL_STORAGE_KEY = 'versiondock.avatar.cache.v1';
const MAX_LOCAL_ENTRIES = 1000;

function loadStorageAvatars(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' || v === null) {
            map.set(k.toLowerCase(), v);
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
const avatarListeners = new Set<(email: string, url: string | null) => void>();

let saveStorageTimer: number | null = null;
function persistStorageAvatars(): void {
  if (saveStorageTimer !== null) return;
  saveStorageTimer = window.setTimeout(() => {
    saveStorageTimer = null;
    try {
      if (hostResolvedAvatars.size > MAX_LOCAL_ENTRIES) {
        const entries = Array.from(hostResolvedAvatars.entries()).slice(-MAX_LOCAL_ENTRIES);
        hostResolvedAvatars.clear();
        for (const [k, v] of entries) hostResolvedAvatars.set(k, v);
      }
      const obj: Record<string, string | null> = {};
      for (const [k, v] of hostResolvedAvatars.entries()) {
        obj[k] = v;
      }
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(obj));
    } catch {
      // Ignore quota error
    }
  }, 1000);
}

export function notifyAvatarsResolved(avatars: Record<string, string | null>): void {
  let changed = false;
  for (const [email, url] of Object.entries(avatars)) {
    const key = email.toLowerCase();
    if (hostResolvedAvatars.get(key) !== url) {
      hostResolvedAvatars.set(key, url);
      changed = true;
    }
    avatarListeners.forEach(fn => fn(key, url));
  }
  if (changed) {
    persistStorageAvatars();
  }
}

const pendingBatch = new Set<string>();
const pendingAuthors = new Map<string, string>();
let activeRepoId: string | undefined;
let batchTimer: number | null = null;

function queueEmailResolution(email: string, repoId?: string, authorName?: string): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized || hostResolvedAvatars.has(normalized)) return;
  pendingBatch.add(normalized);
  if (authorName) pendingAuthors.set(normalized, authorName);
  if (repoId) activeRepoId = repoId;
  if (batchTimer === null) {
    batchTimer = window.setTimeout(() => {
      batchTimer = null;
      if (pendingBatch.size > 0) {
        const emails = Array.from(pendingBatch);
        const authors = emails.map(e => ({ email: e, name: pendingAuthors.get(e) }));
        const reqRepoId = activeRepoId;
        pendingBatch.clear();
        pendingAuthors.clear();
        getVsCodeApi().postMessage({ type: 'COMMIT_RESOLVE_AVATARS', emails, repoId: reqRepoId, authors });
      }
    }, 60);
  }
}

function avatarColor(email: string): string {
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

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) { const w = parts[0] ?? ''; return (w.length > 1 ? w[0] + w[1] : w[0] ?? '?').toUpperCase(); }
  return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase();
}

let avatarCacheEpoch = 0;
const cacheEpochListeners = new Set<() => void>();

export function clearFrontendAvatarCache(): void {
  try {
    localStorage.removeItem(LOCAL_STORAGE_KEY);
  } catch {
    // Ignore
  }
  hostResolvedAvatars.clear();
  avatarCacheEpoch++;
  cacheEpochListeners.forEach(fn => fn());
}

export function AuthorAvatar({ authorName, authorEmail = '', repoId, size = 16, fontSize }: Props) {
  const remoteAccounts = useCommitStore(s => s.remoteAccounts);
  const repoMetas = useCommitStore(s => s.repoMetas);
  const currentRepo = repoId ? repoMetas.find(r => r.id === repoId) : (repoMetas.length === 1 ? repoMetas[0] : undefined);
  const repoRemoteUrl = currentRepo?.remoteUrl || (repoMetas.length > 0 ? (repoMetas.map(r => r.remoteUrl).filter(Boolean) as string[]) : undefined);

  const normalizedEmail = (authorEmail || '').trim().toLowerCase();
  const cleanName = (authorName || '').trim();

  // 1. Instant match for connected accounts (GitHub & GitLab & Gitee)
  const connectedAvatar = findConnectedAvatar(cleanName, authorEmail, remoteAccounts, repoRemoteUrl);

  // 2. Instant match for static fast-paths (e.g. GitHub noreply CDN URL)
  const remotes = repoRemoteUrl ? (Array.isArray(repoRemoteUrl) ? repoRemoteUrl : [repoRemoteUrl]) : [];
  const isGitHubRepo = remotes.some(r => /github/i.test(r));
  const staticAvatar = (isGitHubRepo && normalizedEmail) ? githubAvatarUrl(authorEmail, size) : null;

  // 3. Instant match from hostResolvedAvatars (already fetched in current session)
  const hostCached = normalizedEmail && hostResolvedAvatars.has(normalizedEmail)
    ? hostResolvedAvatars.get(normalizedEmail)
    : undefined;

  const immediateAvatar = connectedAvatar || staticAvatar || (hostCached !== undefined ? hostCached : undefined);

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
    queueEmailResolution(authorEmail, repoId, authorName);
  }, [immediateAvatar, authorEmail, authorName, repoId, epoch]);

  useEffect(() => {
    if (!normalizedEmail) return;

    const onResolve = (resolvedEmail: string, resolvedUrl: string | null) => {
      if (resolvedEmail === normalizedEmail) {
        setUrl(resolvedUrl ?? immediateAvatar ?? null);
      }
    };
    avatarListeners.add(onResolve);
    return () => {
      avatarListeners.delete(onResolve);
    };
  }, [normalizedEmail, immediateAvatar]);

  const avatarFontSize = fontSize ?? Math.max(7, Math.round(size * 0.44 * 10) / 10);

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: avatarFontSize,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
  };

  if (!url || url === 'loading') {
    return (
      <div
        style={{ ...containerStyle, background: avatarColor(avatarSeed), color: '#fff' }}
        title={authorTitle}
      >
        {initials(authorName)}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={authorName}
      title={authorTitle}
      width={size}
      height={size}
      style={{ ...containerStyle, objectFit: 'cover' }}
      onError={() => setUrl(null)}
    />
  );
}
