/**
 * Combined commit for linked worktrees of one Git repository instance.
 *
 * When the same repository instance is checked out into several worktrees,
 * the multi-repository commit flow can merge the selected changes of all
 * members into ONE commit on the primary member's branch:
 *
 *  1. Every member stages its selection in its own index (same unstage →
 *     stage order as the per-repository flow).
 *  2. Each secondary member's staged diff (index vs its HEAD, binary-safe)
 *     is applied to the primary member's index. Applying happens before the
 *     commit; any failure aborts the group without creating a commit.
 *  3. The primary member commits once. Worktrees share refs and objects, so
 *     the new commit is immediately visible to the whole instance.
 *  4. Every secondary member is synced to the combined commit: branch and
 *     index move with `git reset --mixed`, then the working tree is
 *     reconciled path by path. Paths the member did not touch locally adopt
 *     the combined content (like `svn update`); locally changed paths are
 *     preserved and reported back so the UI can inform the user.
 */

import { t } from '../utils/l10n';

/** Minimal GitService surface the combined worktree commit flow relies on. */
export interface GitWorktreeGroupCommitRepo {
  readonly repoId: string;
  stageFiles(paths: string[]): Promise<void>;
  unstageFiles(paths: string[]): Promise<void>;
  createStagedBinaryPatch(): Promise<string>;
  applyBinaryPatchToIndex(patch: string): Promise<void>;
  commit(
    message: string,
    amend: boolean,
    credentials?: { gitName: string; gitEmail: string },
    log?: (s: string) => void,
    noVerify?: boolean,
  ): Promise<string>;
  runWithGitWriteLock<T>(operation: () => Promise<T>): Promise<T>;
  resetIndexToCommit(commitId: string): Promise<void>;
  resetIndexToHead(): Promise<void>;
  listWorktreeIndexDiffPaths(): Promise<string[]>;
  getBlobIdAtCommit(commitId: string, filePath: string): Promise<string | undefined>;
  getWorktreeBlobId(filePath: string): Promise<string | undefined>;
  restoreWorktreePath(filePath: string): Promise<void>;
  removeUntrackedWorktreePath(filePath: string): Promise<void>;
  getHeadCommitId(): Promise<string | undefined>;
  invalidateLogMetadataCache?(): void;
}

export interface GitWorktreeGroupMember {
  repo: GitWorktreeGroupCommitRepo;
  filesToStage: string[];
  filesToUnstage: string[];
}

export interface WorktreeGroupCommitResult {
  commitId: string;
  /** Paths whose local changes were preserved instead of being synced. */
  preservedChanges: Array<{ repoId: string; path: string }>;
}

/** Rejects a group when two members selected the same path: one commit cannot hold both. */
export function assertNoPathOverlapAcrossMembers(members: GitWorktreeGroupMember[]): void {
  const ownerByPath = new Map<string, string>();
  for (const member of members) {
    for (const filePath of member.filesToStage) {
      const key = filePath.replace(/\\/g, '/');
      const owner = ownerByPath.get(key);
      if (owner && owner !== member.repo.repoId) {
        throw new Error(t(
          'Cannot commit as one revision: {0} is selected in more than one worktree of the same repository.',
          key,
        ));
      }
      ownerByPath.set(key, member.repo.repoId);
    }
  }
}

export async function commitWorktreeGroupAsOne(input: {
  /** members[0] is the primary: the combined commit lands on its branch. */
  members: GitWorktreeGroupMember[];
  message: string;
  amend: boolean;
  credentials?: { gitName: string; gitEmail: string };
  noVerify?: boolean;
  log?: (s: string) => void;
}): Promise<WorktreeGroupCommitResult> {
  const { members, message, amend, credentials, noVerify, log } = input;
  const [primary, ...secondaries] = members;
  assertNoPathOverlapAcrossMembers(members);

  // Re-verify the shared base right before mutating anything: the panel
  // resolved the group earlier, and any member may have moved in between.
  const baseCommitId = await primary.repo.getHeadCommitId();
  if (!baseCommitId) throw new Error(t('Cannot commit worktrees of an empty repository as one revision.'));
  for (const member of secondaries) {
    const headCommitId = await member.repo.getHeadCommitId();
    if (headCommitId !== baseCommitId) {
      throw new Error(t(
        'Worktree "{0}" moved to another commit while preparing the combined commit; nothing was committed. Retry to commit each worktree separately.',
        member.repo.repoId,
      ));
    }
  }

  // Stage every member's selection in its own index.
  for (const member of members) {
    await member.repo.runWithGitWriteLock(async () => {
      if (member.filesToUnstage.length > 0) await member.repo.unstageFiles(member.filesToUnstage);
      if (member.filesToStage.length > 0) await member.repo.stageFiles(member.filesToStage);
    });
  }

  log?.('commitWorktreeGroupAsOne — collecting staged patches from secondary worktrees');
  const secondaryPatches: string[] = [];
  for (const member of secondaries) {
    const patch = await member.repo.createStagedBinaryPatch();
    if (patch.trim().length > 0) secondaryPatches.push(patch);
  }

  try {
    await primary.repo.runWithGitWriteLock(async () => {
      for (const patch of secondaryPatches) {
        await primary.repo.applyBinaryPatchToIndex(patch);
      }
      log?.(`commitWorktreeGroupAsOne — committing ${members.length} worktrees on the primary branch`);
      await primary.repo.commit(message, amend, credentials, log, noVerify);
    });
  } catch (error) {
    // Drop the externally applied index edits so the primary worktree keeps
    // exactly its own staged selection, then surface the original failure.
    await primary.repo.runWithGitWriteLock(async () => {
      await primary.repo.resetIndexToHead();
      if (primary.filesToUnstage.length > 0) await primary.repo.unstageFiles(primary.filesToUnstage);
      if (primary.filesToStage.length > 0) await primary.repo.stageFiles(primary.filesToStage);
    }).catch(() => undefined);
    throw error;
  }

  const commitId = await primary.repo.getHeadCommitId();
  if (!commitId || commitId === baseCommitId) {
    throw new Error(t('The combined worktree commit did not create a new commit.'));
  }

  // Sync every member to the combined commit — including the primary, whose
  // working tree must adopt the other members' changes just like `svn update`.
  const preservedChanges: Array<{ repoId: string; path: string }> = [];
  for (const member of members) {
    await member.repo.runWithGitWriteLock(async () => {
      await member.repo.resetIndexToCommit(commitId);
      const dirtyPaths = await member.repo.listWorktreeIndexDiffPaths();
      for (const filePath of dirtyPaths) {
        const worktreeBlob = await member.repo.getWorktreeBlobId(filePath);
        const combinedBlob = await member.repo.getBlobIdAtCommit(commitId, filePath);
        if (worktreeBlob !== undefined && worktreeBlob === combinedBlob) continue;
        const baseBlob = await member.repo.getBlobIdAtCommit(baseCommitId, filePath);
        if (worktreeBlob === baseBlob) {
          // Untouched locally: adopt the combined commit's version.
          if (combinedBlob === undefined) {
            await member.repo.removeUntrackedWorktreePath(filePath);
          } else {
            await member.repo.restoreWorktreePath(filePath);
          }
        } else {
          preservedChanges.push({ repoId: member.repo.repoId, path: filePath });
        }
      }
    });
    member.repo.invalidateLogMetadataCache?.();
  }

  log?.(`commitWorktreeGroupAsOne — combined commit ${commitId} synced to ${secondaries.length} secondary worktrees`);
  return { commitId, preservedChanges };
}
