const PRIMARY_BRANCHES = new Set(['main', 'master', 'trunk', 'develop', 'dev', 'release']);

export function isPrimaryBranch(name: string): boolean {
  // Callers normally pass an already-normalized local branch name. A slash is
  // therefore significant (for example, feature/main is not the main branch).
  // Only peel prefixes that unambiguously come from Git's full ref format.
  let branch = name;
  if (branch.startsWith('refs/heads/')) {
    branch = branch.slice('refs/heads/'.length);
  } else if (branch.startsWith('refs/remotes/')) {
    const remoteRef = branch.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    branch = slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  }
  return PRIMARY_BRANCHES.has(branch.toLowerCase());
}
