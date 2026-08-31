import { currentPalette as _currentPalette } from '../../shared/branchColors';
import { isPrimaryBranch } from '../../shared/branchUtils';
import type { BranchInfo } from '../../shared/types';
export {
  primaryBranchColor,
  headColor,
  tagColor,
  currentPalette,
  branchPaletteIndex,
  branchColor,
  normalizeBranchName,
  isDarkTheme,
} from '../../shared/branchColors';

export interface RefGroup {
  key: string;
  label: string;
  remoteName: string;    // name of the remote (e.g. "upstream", "origin"); empty for local
  isHead: boolean;       // this is the current HEAD branch
  isLocal: boolean;      // has a local branch
  isRemote: boolean;     // has a remote counterpart
  isTag: boolean;
  isDetached: boolean;   // HEAD is detached (on this tag or commit)
  isRemoteHead: boolean; // this is <remote>/HEAD (symbolic remote pointer)
  isSvnRevision?: boolean; // SVN HEAD/BASE revision marker, not a Git ref
}

export function splitRemoteRefName(
  refName: string,
  remoteNames: readonly string[] = [],
): { remoteName: string; name: string } | null {
  const shortName = refName.startsWith('refs/remotes/')
    ? refName.slice('refs/remotes/'.length)
    : refName;
  const configuredRemoteNames = Array.from(new Set(remoteNames.filter(Boolean))).sort((a, b) => b.length - a.length);
  const configuredRemote = configuredRemoteNames.find(remote => shortName.startsWith(`${remote}/`));
  const slash = shortName.indexOf('/');
  if (!configuredRemote && slash < 0) return null;
  const remoteName = configuredRemote ?? shortName.slice(0, slash);
  return { remoteName, name: shortName.slice(remoteName.length + 1) };
}

export function branchRevisionRef(branch: BranchInfo, vcsKind: 'git' | 'svn'): string {
  if (vcsKind === 'git') {
    if (branch.fullName.startsWith('refs/')) return branch.fullName;
    return branch.isRemote ? `refs/remotes/${branch.name}` : `refs/heads/${branch.name}`;
  }
  if (branch.name === 'trunk' || branch.name.startsWith('branches/') || branch.name.startsWith('tags/')) {
    return branch.name;
  }
  return `branches/${branch.name}`;
}

export function tagRevisionRef(tagName: string, vcsKind: 'git' | 'svn'): string {
  return vcsKind === 'git' ? `refs/tags/${tagName}` : `tags/${tagName}`;
}

// Normalize a single raw ref token from %D --decorate=full output.
// Returns null if the token should be ignored.
function normalizeRef(raw: string, configuredRemoteNames: readonly string[]): { kind: 'head-pointer'; branch: string }
  | { kind: 'detached-head' }
  | { kind: 'local'; name: string }
  | { kind: 'remote'; remoteName: string; name: string }
  | { kind: 'tag'; name: string }
  | null {
  // HEAD -> refs/heads/main  OR  HEAD -> main  (old format, no --decorate=full)
  if (raw.startsWith('HEAD -> ')) {
    const target = raw.slice('HEAD -> '.length);
    const branch = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : target;
    return { kind: 'head-pointer', branch };
  }
  if (raw === 'HEAD') return { kind: 'detached-head' };
  // Full-form: refs/heads/<name>
  if (raw.startsWith('refs/heads/')) return { kind: 'local', name: raw.slice('refs/heads/'.length) };
  // Full-form: refs/remotes/<remote>/<name>  OR  refs/remotes/<remote>/HEAD
  if (raw.startsWith('refs/remotes/')) {
    const remote = splitRemoteRefName(raw, configuredRemoteNames);
    return remote ? { kind: 'remote', ...remote } : null;
  }
  // Full-form tag: refs/tags/<name>  OR  tag: <name>
  if (raw.startsWith('refs/tags/')) return { kind: 'tag', name: raw.slice('refs/tags/'.length) };
  if (raw.startsWith('tag: ')) {
    const n = raw.slice('tag: '.length);
    return { kind: 'tag', name: n.startsWith('refs/tags/') ? n.slice('refs/tags/'.length) : n };
  }
  // Fallback: short-form (old git / no --decorate=full).
  // A ref with a slash is ambiguous (could be remote/branch or local feature/foo).
  // Without a full prefix we can't tell, so treat it as a remote ref — this was
  // the old behaviour and is correct for the common case where locals rarely have slashes.
  if (raw.includes('/')) {
    const remote = splitRemoteRefName(raw, configuredRemoteNames);
    return remote ? { kind: 'remote', ...remote } : null;
  }
  return { kind: 'local', name: raw };
}

export function groupRefs(
  refs: string[],
  vcsKind: 'git' | 'svn' = 'git',
  remoteNames: readonly string[] = [],
): RefGroup[] {
  if (vcsKind === 'svn') {
    return Array.from(new Set(refs))
      .filter(ref => ref === 'HEAD' || ref === 'BASE')
      .map(ref => ({
        key: `svn:${ref}`,
        label: ref,
        remoteName: '',
        isHead: ref === 'HEAD',
        isLocal: false,
        isRemote: false,
        isTag: false,
        isDetached: false,
        isRemoteHead: false,
        isSvnRevision: true,
      }));
  }

  const configuredRemoteNames = Array.from(new Set(remoteNames.filter(Boolean))).sort((a, b) => b.length - a.length);
  const remotes = new Map<string, { remoteName: string; name: string }>();
  const locals = new Set<string>();
  const tags: string[] = [];
  let headBranch: string | null = null;
  let isDetached = false;
  const remoteHeadRemoteNames = new Set<string>();

  for (const ref of refs) {
    const parsed = normalizeRef(ref, configuredRemoteNames);
    if (!parsed) continue;
    switch (parsed.kind) {
      case 'head-pointer':
        headBranch = parsed.branch;
        locals.add(parsed.branch);
        break;
      case 'detached-head':
        isDetached = true;
        break;
      case 'local':
        locals.add(parsed.name);
        break;
      case 'remote':
        if (parsed.name.toUpperCase() === 'HEAD') {
          remoteHeadRemoteNames.add(parsed.remoteName);
        } else {
          remotes.set(`${parsed.remoteName}\0${parsed.name}`, {
            remoteName: parsed.remoteName,
            name: parsed.name,
          });
        }
        break;
      case 'tag':
        tags.push(parsed.name);
        break;
    }
  }

  // HEAD is detached only when there is no HEAD -> branch pointer
  if (headBranch !== null) isDetached = false;

  const groups: RefGroup[] = [];

  // Detached HEAD: show a HEAD badge on this commit
  if (isDetached) {
    groups.push({
      key: 'HEAD',
      label: 'HEAD',
      remoteName: '',
      isHead: true,
      isLocal: false,
      isRemote: false,
      isTag: false,
      isDetached: true,
      isRemoteHead: false,
    });
  }

  // <remote>/HEAD symbolic pointer
  for (const remoteHeadRemoteName of remoteHeadRemoteNames) {
    groups.push({
      key: `${remoteHeadRemoteName}/HEAD`,
      label: 'HEAD',
      remoteName: remoteHeadRemoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: true,
    });
  }

  for (const local of locals) {
    groups.push({
      key: local,
      label: local,
      remoteName: '',
      isHead: local === headBranch,
      isLocal: true,
      isRemote: false,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
  }

  for (const { name, remoteName } of remotes.values()) {
    groups.push({
      key: `remote:${remoteName}:${name}`,
      label: name,
      remoteName,
      isHead: false,
      isLocal: false,
      isRemote: true,
      isTag: false,
      isDetached: false,
      isRemoteHead: false,
    });
  }

  for (const tag of tags) {
    groups.push({
      key: `tag:${tag}`,
      label: tag,
      remoteName: '',
      isHead: false,
      isLocal: false,
      isRemote: false,
      isTag: true,
      isDetached: isDetached,
      isRemoteHead: false,
    });
  }

  groups.sort((a, b) => {
    const isSpecialHead = (g: RefGroup) => (g.isHead && g.isDetached) || (g.isSvnRevision && g.label === 'HEAD');
    if (isSpecialHead(a) !== isSpecialHead(b)) return isSpecialHead(a) ? -1 : 1;
    if (a.isRemoteHead !== b.isRemoteHead) return a.isRemoteHead ? 1 : -1;
    const rank = (g: RefGroup): number => {
      if (g.isTag) return 5;
      if (g.isLocal) return isPrimaryBranch(g.label) ? 1 : 2;
      if (g.isRemote) return isPrimaryBranch(g.label) ? 3 : 4;
      return 6;
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const nameA = a.isRemote && a.remoteName ? `${a.remoteName}/${a.label}` : a.label;
    const nameB = b.isRemote && b.remoteName ? `${b.remoteName}/${b.label}` : b.label;
    return nameA.localeCompare(nameB);
  });

  return groups;
}

// Color for graph lanes with no associated branch name.
export function anonymousLaneColor(laneIndex: number): string {
  const p = _currentPalette();
  return p[laneIndex % p.length];
}
