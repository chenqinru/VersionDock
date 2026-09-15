import React from 'react';
import { getVsCodeApi } from '../../shared/vscodeApi';
import { useCommitStore } from '../store/commitStore';
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
  authorEmail?: string;
  repoId?: string;
  size?: number;
  fontSize?: number;
}

const queueEmailResolution = createAvatarResolverQueue((emails, repoId, authors) => {
  getVsCodeApi().postMessage({ type: 'COMMIT_RESOLVE_AVATARS', emails, repoId, authors });
});

export function AuthorAvatar({ authorName, authorEmail = '', repoId, size = 16, fontSize }: Props) {
  const remoteAccounts = useCommitStore(s => s.remoteAccounts);
  const repoMetas = useCommitStore(s => s.repoMetas);
  const currentRepo = repoId ? repoMetas.find(r => r.id === repoId) : (repoMetas.length === 1 ? repoMetas[0] : undefined);
  const repoRemoteUrl = currentRepo?.remoteUrl || (repoMetas.length > 0 ? (repoMetas.map(r => r.remoteUrl).filter(Boolean) as string[]) : undefined);

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
