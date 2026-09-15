import React from 'react';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { useLogStore } from '../store/logStore';
import {
  createAvatarResolverQueue,
  useResolvedAvatar,
  isAccountCompatibleWithRepo,
  findConnectedAvatar,
  formatAuthorIdentity,
  notifyAvatarsResolved,
  clearFrontendAvatarCache,
} from '../../shared/avatarShared';

export {
  isAccountCompatibleWithRepo,
  findConnectedAvatar,
  formatAuthorIdentity,
  notifyAvatarsResolved,
  clearFrontendAvatarCache,
};

interface Props {
  authorName: string;
  authorEmail: string;
  repoId?: string;
  size?: number;
}

const queueEmailResolution = createAvatarResolverQueue((emails, repoId, authors) => {
  getVsCodeApi().postMessage({ type: 'LOG_RESOLVE_AVATARS', emails, repoId, authors });
});

export function AuthorAvatar({ authorName, authorEmail, repoId, size = 20 }: Props) {
  const remoteAccounts = useLogStore(s => s.remoteAccounts);
  const repos = useLogStore(s => s.repos);
  const currentRepo = repoId ? repos.find(r => r.id === repoId) : (repos.length === 1 ? repos[0] : undefined);
  const repoRemoteUrl = currentRepo?.remoteUrl || (repos.length > 0 ? (repos.map(r => r.remoteUrl).filter(Boolean) as string[]) : undefined);

  const {
    url,
    setUrl,
    authorTitle,
    initials,
    avatarColor,
  } = useResolvedAvatar({
    authorName,
    authorEmail,
    repoId,
    size,
    remoteAccounts,
    repoRemoteUrl,
    queueResolution: queueEmailResolution,
  });

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

  if (!url || url === 'loading') {
    return (
      <div
        style={{ ...containerStyle, background: avatarColor, color: '#fff' }}
        title={authorTitle}
      >
        {initials}
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
