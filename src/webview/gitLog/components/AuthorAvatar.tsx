import React, { useState, useEffect } from 'react';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { useLogStore } from '../store/logStore';
import type { RemoteAccountInfo } from '../../../host/types/messages';

interface Props {
  authorName: string;
  authorEmail: string;
  repoId?: string;
  size?: number;
}

/**
 * Checks whether an author matches any connected remote account (GitHub or GitLab)
 * based on username, name, emails, or email prefix patterns.
 */
export function findConnectedAvatar(
  authorName: string,
  authorEmail: string,
  remoteAccounts: RemoteAccountInfo[],
  repoRemoteUrl?: string
): string | null {
  if (!remoteAccounts || remoteAccounts.length === 0) return null;

  const cleanName = (authorName || '').trim().toLowerCase();
  const cleanEmail = (authorEmail || '').trim().toLowerCase();
  const emailPrefix = cleanEmail.includes('@') ? cleanEmail.split('@')[0]! : cleanEmail;
  const strippedEmailPrefix = emailPrefix.replace(/\d+$/, '');
  const strippedName = cleanName.replace(/\d+$/, '');

  // Prioritize accounts matching the current repository remote URL if available
  const sortedAccounts = [...remoteAccounts].sort((a, b) => {
    if (!repoRemoteUrl) return 0;
    const lowerRemote = repoRemoteUrl.toLowerCase();
    const aMatches = lowerRemote.includes(a.provider);
    const bMatches = lowerRemote.includes(b.provider);
    if (aMatches && !bMatches) return -1;
    if (!aMatches && bMatches) return 1;
    return 0;
  });

  for (const acc of sortedAccounts) {
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

async function gravatarUrl(email: string, size: number): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  const hash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `https://gravatar.com/avatar/${hash}?s=${size * 2}&d=404`;
}

function githubAvatarUrl(email: string, size: number): string | null {
  if (!email.toLowerCase().endsWith('@users.noreply.github.com')) return null;
  const local = email.split('@')[0] ?? '';
  const username = local.includes('+') ? local.split('+')[1] : local;
  return username ? `https://avatars.githubusercontent.com/${encodeURIComponent(username)}?size=${size * 2}` : null;
}

function gitlabAvatarUrl(email: string, size: number): string | null {
  const lower = email.toLowerCase();
  if (!lower.endsWith('@users.noreply.gitlab.com') && !lower.endsWith('@noreply.gitlab.com')) return null;
  return `https://gitlab.com/api/v4/avatar?email=${encodeURIComponent(email)}&size=${size * 2}`;
}

const hostResolvedAvatars = new Map<string, string | null>();
const avatarListeners = new Set<(email: string, url: string | null) => void>();

export function notifyAvatarsResolved(avatars: Record<string, string | null>): void {
  for (const [email, url] of Object.entries(avatars)) {
    const key = email.toLowerCase();
    hostResolvedAvatars.set(key, url);
    // Clear pending/null cached promises so newly resolved avatars take effect immediately
    for (const cacheKey of Array.from(avatarPromiseCache.keys())) {
      if (cacheKey.startsWith(`${key}\0`)) {
        avatarPromiseCache.delete(cacheKey);
      }
    }
    avatarListeners.forEach(fn => fn(key, url));
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
        getVsCodeApi().postMessage({ type: 'LOG_RESOLVE_AVATARS', emails, repoId: reqRepoId, authors });
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

// Fetches the image as a blob, draws it on an offscreen canvas, and checks
// whether all sampled pixels are nearly identical (blank/default avatar).
function loadImagePixels(url: string, sampleSize = 8): Promise<boolean> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (blank: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      img.onload = null;
      img.onerror = null;
      resolve(blank);
    };
    const timeout = window.setTimeout(() => finish(true), 8000);

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = sampleSize;
        canvas.height = sampleSize;
        const ctx = canvas.getContext('2d');
        if (!ctx) { finish(false); return; }
        ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
        const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);
        const unique = new Set<number>();
        for (let i = 0; i < data.length; i += 4) {
          const r = Math.round((data[i]!)   / 16);
          const g = Math.round((data[i+1]!) / 16);
          const b = Math.round((data[i+2]!) / 16);
          unique.add((r << 8) | (g << 4) | b);
        }
        finish(unique.size <= 3);
      } catch {
        // Canvas tainted (CORS) — assume not blank
        finish(false);
      }
    };

    img.onerror = () => finish(true); // 404 or network error → treat as blank
    img.src = url;
  });
}

async function resolveAvatarUrl(email: string, size: number, repoId?: string, authorName?: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();

  // Fast-path: Check connected accounts from store first
  const store = useLogStore.getState();
  const repoRemoteUrl = repoId ? store.repos.find(r => r.id === repoId)?.remoteUrl : undefined;
  const connected = findConnectedAvatar(authorName ?? '', email, store.remoteAccounts, repoRemoteUrl);
  if (connected) return connected;

  if (!normalized) return null;

  if (hostResolvedAvatars.has(normalized)) {
    return hostResolvedAvatars.get(normalized) ?? null;
  }

  const github = githubAvatarUrl(email, size);
  if (github) {
    const blank = await loadImagePixels(github);
    if (!blank) return github;
  }

  const gitlab = gitlabAvatarUrl(email, size);
  if (gitlab) {
    const blank = await loadImagePixels(gitlab);
    if (!blank) return gitlab;
  }

  const gravatar = await gravatarUrl(email, size);
  const blank = await loadImagePixels(gravatar);
  if (!blank) return gravatar;

  // Not found in fast-paths; query Host AvatarService asynchronously
  queueEmailResolution(normalized, repoId, authorName);
  return null;
}

const AVATAR_CACHE_LIMIT = 512;
const avatarPromiseCache = new Map<string, Promise<string | null>>();

function cachedAvatarUrl(email: string, size: number, repoId?: string, authorName?: string): Promise<string | null> {
  const key = `${email.trim().toLowerCase()}\0${authorName?.trim().toLowerCase() ?? ''}\0${size}`;
  const cached = avatarPromiseCache.get(key);
  if (cached) {
    // Refresh insertion order so frequently visible authors stay cached.
    avatarPromiseCache.delete(key);
    avatarPromiseCache.set(key, cached);
    return cached;
  }

  const pending = resolveAvatarUrl(email, size, repoId, authorName).catch(() => null);
  avatarPromiseCache.set(key, pending);
  if (avatarPromiseCache.size > AVATAR_CACHE_LIMIT) {
    const oldest = avatarPromiseCache.keys().next().value as string | undefined;
    if (oldest) avatarPromiseCache.delete(oldest);
  }
  return pending;
}

export function AuthorAvatar({ authorName, authorEmail, repoId, size = 20 }: Props) {
  const remoteAccounts = useLogStore(s => s.remoteAccounts);
  const repos = useLogStore(s => s.repos);
  const currentRepo = repoId ? repos.find(r => r.id === repoId) : undefined;
  const repoRemoteUrl = currentRepo?.remoteUrl;

  // Instant match for connected accounts (GitHub & GitLab)
  const connectedAvatar = findConnectedAvatar(authorName, authorEmail, remoteAccounts, repoRemoteUrl);

  const [url, setUrl] = useState<string | null | 'loading'>(() => connectedAvatar ?? 'loading');
  const authorTitle = formatAuthorIdentity(authorName, authorEmail);
  const avatarSeed = authorEmail.trim() || authorName.trim();

  useEffect(() => {
    if (connectedAvatar) {
      setUrl(connectedAvatar);
      return;
    }

    setUrl('loading');

    let cancelled = false;
    if (!authorEmail.trim() && !authorName.trim()) {
      setUrl(null);
      return () => { cancelled = true; };
    }
    cachedAvatarUrl(authorEmail, size, repoId, authorName).then(resolved => {
      if (!cancelled) setUrl(resolved);
    });
    return () => { cancelled = true; };
  }, [connectedAvatar, authorEmail, authorName, size, repoId]);

  useEffect(() => {
    const normalized = authorEmail.trim().toLowerCase();
    if (!normalized) return;

    const onResolve = (resolvedEmail: string, resolvedUrl: string | null) => {
      if (resolvedEmail === normalized) {
        setUrl(resolvedUrl ?? connectedAvatar ?? null);
      }
    };
    avatarListeners.add(onResolve);
    return () => {
      avatarListeners.delete(onResolve);
    };
  }, [authorEmail, connectedAvatar]);

  const containerStyle: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: size * 0.38,
    fontWeight: 600,
    lineHeight: 1,
    userSelect: 'none',
  };

  if (url === null) {
    return (
      <div
        style={{ ...containerStyle, background: avatarColor(avatarSeed), color: '#fff' }}
        title={authorTitle}
      >
        {initials(authorName)}
      </div>
    );
  }

  if (url === 'loading') {
    // Show initials as placeholder while fetching
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
