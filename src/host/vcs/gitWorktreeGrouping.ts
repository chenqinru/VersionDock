/**
 * Group Git repositories that belong to the same repository instance
 * (linked worktrees) so a multi-repository commit can merge them into a
 * single commit.
 *
 * Unlike SVN working copies (which share a repository UUID), linked Git
 * worktrees share a common dir while each keeps its own HEAD and index.
 * A combined commit is only meaningful when every member points at the
 * same commit: the merged commit lands on the primary member's branch and
 * the other members' branches fast-forward to it during the sync step.
 */

import * as path from 'path';

export interface GitWorktreeGroupCandidate {
  repoId: string;
  /** Absolute path shared by every worktree of one repository instance. */
  gitCommonDir: string;
  /** HEAD commit id, or undefined when the repository has no commits yet. */
  headCommitId?: string;
  /** Branch name, or undefined on a detached HEAD. */
  branchName?: string;
  /** Ongoing operation (merge/rebase/...) that makes the worktree unsafe to move. */
  operationState?: string | null;
}

export interface GitWorktreeGroup {
  /** members[0] is the primary: the combined commit lands on its branch. */
  members: GitWorktreeGroupCandidate[];
}

/**
 * Group candidates sharing one repository instance. Only members on the same
 * commit, on a named branch, and free of ongoing operations can join a group;
 * the rest keep their individual commits. Candidate order decides which
 * member becomes the primary, so callers should pass candidates in the order
 * the commit flow will visit them.
 */
export function groupGitWorktreesByInstance(
  candidates: GitWorktreeGroupCandidate[],
): GitWorktreeGroup[] {
  const byCommonDir = new Map<string, GitWorktreeGroupCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.headCommitId || !candidate.branchName || candidate.operationState) continue;
    const key = path.resolve(candidate.gitCommonDir);
    const bucket = byCommonDir.get(key);
    if (bucket) bucket.push(candidate);
    else byCommonDir.set(key, [candidate]);
  }
  const groups: GitWorktreeGroup[] = [];
  for (const bucket of byCommonDir.values()) {
    if (bucket.length < 2) continue;
    const byHead = new Map<string, GitWorktreeGroupCandidate[]>();
    for (const member of bucket) {
      const head = member.headCommitId as string;
      const sameHead = byHead.get(head);
      if (sameHead) sameHead.push(member);
      else byHead.set(head, [member]);
    }
    for (const sameHead of byHead.values()) {
      if (sameHead.length >= 2) groups.push({ members: sameHead });
    }
  }
  return groups;
}
