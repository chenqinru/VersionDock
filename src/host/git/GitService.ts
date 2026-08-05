import simpleGit, { SimpleGit } from 'simple-git';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BranchInfo,
  CommitNode,
  FileStatus,
  FileDiff,
  GitFileStatus,
  MergeFileVersions,
  RepoStatus,
  SubmoduleStatus,
  LineRange,
  SubmoduleEntry,
} from '../types/git';
import type { StashEntry, UnpushedCommit, SubtreePushStatus } from '../types/messages';
import { parseDiff, detectLanguage } from './DiffParser';
import { getVscodeRepository } from './VscodeGitApi';
import { ForcePushMode, Status, RefType } from './git.d';
import { t } from '../utils/l10n';
import { BlameService, type BlameLine } from './BlameService';
import { assertNoSymlinkAncestors, isSameOrChildPath, resolveRepoPath as resolvePathWithinRepo, type ResolvedRepoPath } from '../utils/repoPath';

const STATUS_MAP: Record<string, GitFileStatus> = {
  M: 'modified', A: 'added', D: 'deleted',
  R: 'renamed', C: 'copied', U: 'conflicted',
  '?': 'untracked',
};

const SUBTREE_CANDIDATE_SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out']);
const MAX_INLINE_DIFF_FILE_BYTES = 8 * 1024 * 1024;
const LOG_RECORD_FORMAT = '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%x00%s';

export interface CommitMessageHistoryEntry {
  message: string;
  timestamp: number;
}

type ConflictSideStatus = 'modified' | 'added' | 'deleted';

function mapConflictSideStatuses(code: string): { currentStatus: ConflictSideStatus; incomingStatus: ConflictSideStatus } | undefined {
  switch (code) {
    case 'DD':
      return { currentStatus: 'deleted', incomingStatus: 'deleted' };
    case 'AU':
      return { currentStatus: 'added', incomingStatus: 'deleted' };
    case 'UD':
      return { currentStatus: 'modified', incomingStatus: 'deleted' };
    case 'UA':
      return { currentStatus: 'deleted', incomingStatus: 'added' };
    case 'DU':
      return { currentStatus: 'deleted', incomingStatus: 'modified' };
    case 'AA':
      return { currentStatus: 'added', incomingStatus: 'added' };
    case 'UU':
      return { currentStatus: 'modified', incomingStatus: 'modified' };
    default:
      return undefined;
  }
}

function parseLogOutput(raw: string, repoId: string, refsByHash: ReadonlyMap<string, string[]> = new Map()): CommitNode[] {
  const commits: CommitNode[] = [];
  for (const line of raw.trim().split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\x00');
    if (parts.length < 9) continue;
    const [hash, shortHash, parentsRaw, authorName, authorEmail, authorDate, committerDate, refsRaw, message] = parts;
    commits.push({
      hash,
      shortHash,
      repoId,
      message,
      authorName,
      authorEmail,
      authorDate,
      committerDate,
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      refs: refsByHash.get(hash) ?? (refsRaw ? refsRaw.split('\x1f').map(r => r.trim()).filter(Boolean) : []),
    });
  }
  return commits;
}

function mapDiffStatus(code: string): GitFileStatus {
  if (code.startsWith('R')) return 'renamed';
  if (code.startsWith('C')) return 'copied';
  return STATUS_MAP[code.charAt(0)] ?? 'modified';
}

function parseNameStatusZOutput(output: string): Array<{ path: string; oldPath?: string; status: GitFileStatus; code: string }> {
  const files: Array<{ path: string; oldPath?: string; status: GitFileStatus; code: string }> = [];
  const fields = output.split('\0');
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = fields[index++];
      const filePath = fields[index++];
      if (oldPath && filePath) files.push({ oldPath, path: filePath, status: mapDiffStatus(code), code });
      continue;
    }
    const filePath = fields[index++];
    if (filePath) files.push({ path: filePath, status: mapDiffStatus(code), code });
  }
  return files;
}

function parseNumStatZOutput(output: string): Map<string, { added?: number; removed?: number }> {
  const stats = new Map<string, { added?: number; removed?: number }>();
  const fields = output.split('\0');
  for (let index = 0; index < fields.length;) {
    const record = fields[index++];
    if (!record) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const addedRaw = record.slice(0, firstTab);
    const removedRaw = record.slice(firstTab + 1, secondTab);
    let filePath = record.slice(secondTab + 1);
    if (!filePath) {
      // Rename/copy records put old and new paths in the next two NUL fields.
      index += 1; // old path
      filePath = fields[index++] ?? '';
    }
    if (!filePath) continue;
    const added = addedRaw === '-' ? 0 : Number(addedRaw);
    const removed = removedRaw === '-' ? 0 : Number(removedRaw);
    const previous = stats.get(filePath) ?? {};
    stats.set(filePath, {
      added: ((previous.added ?? 0) + (Number.isFinite(added) ? added : 0)) || undefined,
      removed: ((previous.removed ?? 0) + (Number.isFinite(removed) ? removed : 0)) || undefined,
    });
  }
  return stats;
}

// VS Code Status enum → GitFileStatus
function vsStatusToGitFileStatus(s: Status): GitFileStatus {
  switch (s) {
    case Status.INDEX_MODIFIED:
    case Status.MODIFIED:
    case Status.TYPE_CHANGED:       return 'modified';
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
    case Status.INTENT_TO_RENAME:   return 'added';
    case Status.INDEX_DELETED:
    case Status.DELETED:            return 'deleted';
    case Status.INDEX_RENAMED:      return 'renamed';
    case Status.INDEX_COPIED:       return 'copied';
    case Status.UNTRACKED:          return 'untracked';
    case Status.ADDED_BY_US:
    case Status.ADDED_BY_THEM:
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
    case Status.BOTH_ADDED:
    case Status.BOTH_DELETED:
    case Status.BOTH_MODIFIED:      return 'conflicted';
    default:                        return 'modified';
  }
}

function splitStatusEntry(entry: string, fieldCount: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < fieldCount - 1; i++) {
    const space = entry.indexOf(' ', start);
    if (space === -1) return [];
    parts.push(entry.slice(start, space));
    start = space + 1;
  }
  parts.push(entry.slice(start));
  return parts;
}

type BranchTrackingInfo = Pick<BranchInfo, 'upstream' | 'aheadBehind'> & {
  upstreamRemote?: string;
  upstreamRemoteRef?: string;
};

function parseAheadBehindTrack(track: string): { ahead: number; behind: number } | undefined {
  const ahead = track.match(/ahead (\d+)/)?.[1];
  const behind = track.match(/behind (\d+)/)?.[1];
  if (!ahead && !behind) return undefined;
  return {
    ahead: ahead ? parseInt(ahead, 10) : 0,
    behind: behind ? parseInt(behind, 10) : 0,
  };
}

function parseSubmoduleStatusLine(line: string): { flag: string; path: string } | undefined {
  const match = line.match(/^([ +\-U])([0-9a-f]{40,64})\s+(.+)$/i);
  if (!match) return undefined;
  let submodulePath = match[3];
  // The optional describe suffix is separated from the path by " (". Preserve
  // spaces inside the path itself (the previous \S+ parser truncated them).
  const descriptionIndex = submodulePath.lastIndexOf(' (');
  if (descriptionIndex >= 0 && submodulePath.endsWith(')')) {
    submodulePath = submodulePath.slice(0, descriptionIndex);
  }
  return submodulePath ? { flag: match[1], path: submodulePath } : undefined;
}

function gitErrorDetail(error: unknown): string {
  const value = error as { stderr?: unknown; gitErrorCode?: unknown; message?: unknown } | undefined;
  const stderr = typeof value?.stderr === 'string' ? value.stderr.trim() : '';
  if (stderr) return stderr;
  if (typeof value?.gitErrorCode === 'string' && value.gitErrorCode) return value.gitErrorCode;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return 'Unknown error';
}

export class GitService {
  public readonly kind: 'git' | 'svn' = 'git';
  private git: SimpleGit;
  private readonly blameService = new BlameService();
  // Set immediately after a tag checkout, cleared when VS Code API confirms the update.
  private _pendingDetachedTag: string | undefined;

  constructor(public readonly repoId: string, public readonly rootPath: string) {
    this.git = simpleGit(rootPath);
  }

  async getBlame(filePath: string): Promise<BlameLine[]> {
    const resolved = resolvePathWithinRepo(this.rootPath, filePath, { allowAbsolute: true });
    return this.blameService.getBlame(resolved.absolutePath, this.rootPath);
  }

  invalidateBlame(filePath: string): void {
    const resolved = resolvePathWithinRepo(this.rootPath, filePath, { allowAbsolute: true });
    this.blameService.invalidate(resolved.absolutePath);
  }

  setPendingDetachedTag(tagName: string | undefined): void {
    this._pendingDetachedTag = tagName;
  }

  private vsRepo() {
    return getVscodeRepository(this.rootPath);
  }

  private rawPathSafe(args: string[]): Promise<string> {
    return this.git.raw(['-c', 'core.quotepath=false', ...args]);
  }

  resolveRepoPath(filePath: string): ResolvedRepoPath {
    return resolvePathWithinRepo(this.rootPath, filePath);
  }

  protected normalizeRepoPath(filePath: string): string {
    return resolvePathWithinRepo(this.rootPath, filePath, { allowAbsolute: true }).relativePath;
  }

  /**
   * `--` stops option parsing but Git still interprets pathspec magic such as
   * `:(glob)`. Prefix concrete repository paths with `:(literal)` so a valid
   * filename can never broaden a stage, restore, stash, or diff operation.
   */
  private literalPathspec(filePath: string): string {
    return `:(literal)${this.normalizeRepoPath(filePath)}`;
  }

  private literalPathspecs(filePaths: string[]): string[] {
    return filePaths.map(filePath => this.literalPathspec(filePath));
  }

  private safeRevisionArg(ref: string): string {
    const value = ref.trim();
    if (!value || value.startsWith('-') || value.includes('\0')) {
      throw new Error(`Invalid Git reference: ${ref}`);
    }
    return value;
  }

  /** Resolve a hash-like search term without treating it as a commit-message regexp. */
  private async resolveRevisionSearch(filterText?: string): Promise<string | null | undefined> {
    const query = filterText?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{7,64}$/.test(query)) return undefined;
    try {
      const resolved = (await this.git.raw(['rev-parse', '--verify', `${query}^{commit}`])).trim();
      return resolved || null;
    } catch {
      return null;
    }
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git.raw(['merge-base', '--is-ancestor', ancestor, this.safeRevisionArg(descendant)]);
      return true;
    } catch {
      return false;
    }
  }

  private readWorkingTreeFile(filePath: string): { content: string; isBinary: boolean } | undefined {
    const resolved = resolvePathWithinRepo(this.rootPath, filePath, { allowAbsolute: true });
    assertNoSymlinkAncestors(this.rootPath, resolved.absolutePath);
    try {
      const stat = fs.lstatSync(resolved.absolutePath);
      if (stat.isDirectory()) return undefined;
      const buffer = stat.isSymbolicLink()
        ? fs.readlinkSync(resolved.absolutePath, { encoding: 'buffer' })
        : stat.size > MAX_INLINE_DIFF_FILE_BYTES
          ? undefined
          : fs.readFileSync(resolved.absolutePath);
      if (!buffer) return { content: '', isBinary: true };
      const content = buffer.toString('utf8');
      const isBinary = buffer.includes(0) || !Buffer.from(content, 'utf8').equals(buffer);
      return { content: isBinary ? '' : content, isBinary };
    } catch {
      return undefined;
    }
  }

  private async showStageFileBuffer(stage: 1 | 2 | 3, filePath: string): Promise<Buffer> {
    const relPath = this.normalizeRepoPath(filePath);
    return this.git.showBuffer(`:${stage}:${relPath}`);
  }

  private async showStageFileBufferOrEmpty(stage: 1 | 2 | 3, filePath: string): Promise<Buffer> {
    try {
      return await this.showStageFileBuffer(stage, filePath);
    } catch {
      return Buffer.alloc(0);
    }
  }

  private async getSubmoduleStatuses(): Promise<Map<string, SubmoduleStatus>> {
    const statuses = new Map<string, SubmoduleStatus>();
    let raw = '';
    try {
      raw = await this.rawPathSafe(['status', '--porcelain=v2', '-z']);
    } catch {
      return statuses;
    }

    const entries = raw.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;

      let parts: string[] = [];
      if (entry.startsWith('1 ')) {
        parts = splitStatusEntry(entry, 9);
      } else if (entry.startsWith('2 ')) {
        parts = splitStatusEntry(entry, 10);
        i += 1; // Skip the original path entry for renames/copies.
      } else {
        continue;
      }

      const submoduleField = parts[2];
      const filePath = parts[parts.length - 1];
      if (!submoduleField?.startsWith('S') || !filePath) continue;

      statuses.set(filePath, {
        isSubmodule: true,
        hasGitlinkChange: submoduleField[1] !== '.',
        hasTrackedChanges: submoduleField[2] !== '.',
        hasUntrackedChanges: submoduleField[3] !== '.',
      });
    }

    return statuses;
  }

  private applySubmoduleStatus(file: FileStatus, submoduleStatuses: Map<string, SubmoduleStatus>): FileStatus | null {
    const submodule = submoduleStatuses.get(file.path);
    if (!submodule) return file;
    if (!submodule.hasGitlinkChange) {
      return null;
    }
    return { ...file, submodule };
  }

  async isGitRepo(): Promise<boolean> {
    const vsRepo = this.vsRepo();
    if (vsRepo) return true;
    try { await this.git.status(); return true; } catch { return false; }
  }

  /** Read status directly from git (bypasses VSCode's cached state). */
  async getStatusFresh(): Promise<RepoStatus> {
    const [status, branchInfo, submoduleStatuses, operationState] = await Promise.all([
      this.git.status(),
      this.getCurrentBranch(),
      this.getSubmoduleStatuses(),
      this.getOperationState(),
    ]);

    // Override aheadBehind with a direct git count — always attempt rev-list since
    // the VS Code API's HEAD.upstream can lag and arrive undefined even when a tracking
    // branch is configured, causing ahead/behind to be silently skipped.
    let freshBranchInfo = branchInfo;
    try {
      const [aheadRaw, behindRaw] = await Promise.all([
        this.git.raw(['rev-list', '--count', '@{u}..HEAD']),
        this.git.raw(['rev-list', '--count', 'HEAD..@{u}']),
      ]);
      const ahead = parseInt(aheadRaw.trim(), 10);
      const behind = parseInt(behindRaw.trim(), 10);
      if (!isNaN(ahead) && !isNaN(behind)) {
        freshBranchInfo = { ...branchInfo, aheadBehind: { ahead, behind } };
      }
    } catch { /* no upstream configured — leave aheadBehind as-is */ }

    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    let conflictCount = 0;

    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      if (!isSameOrChildPath(this.rootPath, absPath)) continue;
      const index = file.index.trim();
      const workingDir = file.working_dir.trim();

      if (index === 'U' || workingDir === 'U' || (index === 'A' && workingDir === 'A') || (index === 'D' && workingDir === 'D')) {
        conflictCount++;
        const conflictFile = this.applySubmoduleStatus(
          { repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'conflicted', staged: false, unstaged: true },
          submoduleStatuses,
        );
        if (conflictFile) unstagedFiles.push(conflictFile);
        continue;
      }
      if (index && index !== ' ' && index !== '?') {
        const stagedFile = this.applySubmoduleStatus(
          { repoId: this.repoId, path: file.path, absolutePath: absPath, status: STATUS_MAP[index] ?? 'modified', staged: true, unstaged: false },
          submoduleStatuses,
        );
        if (stagedFile) stagedFiles.push(stagedFile);
      }
      if (workingDir && workingDir !== ' ') {
        const unstagedFile = this.applySubmoduleStatus(
          {
            repoId: this.repoId,
            path: file.path,
            absolutePath: absPath,
            status: workingDir === '?' ? 'untracked' : (STATUS_MAP[workingDir] ?? 'modified'),
            staged: false,
            unstaged: true,
          },
          submoduleStatuses,
        );
        if (unstagedFile) unstagedFiles.push(unstagedFile);
      }
    }

    return { repoId: this.repoId, branch: freshBranchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount, operationState };
  }

  protected async assertPullAllowed(): Promise<void> {
    const status = await this.getStatusFresh();
    if (status.conflictCount > 0 || status.operationState) {
      throw new Error(t('Cannot pull while conflicts are unresolved or another version-control operation is in progress. Resolve the conflicts and complete or abort the current operation first.'));
    }
  }

  protected async assertCheckoutAllowed(): Promise<void> {
    const status = await this.getStatusFresh();
    if (status.conflictCount > 0 || status.operationState) {
      throw new Error(t('Cannot switch branches while conflicts are unresolved or another version-control operation is in progress. Resolve the conflicts and complete or abort the current operation first.'));
    }
  }

  protected async assertBranchOperationAllowed(): Promise<void> {
    const status = await this.getStatusFresh();
    if (status.conflictCount > 0 || status.operationState) {
      throw new Error(t('Cannot perform branch operations while conflicts are unresolved or another version-control operation is in progress. Resolve the conflicts and complete or abort the current operation first.'));
    }
  }

  private async getShortHash(): Promise<string | undefined> {
    try {
      return (await this.git.raw(['rev-parse', '--short', 'HEAD'])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveHeadName(hint?: string): Promise<string> {
    if (hint) return hint;
    try {
      const name = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return (name && name !== 'HEAD') ? name : (await this.git.raw(['branch', '--show-current'])).trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  private async getDetachedTag(vsTagName?: string): Promise<string | undefined> {
    // Highest priority: explicitly set after a tag checkout, before VS Code API updates.
    if (this._pendingDetachedTag) return this._pendingDetachedTag;
    // VS Code API already knows the exact tag name.
    if (vsTagName) return vsTagName;
    try {
      // git describe --tags --exact-match returns the tag whose ref IS HEAD,
      // which is precise when multiple tags point at the same commit.
      const tag = (await this.git.raw(['describe', '--tags', '--exact-match', 'HEAD'])).trim();
      return tag || undefined;
    } catch {
      try {
        const tag = (await this.git.raw(['tag', '--points-at', 'HEAD', '--sort=-creatordate'])).trim().split('\n')[0].trim();
        return tag || undefined;
      } catch {
        return undefined;
      }
    }
  }

  async getStatus(): Promise<RepoStatus> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      // VS Code API may transiently report head.name as undefined during a branch
      // checkout before it has finished updating its internal state. When head.name
      // is absent but the type is NOT a Tag, fall back to rev-parse.
      let resolvedBranchName: string | undefined = head?.name;
      if (!resolvedBranchName && head?.type !== RefType.Tag) {
        try {
          const raw = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          if (raw && raw !== 'HEAD') resolvedBranchName = raw;
        } catch { /* ignore, treat as genuinely detached */ }
      }
      const isDetached = !resolvedBranchName || head?.type === RefType.Tag;
      const branchName = isDetached ? 'HEAD' : resolvedBranchName!;
      // When type === Tag, head.name is the exact tag checked out
      const detachedTag = isDetached ? await this.getDetachedTag(head?.type === RefType.Tag ? head.name : undefined) : undefined;
      const detachedHash = (isDetached && !detachedTag)
        ? (head?.commit ? head.commit.slice(0, 8) : await this.getShortHash())
        : undefined;
      const branchInfo: BranchInfo = {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
        detachedTag,
        detachedHash,
      };

      const [submoduleStatuses, operationState] = await Promise.all([
        this.getSubmoduleStatuses(),
        this.getOperationState(),
      ]);
      const stagedFiles: FileStatus[] = [];
      const unstagedFiles: FileStatus[] = [];
      let conflictCount = 0;

      const makeFile = (change: import('./git.d').Change, staged: boolean): FileStatus | null => {
        if (!isSameOrChildPath(this.rootPath, change.uri.fsPath)) return null;
        const relPath = path.relative(this.rootPath, change.uri.fsPath).split(path.sep).join('/');
        const status = vsStatusToGitFileStatus(change.status);
        return {
          repoId: this.repoId,
          path: relPath,
          absolutePath: change.uri.fsPath,
          status,
          staged,
          unstaged: !staged,
        };
      };

      // VS Code API does not reliably track gitlink (submodule pointer) entries —
      // it may report them only in workingTreeChanges regardless of index state,
      // or in both simultaneously. Query their real staged/unstaged state via
      // simple-git porcelain and handle them separately.
      const submoduleRelPaths = await this.getSubmoduleRelativePaths();
      const submodulePorcelainFiles: FileStatus[] = [];
      if (submoduleRelPaths.size > 0) {
        const porcelain = await this.git.status();
        for (const file of porcelain.files) {
          if (!submoduleRelPaths.has(file.path)) continue;
          const absPath = path.join(this.rootPath, file.path);
          const index = file.index.trim();
          const workingDir = file.working_dir.trim();
          if (index && index !== ' ' && index !== '?') {
            submodulePorcelainFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'submodule', staged: true, unstaged: false });
          } else if (workingDir && workingDir !== ' ') {
            submodulePorcelainFiles.push({ repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'submodule', staged: false, unstaged: true });
          }
        }
      }

      for (const c of vsRepo.state.indexChanges) {
        const f = makeFile(c, true);
        if (!f) continue;
        // Submodule paths are handled via porcelain above
        if (submoduleRelPaths.has(f.path)) continue;
        if (f.status === 'conflicted') conflictCount++;
        else {
          const stagedFile = this.applySubmoduleStatus(f, submoduleStatuses);
          if (stagedFile) stagedFiles.push(stagedFile);
        }
      }
      for (const c of vsRepo.state.workingTreeChanges) {
        const f = makeFile(c, false);
        if (!f) continue;
        // Submodule paths are handled via porcelain above
        if (submoduleRelPaths.has(f.path)) continue;
        if (f.status === 'conflicted') conflictCount++;
        else {
          const unstagedFile = this.applySubmoduleStatus(f, submoduleStatuses);
          if (unstagedFile) unstagedFiles.push(unstagedFile);
        }
      }

      // Merge porcelain-resolved submodule entries
      for (const f of submodulePorcelainFiles) {
        if (f.staged) stagedFiles.push(f);
        else unstagedFiles.push(f);
      }
      for (const c of vsRepo.state.untrackedChanges) {
        const f = makeFile(c, false);
        if (!f) continue;
        const unstagedFile = this.applySubmoduleStatus(f, submoduleStatuses);
        if (unstagedFile) unstagedFiles.push(unstagedFile);
      }
      for (const c of vsRepo.state.mergeChanges) {
        if (!isSameOrChildPath(this.rootPath, c.uri.fsPath)) continue;
        conflictCount++;
        const relPath = path.relative(this.rootPath, c.uri.fsPath).split(path.sep).join('/');
        const conflictFile = this.applySubmoduleStatus({
          repoId: this.repoId,
          path: relPath,
          absolutePath: c.uri.fsPath,
          status: 'conflicted',
          staged: false,
          unstaged: true,
        }, submoduleStatuses);
        if (conflictFile) unstagedFiles.push(conflictFile);
      }

      return {
        repoId: this.repoId,
        branch: branchInfo,
        stagedFiles,
        unstagedFiles,
        isDetachedHead: isDetached,
        conflictCount,
        operationState,
      };
    }

    // Fallback: simple-git
    const [status, branchInfo, submoduleStatuses, operationState] = await Promise.all([
      this.git.status(),
      this.getCurrentBranch(),
      this.getSubmoduleStatuses(),
      this.getOperationState(),
    ]);

    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    let conflictCount = 0;

    for (const file of status.files) {
      const absPath = path.join(this.rootPath, file.path);
      if (!isSameOrChildPath(this.rootPath, absPath)) continue;
      const index = file.index.trim();
      const workingDir = file.working_dir.trim();

      if (index === 'U' || workingDir === 'U' || (index === 'A' && workingDir === 'A') || (index === 'D' && workingDir === 'D')) {
        conflictCount++;
        const conflictFile = this.applySubmoduleStatus(
          { repoId: this.repoId, path: file.path, absolutePath: absPath, status: 'conflicted', staged: false, unstaged: true },
          submoduleStatuses,
        );
        if (conflictFile) unstagedFiles.push(conflictFile);
        continue;
      }
      if (index && index !== ' ' && index !== '?') {
        const stagedFile = this.applySubmoduleStatus(
          { repoId: this.repoId, path: file.path, absolutePath: absPath, status: STATUS_MAP[index] ?? 'modified', staged: true, unstaged: false },
          submoduleStatuses,
        );
        if (stagedFile) stagedFiles.push(stagedFile);
      }
      if (workingDir && workingDir !== ' ') {
        const unstagedFile = this.applySubmoduleStatus(
          {
            repoId: this.repoId,
            path: file.path,
            absolutePath: absPath,
            status: workingDir === '?' ? 'untracked' : (STATUS_MAP[workingDir] ?? 'modified'),
            staged: false,
            unstaged: true,
          },
          submoduleStatuses,
        );
        if (unstagedFile) unstagedFiles.push(unstagedFile);
      }
    }

    return { repoId: this.repoId, branch: branchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount, operationState };
  }

  async getCurrentBranch(): Promise<BranchInfo> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      const vsTagName = head?.type === RefType.Tag ? head.name : undefined;
      // VS Code API may transiently report head.name as undefined during a branch
      // checkout before it has finished updating its internal state. When head.name
      // is absent but the type is NOT a Tag, fall back to rev-parse to check whether
      // we are actually on a named branch.
      let resolvedBranchName: string | undefined = head?.name;
      if (!resolvedBranchName && head?.type !== RefType.Tag) {
        try {
          const raw = (await this.git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
          if (raw && raw !== 'HEAD') resolvedBranchName = raw;
        } catch { /* ignore, treat as genuinely detached */ }
      }
      const isDetached = !resolvedBranchName || head?.type === RefType.Tag;
      const branchName = isDetached ? 'HEAD' : resolvedBranchName!;
      // If VS Code API now reports the same tag as pending, the update has arrived — clear it.
      if (this._pendingDetachedTag && vsTagName === this._pendingDetachedTag) {
        this._pendingDetachedTag = undefined;
      }
      // If VS Code API reports a branch (no longer detached), clear pending.
      if (!isDetached) this._pendingDetachedTag = undefined;
      const detachedTag = isDetached ? await this.getDetachedTag(vsTagName) : undefined;
      const detachedHash = (isDetached && !detachedTag)
        ? (head?.commit ? head.commit.slice(0, 8) : await this.getShortHash())
        : undefined;
      return {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? `HEAD` : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream: head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined,
        aheadBehind: (head?.ahead !== undefined && head?.behind !== undefined)
          ? { ahead: head.ahead, behind: head.behind }
          : undefined,
        detachedTag,
        detachedHash,
      };
    }
    const status = await this.git.status();
    const isDetached = status.detached;
    const branchName = await this.resolveHeadName(status.current ?? undefined);
    const detachedTag = isDetached ? await this.getDetachedTag() : undefined;
    const detachedHash = (isDetached && !detachedTag) ? await this.getShortHash() : undefined;
    return {
      repoId: this.repoId,
      name: branchName,
      fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
      isHead: true,
      isRemote: false,
      upstream: status.tracking ?? undefined,
      aheadBehind: status.tracking ? { ahead: status.ahead, behind: status.behind } : undefined,
      detachedTag,
      detachedHash,
    };
  }

  async getBranches(): Promise<BranchInfo[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      // getBranches({ remote: false }) returns local branches (RefType.Head),
      // getBranches({ remote: true }) returns remote-tracking branches (RefType.RemoteHead).
      // We filter by RefType to avoid duplicates if the API returns both in either call.
      const [localRefs, remoteRefs, trackingInfo] = await Promise.all([
        vsRepo.getBranches({ remote: false, sort: 'committerdate' }),
        vsRepo.getBranches({ remote: true,  sort: 'committerdate' }),
        this.getLocalBranchTrackingInfo(),
      ]);
      const head = vsRepo.state.HEAD;
      const branches: BranchInfo[] = [];
      const configuredRemoteNames = vsRepo.state.remotes.map(remote => remote.name).sort((a, b) => b.length - a.length);

      const headIsOnBranch = head?.type === RefType.Head;
      for (const ref of localRefs.filter(r => r.type === RefType.Head)) {
        const name = ref.name ?? '';
        const isHead = headIsOnBranch && name === head?.name;
        const tracking = trackingInfo.get(name);
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/heads/${name}`,
          isHead,
          isRemote: false,
          upstream: tracking?.upstream,
          lastCommitHash: ref.commit,
          aheadBehind: tracking?.aheadBehind
            ?? ((isHead && head!.ahead !== undefined && head!.behind !== undefined)
              ? { ahead: head!.ahead, behind: head!.behind }
              : undefined),
        });
      }

      for (const ref of remoteRefs.filter(r => r.type === RefType.RemoteHead)) {
        const name = ref.name ?? '';
        if (name.endsWith('/HEAD')) continue;
        const remoteName = configuredRemoteNames.find(remote => name.startsWith(`${remote}/`))
          ?? ref.remote
          ?? name.split('/')[0];
        branches.push({
          repoId: this.repoId,
          name,
          fullName: `refs/remotes/${name}`,
          isHead: false,
          isRemote: true,
          remoteName,
          lastCommitHash: ref.commit,
        });
      }

      return branches;
    }

    // Fallback: simple-git
    // Fetch full hashes for all branches separately (simple-git returns short hashes)
    const fullHashMap = new Map<string, string>();
    try {
      const forEachRefRaw = await this.git.raw(['for-each-ref', '--format=%(objectname) %(refname:short)', 'refs/heads/', 'refs/remotes/']);
      for (const line of forEachRefRaw.trim().split('\n')) {
        const [hash, name] = line.trim().split(' ');
        if (hash && name) fullHashMap.set(name, hash);
      }
    } catch { /* ignore, fall back to short hashes */ }
    const result = await this.git.branch(['-avv', '--sort=-committerdate']);
    const branches: BranchInfo[] = [];
    const configuredRemoteNames = (await this.getRemotes().catch(() => [] as string[])).sort((a, b) => b.length - a.length);
    for (const [name, branch] of Object.entries(result.branches)) {
      // Skip the detached HEAD pseudo-entry (e.g. "(HEAD detached at a9b68a1)")
      if (branch.current && name.startsWith('(HEAD detached')) continue;
      const isRemote = name.startsWith('remotes/');
      const cleanName = isRemote ? name.replace(/^remotes\//, '') : name;
      if (isRemote && cleanName.endsWith('/HEAD')) continue;
      const remoteName = isRemote
        ? configuredRemoteNames.find(remote => cleanName.startsWith(`${remote}/`)) ?? cleanName.split('/')[0]
        : undefined;
      let aheadBehind: { ahead: number; behind: number } | undefined;
      const full = branch.label?.match(/\[.+?: ahead (\d+), behind (\d+)\]/);
      const aheadOnly = branch.label?.match(/\[.+?: ahead (\d+)\]/);
      const behindOnly = branch.label?.match(/\[.+?: behind (\d+)\]/);
      if (full) aheadBehind = { ahead: parseInt(full[1], 10), behind: parseInt(full[2], 10) };
      else if (aheadOnly) aheadBehind = { ahead: parseInt(aheadOnly[1], 10), behind: 0 };
      else if (behindOnly) aheadBehind = { ahead: 0, behind: parseInt(behindOnly[1], 10) };
      branches.push({
        repoId: this.repoId,
        name: cleanName,
        fullName: isRemote ? `refs/remotes/${cleanName}` : `refs/heads/${cleanName}`,
        isHead: branch.current,
        isRemote,
        remoteName,
        lastCommitHash: fullHashMap.get(cleanName) ?? branch.commit,
        aheadBehind,
      });
    }
    return branches;
  }

  private async getLocalBranchTrackingInfo(): Promise<Map<string, BranchTrackingInfo>> {
    const map = new Map<string, BranchTrackingInfo>();
    try {
      const raw = await this.git.raw([
        'for-each-ref',
        '--format=%(refname:short)%00%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)%00%(upstream:track)',
        'refs/heads/',
      ]);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const [name, upstream, upstreamRemote, upstreamRemoteRef, track] = line.split('\0');
        if (!name) continue;
        const aheadBehind = parseAheadBehindTrack(track ?? '');
        map.set(name, {
          upstream: upstream || undefined,
          upstreamRemote: upstreamRemote || undefined,
          upstreamRemoteRef: upstreamRemoteRef || undefined,
          aheadBehind,
        });
      }
    } catch {
      // Branch list rendering should not fail just because tracking metadata is unavailable.
    }
    return map;
  }

  async pullBranch(branchName: string): Promise<string> {
    const currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    if (!branchName || currentBranch === branchName) {
      return this.pull();
    }

    await this.assertPullAllowed();

    const tracking = (await this.getLocalBranchTrackingInfo()).get(branchName);
    if (!tracking?.upstreamRemote || !tracking.upstreamRemoteRef) {
      return `No remote tracking branch for ${branchName} — skipped`;
    }

    await this.git.raw([
      'fetch',
      tracking.upstreamRemote,
      `${tracking.upstreamRemoteRef}:refs/heads/${branchName}`,
    ]);

    const updated = (await this.getLocalBranchTrackingInfo()).get(branchName);
    const behind = updated?.aheadBehind?.behind ?? 0;
    const ahead = updated?.aheadBehind?.ahead ?? 0;
    return behind === 0
      ? `pulled ${branchName}`
      : `pulled ${branchName}, still ahead ${ahead} behind ${behind}`;
  }

  // Log uses raw git format for graph rendering — VS Code API's log() lacks graph parents/refs.
  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange; worktreeServices?: GitService[] }): Promise<CommitNode[]> {
    const revisionSearch = await this.resolveRevisionSearch(opts?.filterText);
    if (revisionSearch !== undefined && (skip > 0 || !revisionSearch)) return [];
    if (revisionSearch !== undefined && opts?.filterBranch && !(await this.isAncestor(revisionSearch, opts.filterBranch))) {
      return [];
    }

    const args: string[] = [
      'log',
      '--topo-order',
      `--max-count=${revisionSearch ? 1 : limit}`, `--skip=${revisionSearch ? 0 : skip}`,
      LOG_RECORD_FORMAT,
      '--date=iso-strict',
    ];
    const lineRangeFilterPath = opts?.filterPath;
    const lineRange = lineRangeFilterPath && opts?.lineRange ? opts.lineRange : undefined;
    if (lineRange) args.push('--no-patch');
    if (revisionSearch) args.push(this.safeRevisionArg(revisionSearch));
    else if (opts?.filterText) args.push(`--grep=${opts.filterText}`, '--regexp-ignore-case');
    if (opts?.filterAuthor) args.push(`--author=${opts.filterAuthor}`, '--regexp-ignore-case');
    if (opts?.filterDateFrom) args.push(`--after=${opts.filterDateFrom}`);
    if (opts?.filterDateTo) args.push(`--before=${opts.filterDateTo}`);
    if (revisionSearch) {
      // The resolved hash is already the exact revision to display.
    } else if (lineRange) {
      args.push('-L', `${lineRange.start},${lineRange.end}:${lineRangeFilterPath}`);
      args.push(this.safeRevisionArg(opts?.filterBranch || 'HEAD'));
    } else if (opts?.filterBranch) {
      args.push(this.safeRevisionArg(opts.filterBranch));
    } else {
      args.push('--exclude=refs/stash', '--exclude=refs/versiondock/ai-composer/*', '--all');
    }
    if (opts?.filterPath && !lineRange) args.push('--', this.literalPathspec(opts.filterPath));
    const [raw, refsByHash] = await Promise.all([
      this.git.raw(args),
      this.getDecoratedRefsByCommit(),
    ]);
    const commits = parseLogOutput(raw, this.repoId, refsByHash);

    // Mark unpushed commits: hashes ahead of the remote tracking branch.
    // 'all' means there is no upstream — every commit on this branch is local.
    const worktreeServices = opts?.worktreeServices ?? [];
    const [unpushedHashes, incomingHashes, ...worktreeUnpushedResults] = await Promise.all([
      this.getUnpushedHashes(),
      this.getIncomingHashes(),
      ...worktreeServices.map(wt => wt.getUnpushedHashes()),
    ]);
    const allUnpushedHashes = new Set<string>();
    if (unpushedHashes === 'all') {
      for (const c of commits) c.unpushed = true;
    } else {
      unpushedHashes.forEach(h => allUnpushedHashes.add(h));
    }
    for (const wtResult of worktreeUnpushedResults) {
      if (wtResult !== 'all') wtResult.forEach(h => allUnpushedHashes.add(h));
    }
    if (allUnpushedHashes.size > 0) {
      for (const c of commits) {
        if (allUnpushedHashes.has(c.hash)) c.unpushed = true;
      }
    }
    for (const c of commits) {
      if (incomingHashes.has(c.hash)) c.incoming = true;
    }

    return commits;
  }

  async getCompareLog(
    limit: number,
    skip: number,
    opts: {
      baseRef: string;
      targetRef: string;
      side: import('../types/messages').CompareSide;
      filterText?: string;
      filterAuthor?: string;
      filterBranch?: string;
      filterDateFrom?: string;
      filterDateTo?: string;
      filterPath?: string;
    },
  ): Promise<CommitNode[]> {
    const baseRef = this.safeRevisionArg(opts.baseRef);
    const targetRef = this.safeRevisionArg(opts.targetRef);
    const revisionSearch = await this.resolveRevisionSearch(opts.filterText);
    if (revisionSearch !== undefined) {
      if (!revisionSearch || skip > 0) return [];
      const [inBase, inTarget] = await Promise.all([
        this.isAncestor(revisionSearch, baseRef),
        this.isAncestor(revisionSearch, targetRef),
      ]);
      const matchesSide = opts.side === 'baseOnly'
        ? inBase && !inTarget
        : inTarget && !inBase;
      if (!matchesSide) return [];
    }
    const range = opts.side === 'baseOnly'
      ? `${targetRef}..${baseRef}`
      : `${baseRef}..${targetRef}`;
    const args: string[] = [
      'log',
      `--max-count=${revisionSearch ? 1 : limit}`,
      `--skip=${revisionSearch ? 0 : skip}`,
      LOG_RECORD_FORMAT,
      '--date=iso-strict',
    ];
    if (revisionSearch) args.push(this.safeRevisionArg(revisionSearch));
    else if (opts.filterText) args.push(`--grep=${opts.filterText}`, '--regexp-ignore-case');
    if (opts.filterAuthor) args.push(`--author=${opts.filterAuthor}`, '--regexp-ignore-case');
    if (opts.filterDateFrom) args.push(`--after=${opts.filterDateFrom}`);
    if (opts.filterDateTo) args.push(`--before=${opts.filterDateTo}`);
    if (!revisionSearch) args.push(range);
    if (opts.filterPath) args.push('--', this.literalPathspec(opts.filterPath));
    const [raw, refsByHash] = await Promise.all([
      this.git.raw(args),
      this.getDecoratedRefsByCommit(),
    ]);
    return parseLogOutput(raw, this.repoId, refsByHash);
  }

  /**
   * Build decorations without relying on `%(decorate:separator=...)`, which is
   * only interpreted by newer Git versions. Older Git releases can exit 0 while
   * emitting that atom literally, and `%D` cannot represent refs containing a
   * comma without ambiguity. Full refs also keep branch/tag names distinct.
   */
  private async getDecoratedRefsByCommit(): Promise<Map<string, string[]>> {
    const [rawRefs, headHash] = await Promise.all([
      this.git.raw([
        'for-each-ref',
        '--format=%(objectname)%00%(*objectname)%00%(refname)%00%(HEAD)',
        'refs/heads/',
        'refs/remotes/',
        'refs/tags/',
      ]).catch(() => ''),
      this.git.raw(['rev-parse', '--verify', 'HEAD']).then(value => value.trim()).catch(() => ''),
    ]);

    const refsByHash = new Map<string, string[]>();
    let attachedHead = false;
    const addRef = (hash: string, ref: string) => {
      if (!hash || !ref) return;
      const refs = refsByHash.get(hash) ?? [];
      if (!refs.includes(ref)) refs.push(ref);
      refsByHash.set(hash, refs);
    };

    for (const line of rawRefs.split('\n')) {
      if (!line) continue;
      const [objectHash, peeledHash, refName, headMarker] = line.split('\0');
      const commitHash = peeledHash || objectHash;
      if (!commitHash || !refName) continue;
      addRef(commitHash, refName);
      if (headMarker?.trim() === '*') {
        attachedHead = true;
        addRef(commitHash, `HEAD -> ${refName}`);
      }
    }

    if (!attachedHead && headHash) addRef(headHash, 'HEAD');
    return refsByHash;
  }

  private async getUnpushedHashes(): Promise<Set<string> | 'all'> {
    try {
      const upstreamTracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (upstreamTracking) {
        const raw = await this.git.raw(['log', '--format=%H', `${upstreamTracking}..HEAD`]);
        return new Set(raw.trim().split('\n').filter(Boolean));
      }
      // No tracking branch — check if any remote refs exist
      const remoteRefs = (await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/']).catch(() => '')).trim();
      if (!remoteRefs) return 'all'; // no remotes at all → every commit is local
      // Remotes exist but no tracking → commits not reachable from any remote ref
      const raw = await this.git.raw(['log', '--format=%H', 'HEAD', '--not', '--remotes']);
      return new Set(raw.trim().split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async getUnpushedCount(): Promise<number> {
    try {
      const upstreamTracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (upstreamTracking) {
        const raw = await this.git.raw(['rev-list', '--count', `${upstreamTracking}..HEAD`]);
        return parseInt(raw.trim(), 10) || 0;
      }
      const remoteRefs = (await this.git.raw(['for-each-ref', '--format=%(refname)', 'refs/remotes/']).catch(() => '')).trim();
      if (!remoteRefs) {
        const raw = await this.git.raw(['rev-list', '--count', 'HEAD']);
        return parseInt(raw.trim(), 10) || 0;
      }
      const raw = await this.git.raw(['rev-list', '--count', 'HEAD', '--not', '--remotes']);
      return parseInt(raw.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  private async getIncomingHashes(): Promise<Set<string>> {
    try {
      const vsRepo = this.vsRepo();
      if (vsRepo) {
        const upstream = vsRepo.state.HEAD?.upstream;
        if (upstream) {
          if ((vsRepo.state.HEAD?.behind ?? 0) === 0) return new Set();
          const upstreamRef = `${upstream.remote}/${upstream.name}`;
          const raw = await this.git.raw(['log', '--format=%H', `HEAD..${upstreamRef}`]);
          return new Set(raw.trim().split('\n').filter(Boolean));
        }
        return new Set();
      }
      const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (!tracking) return new Set();
      const raw = await this.git.raw(['log', '--format=%H', `HEAD..${tracking}`]);
      return new Set(raw.trim().split('\n').filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async getMergeCommits(hash: string, parents: string[]): Promise<import('../types/messages').MergeParentCommit[]> {
    const result: import('../types/messages').MergeParentCommit[] = [];
    // parents[0] is the main branch tip, parents[1..] are the merged-in branches.
    // For each secondary parent, list commits that it introduced (not in parents[0]).
    for (let i = 1; i < parents.length; i++) {
      const range = `${parents[0]}..${parents[i]}`;
      const raw = await this.git.raw([
        'log', range,
        '--format=%H%x00%h%x00%an%x00%ai%x00%s',
      ]).catch(() => '');
      for (const line of raw.trim().split('\n')) {
        if (!line.trim()) continue;
        const [h, sh, an, ad, ...msgParts] = line.split('\x00');
        result.push({ hash: h, shortHash: sh, message: msgParts.join('\x00'), authorName: an, authorDate: ad, parentIndex: i });
      }
    }
    return result;
  }

  async getCommitFiles(hash: string, knownParents?: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    // For merge commits, diff-tree uses combined diff and omits most files.
    // Diff against first parent instead to get the full file list.
    let parents = knownParents;
    if (!parents) {
      const raw = await this.git.raw(['log', '-1', '--format=%P', hash]).catch(() => '');
      parents = raw.trim().split(' ').filter(Boolean);
    }
    const isMerge = parents.length >= 2;

    const baseArgs = isMerge
      ? ['diff', '--name-status', '-z', '-M', parents[0], hash]
      : ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', hash];
    const numArgs = isMerge
      ? ['diff', '--numstat', '-z', '-M', parents[0], hash]
      : ['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--numstat', hash];

    const [nameStatus, numStat] = await Promise.all([
      this.rawPathSafe(baseArgs),
      this.rawPathSafe(numArgs),
    ]);
    const stats = parseNumStatZOutput(numStat);
    const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
    for (const file of parseNameStatusZOutput(nameStatus)) {
      const stat = stats.get(file.path);
      files.push({
        status: file.code.replace(/\d+$/, ''),
        path: file.path,
        added: stat?.added,
        removed: stat?.removed,
      });
    }
    return files;
  }

  async getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
      const vsRepo = this.vsRepo();
      const commitLine = (await this.git.raw(['rev-list', '--parents', '-n', '1', hash])).trim().split(/\s+/);
      const parent = commitLine[1];
      let candidatePaths = [relPath];
      if (parent) {
        // A path-limited `git show` sees a rename as delete+add because its
        // counterpart is outside the pathspec. Resolve rename metadata from the
        // cheap full name-status list, then request both sides of the pair.
        const nameStatus = await this.rawPathSafe(['diff', '--name-status', '-z', '-M', parent, hash]);
        const file = parseNameStatusZOutput(nameStatus).find(entry => entry.path === relPath || entry.oldPath === relPath);
        if (file) candidatePaths = Array.from(new Set([file.oldPath, file.path].filter((value): value is string => Boolean(value))));
      }
      // Options must precede `--`; putting --format= after the path separator
      // makes Git treat it as another filename and leaves commit headers in the
      // payload.
      const rawDiff = parent
        ? await this.rawPathSafe(['diff', '--find-renames', parent, hash, '--', ...this.literalPathspecs(candidatePaths)])
        : await this.rawPathSafe(['show', '--format=', hash, '--', this.literalPathspec(relPath)]);
      const diffs = parseDiff(rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs.find(entry => entry.newPath === relPath || entry.oldPath === relPath) ?? diffs[0];
      if (diff.isBinary) return diff;
      const originalPath = this.normalizeRepoPath(diff.oldPath || relPath);
      const modifiedPath = this.normalizeRepoPath(diff.newPath || relPath);
      if (vsRepo) {
        diff.originalContent = await vsRepo.show(`${hash}~1`, originalPath).catch(() => '');
        diff.modifiedContent = await vsRepo.show(hash, modifiedPath).catch(() => '');
      } else {
        diff.originalContent = await this.git.raw(['show', `${hash}~1:${originalPath}`]).catch(() => '');
        diff.modifiedContent = await this.git.raw(['show', `${hash}:${modifiedPath}`]).catch(() => '');
      }
      return diff;
    } catch { return null; }
  }

  async getStagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
      const vsRepo = this.vsRepo();
      const rawDiff = vsRepo
        ? await vsRepo.diffIndexWithHEAD(relPath)
        : await this.rawPathSafe(['diff', '--staged', '--', this.literalPathspec(relPath)]);
      const diffs = parseDiff(rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      if (diff.isBinary) return diff;
      const workingFile = this.readWorkingTreeFile(relPath);
      if (workingFile?.isBinary) {
        diff.isBinary = true;
        diff.hunks = [];
        return diff;
      }
      if (vsRepo) {
        diff.originalContent = await vsRepo.show('HEAD', relPath).catch(() => '');
        diff.modifiedContent = await vsRepo.show('', relPath).catch(() => {
          return workingFile?.content ?? '';
        });
      } else {
        diff.originalContent = await this.git.show([`HEAD:${relPath}`]).catch(() => '');
        diff.modifiedContent = await this.git.raw(['show', `:${relPath}`]).catch(() => {
          return workingFile?.content ?? '';
        });
      }
      return diff;
    } catch { return null; }
  }

  async getUnstagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
      const vsRepo = this.vsRepo();
      // Repository.diffWithHEAD(path) is `git diff HEAD`: it also includes
      // staged changes. The working-tree section must remain strictly unstaged,
      // matching `git diff -- <path>` and the simple-git fallback.
      const rawDiff = await this.rawPathSafe(['diff', '--', this.literalPathspec(relPath)]);
      if (!rawDiff) {
        const workingFile = this.readWorkingTreeFile(relPath);
        if (!workingFile) return null;
        return { repoId, oldPath: relPath, newPath: relPath, isBinary: workingFile.isBinary, isNew: true, isDeleted: false, hunks: [], originalContent: '', modifiedContent: workingFile.content, language: detectLanguage(relPath) };
      }
      const diffs = parseDiff(rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      if (diff.isBinary) return diff;
      const workingFile = this.readWorkingTreeFile(relPath);
      if (workingFile?.isBinary) {
        diff.isBinary = true;
        diff.hunks = [];
        diff.originalContent = '';
        diff.modifiedContent = '';
        return diff;
      }
      // `git diff` compares index → working tree, so the left side must be the
      // index version (not HEAD when the same file is both staged and modified).
      diff.originalContent = vsRepo
        ? await vsRepo.show('', relPath).catch(() => this.git.raw(['show', `:${relPath}`]).catch(() => ''))
        : await this.git.raw(['show', `:${relPath}`]).catch(() => '');
      diff.modifiedContent = workingFile?.content ?? '';
      return diff;
    } catch { return null; }
  }

  async getWorktreeDiffFiles(baseRef: string): Promise<FileStatus[]> {
    const safeBaseRef = this.safeRevisionArg(baseRef);
    const [worktreeOutput, worktreeNumStat, untrackedOutput] = await Promise.all([
      this.rawPathSafe(['diff', '--name-status', '-z', '-M', safeBaseRef, '--']),
      this.rawPathSafe(['diff', '--numstat', '-z', '-M', safeBaseRef, '--']),
      this.rawPathSafe(['ls-files', '--others', '--exclude-standard', '-z']).catch(() => ''),
    ]);

    const numStatMap = parseNumStatZOutput(worktreeNumStat);

    const merged = new Map<string, FileStatus>();
    for (const file of parseNameStatusZOutput(worktreeOutput)) {
      const stats = numStatMap.get(file.path);
      merged.set(file.path, {
        repoId: this.repoId,
        path: file.path,
        absolutePath: path.join(this.rootPath, file.path),
        oldPath: file.oldPath,
        status: file.status,
        staged: false,
        unstaged: true,
        added: stats?.added,
        removed: stats?.removed,
      });
    }

    for (const filePath of untrackedOutput.split('\0')) {
      if (!filePath) continue;
      merged.set(filePath, {
        repoId: this.repoId,
        path: filePath,
        absolutePath: path.join(this.rootPath, filePath),
        status: 'untracked',
        staged: false,
        unstaged: true,
      });
    }

    return Array.from(merged.values()).sort((left, right) => left.path.localeCompare(right.path));
  }

  async getWorktreeFileDiff(repoId: string, baseRef: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
      const safeBaseRef = this.safeRevisionArg(baseRef);
      const rawDiff = await this.rawPathSafe(['diff', '--find-renames', safeBaseRef, '--', this.literalPathspec(relPath)]);
      if (!rawDiff.trim()) {
        const workingFile = this.readWorkingTreeFile(relPath);
        if (!workingFile) return null;
        return {
          repoId,
          oldPath: relPath,
          newPath: relPath,
          isBinary: workingFile.isBinary,
          isNew: true,
          isDeleted: false,
          hunks: [],
          originalContent: '',
          modifiedContent: workingFile.content,
          language: detectLanguage(relPath),
        };
      }

      const diffs = parseDiff(rawDiff, repoId);
      if (diffs.length === 0) return null;
      const diff = diffs[0];
      if (diff.isBinary) return diff;
      const originalPath = this.normalizeRepoPath(diff.oldPath || relPath);
      const workingFile = this.readWorkingTreeFile(diff.newPath || relPath);
      diff.originalContent = await this.git.show([`${safeBaseRef}:${originalPath}`]).catch(() => '');
      if (workingFile?.isBinary) {
        diff.isBinary = true;
        diff.hunks = [];
        diff.originalContent = '';
        diff.modifiedContent = '';
        return diff;
      }
      diff.modifiedContent = workingFile?.content ?? '';
      return diff;
    } catch {
      return null;
    }
  }

  async hasUncommittedChanges(): Promise<boolean> {
    const status = await this.git.status();
    return status.files.length > 0;
  }

  async listTopLevelSubtreeCandidates(): Promise<string[]> {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.rootPath, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter(entry => entry.isDirectory() && !SUBTREE_CANDIDATE_SKIP_DIRS.has(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }

  async isPathEmptyOrMissing(prefix: string): Promise<boolean> {
    const relPath = this.normalizeRepoPath(prefix);
    if (!relPath) return false;
    const absPath = path.join(this.rootPath, relPath);
    assertNoSymlinkAncestors(this.rootPath, absPath);
    if (!fs.existsSync(absPath)) return true;
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) return false;
    if (!stat.isDirectory()) return false;
    return fs.readdirSync(absPath).length === 0;
  }

  private subtreePrefixArg(prefix: string): string {
    return `--prefix=${this.normalizeRepoPath(prefix)}`;
  }

  async listSubtreeRepositoryRefs(repository: string): Promise<Array<{ name: string; type: 'branch' | 'tag' }>> {
    const output = await this.rawPathSafe(['ls-remote', '--heads', '--tags', repository]);
    const refs: Array<{ name: string; type: 'branch' | 'tag' }> = [];
    const seen = new Set<string>();
    for (const line of output.split('\n')) {
      const [, refName] = line.trim().split(/\s+/);
      if (!refName || refName.endsWith('^{}')) continue;
      const branchPrefix = 'refs/heads/';
      const tagPrefix = 'refs/tags/';
      const type = refName.startsWith(branchPrefix)
        ? 'branch'
        : refName.startsWith(tagPrefix)
          ? 'tag'
          : undefined;
      if (!type) continue;
      const name = refName.slice(type === 'branch' ? branchPrefix.length : tagPrefix.length);
      const key = `${type}:${name}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      refs.push({ name, type });
    }
    return refs;
  }

  async addSubtree(prefix: string, repository: string, ref: string, squash: boolean, message?: string): Promise<string> {
    const args = ['subtree', 'add', this.subtreePrefixArg(prefix)];
    if (squash) args.push('--squash');
    if (message?.trim()) args.push('-m', message.trim());
    args.push(repository, ref);
    return this.rawPathSafe(args);
  }

  async pullSubtree(prefix: string, repository: string, ref: string, squash: boolean, message?: string): Promise<string> {
    await this.assertPullAllowed();
    const args = ['subtree', 'pull', this.subtreePrefixArg(prefix)];
    if (squash) args.push('--squash');
    if (message?.trim()) args.push('-m', message.trim());
    args.push(repository, ref);
    return this.rawPathSafe(args);
  }

  async pushSubtree(prefix: string, repository: string, refspec: string): Promise<string> {
    return this.rawPathSafe(['subtree', 'push', this.subtreePrefixArg(prefix), repository, refspec]);
  }

  private parseSubtreeSplitHash(output: string): string | undefined {
    const matches = output.match(/\b[0-9a-f]{40}\b/gi);
    return matches?.[matches.length - 1]?.toLowerCase();
  }

  private normalizeSubtreeRemoteRef(refspec: string): string {
    const trimmed = refspec.trim().replace(/^\+/, '');
    const colonIndex = trimmed.lastIndexOf(':');
    return (colonIndex >= 0 ? trimmed.slice(colonIndex + 1) : trimmed).trim();
  }

  private subtreeRemoteRefCandidates(refspec: string): string[] {
    const ref = this.normalizeSubtreeRemoteRef(refspec);
    if (!ref) return [];
    if (ref.startsWith('refs/')) return [ref];
    return [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
  }

  private async getSubtreeRemoteHash(repository: string, refspec: string): Promise<{ hash?: string; ref?: string }> {
    const candidates = this.subtreeRemoteRefCandidates(refspec);
    if (candidates.length === 0) return {};
    const output = await this.rawPathSafe(['ls-remote', repository, ...candidates]);
    const rows = output.split('\n')
      .map(line => {
        const [hash, ref] = line.trim().split(/\s+/);
        return hash && ref && /^[0-9a-f]{40}$/i.test(hash) ? { hash: hash.toLowerCase(), ref } : undefined;
      })
      .filter((row): row is { hash: string; ref: string } => Boolean(row));
    for (const candidate of candidates) {
      const exact = rows.find(row => row.ref === candidate);
      if (exact) return exact;
    }
    return rows[0] ?? {};
  }

  async getSubtreePushStatus(prefix: string, repository: string, refspec: string): Promise<SubtreePushStatus> {
    const splitOutput = await this.rawPathSafe(['subtree', 'split', this.subtreePrefixArg(prefix)]);
    const splitHash = this.parseSubtreeSplitHash(splitOutput);
    if (!splitHash) {
      throw new Error(t('Cannot determine subtree split commit.'));
    }

    const remote = await this.getSubtreeRemoteHash(repository, refspec);
    if (!remote.hash) {
      const aheadCount = Number.parseInt((await this.git.raw(['rev-list', '--count', splitHash])).trim(), 10);
      return {
        aheadCount: Number.isFinite(aheadCount) ? aheadCount : undefined,
        hasUpdates: true,
        remoteRef: this.normalizeSubtreeRemoteRef(refspec),
        splitHash,
      };
    }

    if (remote.hash === splitHash) {
      return {
        aheadCount: 0,
        hasUpdates: false,
        remoteRef: remote.ref,
        splitHash,
        remoteHash: remote.hash,
      };
    }

    const remoteCommitExists = await this.git.raw(['cat-file', '-e', `${remote.hash}^{commit}`])
      .then(() => true)
      .catch(() => false);
    if (!remoteCommitExists) {
      return {
        hasUpdates: true,
        remoteRef: remote.ref,
        splitHash,
        remoteHash: remote.hash,
        error: t('Remote subtree commit is not available locally; update count may be unavailable.'),
      };
    }

    const aheadCount = Number.parseInt((await this.git.raw(['rev-list', '--count', `${remote.hash}..${splitHash}`])).trim(), 10);
    return {
      aheadCount: Number.isFinite(aheadCount) ? aheadCount : undefined,
      hasUpdates: true,
      remoteRef: remote.ref,
      splitHash,
      remoteHash: remote.hash,
    };
  }

  async splitSubtree(
    prefix: string,
    branch?: string,
    annotate?: string,
    rejoin?: boolean,
    onto?: string,
    commit?: string,
  ): Promise<string> {
    const args = ['subtree', 'split', this.subtreePrefixArg(prefix)];
    if (branch?.trim()) args.push('--branch', branch.trim());
    if (annotate?.trim()) args.push('--annotate', annotate.trim());
    if (onto?.trim()) args.push('--onto', onto.trim());
    if (rejoin) args.push('--rejoin');
    if (commit?.trim()) args.push(commit.trim());
    return this.rawPathSafe(args);
  }

  async mergeSubtree(prefix: string, commit: string, squash: boolean, message?: string): Promise<string> {
    const args = ['subtree', 'merge', this.subtreePrefixArg(prefix)];
    if (squash) args.push('--squash');
    if (message?.trim()) args.push('-m', message.trim());
    args.push(commit);
    return this.rawPathSafe(args);
  }

  async removeSubtree(prefix: string): Promise<string> {
    const relPath = this.normalizeRepoPath(prefix);
    return this.rawPathSafe(['rm', '-r', '--', this.literalPathspec(relPath)]);
  }

  async stageFiles(paths: string[]): Promise<void> {
    const safePaths = paths.map(filePath => this.normalizeRepoPath(filePath));
    const vsRepo = this.vsRepo();
    // Always use simple-git for gitlink (submodule pointer) entries —
    // vsRepo.add() silently ignores mode-160000 entries.
    const submodulePaths = await this.getSubmoduleRelativePaths();
    const [gitlinkPaths, regularPaths] = safePaths.reduce<[string[], string[]]>(
      ([gl, reg], p) => submodulePaths.has(p) ? [[...gl, p], reg] : [gl, [...reg, p]],
      [[], []]
    );
    if (gitlinkPaths.length > 0) {
      // Distinguish two cases that both show ' M' in the parent's porcelain:
      //   1. Submodule has a new commit (HEAD differs from parent's recorded pointer) → stageable (+prefix in submodule status)
      //   2. Submodule only has uncommitted working-tree changes, no new commit → NOT stageable (no prefix, or - for uninit)
      const submoduleStatusRaw = await this.git.raw(['submodule', 'status', '--', ...this.literalPathspecs(gitlinkPaths)]).catch(() => '');
      // Each line: <prefix><sha> <path> (<describe>)
      // prefix: ' ' = matches parent index, '+' = different commit, '-' = uninitialised, 'U' = merge conflict
      const submoduleHasNewCommit = new Set<string>();
      for (const line of submoduleStatusRaw.split('\n')) {
        const parsed = parseSubmoduleStatusLine(line);
        if (parsed?.flag === '+') submoduleHasNewCommit.add(parsed.path);
      }
      const notStageable = gitlinkPaths.filter(p => {
        const porcelain = submoduleHasNewCommit.has(p);
        return !porcelain; // not stageable if no new commit
      });
      if (notStageable.length > 0) {
        const names = notStageable.map(p => path.basename(p)).join(', ');
        throw new Error(
          `Cannot stage ${names}: the submodule has uncommitted changes but no new commit. ` +
          `Commit inside the submodule first, then stage the pointer here.`
        );
      }
      await this.git.raw(['add', '--', ...this.literalPathspecs(gitlinkPaths)]);
    }
    if (regularPaths.length > 0) {
      if (vsRepo) {
        await vsRepo.add(regularPaths.map(p => path.resolve(this.rootPath, p)));
      } else {
        await this.git.raw(['add', '--', ...this.literalPathspecs(regularPaths)]);
      }
    }
  }

  async getConflictFiles(): Promise<string[]> {
    const output = await this.rawPathSafe(['diff', '--name-only', '--diff-filter=U', '-z']);
    return output.split('\0').filter(Boolean);
  }

  async getConflictFileStatuses(): Promise<Map<string, { currentStatus: ConflictSideStatus; incomingStatus: ConflictSideStatus }>> {
    const output = await this.rawPathSafe(['status', '--porcelain', '-z']);
    const statuses = new Map<string, { currentStatus: ConflictSideStatus; incomingStatus: ConflictSideStatus }>();
    for (const entry of output.split('\0')) {
      if (entry.length < 4) continue;
      const x = entry[0];
      const y = entry[1];
      const sideStatuses = mapConflictSideStatuses(`${x}${y}`);
      if (!sideStatuses) continue;
      const filePath = entry.slice(3);
      if (!filePath) continue;
      statuses.set(filePath, sideStatuses);
    }
    return statuses;
  }

  async getFileVersions(filePath: string): Promise<MergeFileVersions> {
    const relPath = this.normalizeRepoPath(filePath);
    try {
      const buffers = await Promise.all([
        this.showStageFileBufferOrEmpty(1, relPath),
        this.showStageFileBufferOrEmpty(2, relPath),
        this.showStageFileBufferOrEmpty(3, relPath),
      ]);
      const contents = buffers.map(buffer => buffer.toString('utf8'));
      const isBinary = buffers.some((buffer, index) =>
        buffer.includes(0) || !Buffer.from(contents[index], 'utf8').equals(buffer)
      );
      if (isBinary) throw new Error(t('Binary file — no diff available'));
      const [base, ours, theirs] = contents;
      return { base, ours, theirs, language: detectLanguage(relPath) };
    } catch (e) {
      throw new Error(t('Unable to read three-way merge versions for {0}: {1}', relPath, String(e)));
    }
  }

  async saveMergedContent(filePath: string, content: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absolutePath = path.join(this.rootPath, relPath);
    assertNoSymlinkAncestors(this.rootPath, absolutePath, { includeTarget: true });
    // Re-check at the host write boundary. The merge stages may have changed
    // since the editor opened, and a stale/forged webview message must never
    // rewrite a binary conflict or special working-tree node as UTF-8 text.
    await this.getFileVersions(relPath);
    const workingFile = this.readWorkingTreeFile(relPath);
    if (workingFile?.isBinary) throw new Error(t('Binary file — no diff available'));
    try {
      if (fs.lstatSync(absolutePath).isDirectory()) {
        throw new Error(t('Binary file — no diff available'));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
  }

  async deleteMergedFile(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absolutePath = path.join(this.rootPath, relPath);
    assertNoSymlinkAncestors(this.rootPath, absolutePath);
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  }

  async acceptOurs(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    await this.acceptConflictSide(relPath, 'ours');
  }

  async acceptTheirs(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    await this.acceptConflictSide(relPath, 'theirs');
  }

  private async acceptConflictSide(relPath: string, side: 'ours' | 'theirs'): Promise<void> {
    const status = await this.getConflictFileStatuses();
    const sideStatus = status.get(relPath);
    const chosenStatus = side === 'ours' ? sideStatus?.currentStatus : sideStatus?.incomingStatus;

    if (chosenStatus === 'deleted') {
      const pathspec = this.literalPathspec(relPath);
      await this.git.raw(['rm', '-f', '--', pathspec])
        .catch(async () => {
          await this.deleteMergedFile(relPath);
          await this.git.raw(['add', '-u', '--', pathspec]);
        });
      return;
    }

    await this.git.raw(['checkout', side === 'ours' ? '--ours' : '--theirs', '--', this.literalPathspec(relPath)]);
    await this.stageFiles([relPath]);
  }

  async stageAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    const submodulePaths = await this.getSubmoduleRelativePaths();

    if (submodulePaths.size > 0) {
      const subPaths = [...submodulePaths];
      const submoduleStatusRaw = await this.git.raw(['submodule', 'status', '--', ...this.literalPathspecs(subPaths)]).catch(() => '');
      const submoduleHasNewCommit = new Set<string>();
      for (const line of submoduleStatusRaw.split('\n')) {
        const parsed = parseSubmoduleStatusLine(line);
        if (parsed?.flag === '+') submoduleHasNewCommit.add(parsed.path);
      }
      // `git submodule status` lists clean submodules too. Only reject a dirty
      // gitlink that Git reports in porcelain but whose checked-out commit did
      // not move; otherwise every clean submodule made "Stage All" fail.
      const changedSubmodules = new Set(
        (await this.git.status()).files
          .map(file => file.path)
          .filter(filePath => submodulePaths.has(filePath))
      );
      const stageable = [...changedSubmodules].filter(p => submoduleHasNewCommit.has(p));
      if (stageable.length > 0) await this.git.raw(['add', '--', ...this.literalPathspecs(stageable)]);
      // Dirty-only submodules have no pointer update to add. Leave them in the
      // unstaged list while still staging every regular/stageable change, which
      // matches `git add` and VS Code's "Stage All Changes" behaviour.
    }

    if (vsRepo) {
      const all = [
        ...vsRepo.state.workingTreeChanges,
        ...vsRepo.state.untrackedChanges,
        ...vsRepo.state.mergeChanges,
      ].map(c => c.uri.fsPath).filter(p => {
        const rel = path.relative(this.rootPath, p).split(path.sep).join('/');
        return !submodulePaths.has(rel);
      });
      if (all.length) await vsRepo.add(all);
      return;
    }
    await this.git.add('.');
  }

  async unstageFiles(paths: string[]): Promise<void> {
    const safePaths = paths.map(filePath => this.normalizeRepoPath(filePath));
    if (safePaths.length === 0) return;
    const hasHead = await this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (hasHead) {
      await this.git.raw(['reset', 'HEAD', '--', ...this.literalPathspecs(safePaths)]);
      return;
    }
    // `git reset HEAD` is invalid on an unborn branch. Removing entries from
    // the index preserves the working files and works for regular files and
    // gitlinks alike.
    await this.git.raw(['rm', '-r', '--cached', '--ignore-unmatch', '--', ...this.literalPathspecs(safePaths)]);
  }

  async unstageAll(): Promise<void> {
    const hasHead = await this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (hasHead) {
      await this.git.raw(['reset', 'HEAD']);
      return;
    }
    await this.git.raw(['rm', '-r', '--cached', '--ignore-unmatch', '--', '.']);
  }

  async discardFile(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absPath = path.join(this.rootPath, relPath);
    assertNoSymlinkAncestors(this.rootPath, absPath);

    // Use git status --porcelain to reliably detect untracked (??) vs tracked files,
    // regardless of vsRepo API availability.
    const pathspec = this.literalPathspec(relPath);
    const status = await this.git.raw(['status', '--porcelain', '--', pathspec]);
    const isUntracked = status.trimStart().startsWith('??');

    if (isUntracked) {
      fs.rmSync(absPath, { recursive: true, force: true });
      return;
    }

    // For tracked changes (modified, staged, deleted): restore both index and working tree.
    await this.git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', pathspec])
      .catch(() => this.git.raw(['restore', '--staged', '--worktree', '--', pathspec]))
      .catch(() => this.git.checkout(['--', pathspec]));
  }

  async commit(message: string, amend: boolean, credentials?: { gitName: string; gitEmail: string }, log?: (s: string) => void): Promise<string> {
    log?.(`GitService.commit — credentials=${credentials ? 'provided' : 'default'} amend=${amend}`);
    if (credentials?.gitName && credentials?.gitEmail) {
      const flags = [
        '-c', `user.name=${credentials.gitName}`,
        '-c', `user.email=${credentials.gitEmail}`,
        'commit', '-m', message,
        ...(amend ? ['--amend'] : []),
      ];
      log?.('GitService.commit — running git commit with an explicit identity');
      await this.git.raw(flags);
      return '';
    }
    log?.(`GitService.commit — no credentials, using vsRepo/simple-git`);
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      await vsRepo.commit(message, { amend });
      return '';
    }
    const result = await this.git.commit(message, undefined, amend ? { '--amend': null } : {});
    return result.summary.changes.toString();
  }

  async getOperationState(): Promise<'merge' | 'rebase' | 'cherry-pick' | 'revert' | null> {
    const rawGitDir = await this.git.raw(['rev-parse', '--absolute-git-dir'])
      .catch(() => this.git.raw(['rev-parse', '--git-dir']).catch(() => ''));
    const gitDirValue = rawGitDir.trim();
    if (!gitDirValue) return null;
    const gitDir = path.isAbsolute(gitDirValue) ? gitDirValue : path.resolve(this.rootPath, gitDirValue);
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (fs.existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'revert';
    return null;
  }

  async getMergeRebaseState(): Promise<'merge' | 'rebase' | null> {
    const state = await this.getOperationState();
    return state === 'merge' || state === 'rebase' ? state : null;
  }

  async abortMerge(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.mergeAbort(); return; }
    await this.git.raw(['merge', '--abort']);
  }

  async abortRebase(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.rebase('--abort' as string); return; }
    await this.git.raw(['rebase', '--abort']);
  }

  async getRemotes(): Promise<string[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const fromApi = vsRepo.state.remotes.map(r => r.name);
      // VS Code API may return empty remotes for repos it considers a submodule kind —
      // fall back to simple-git to get the real list.
      if (fromApi.length > 0) return fromApi;
    }
    const result = await this.git.getRemotes(false);
    return result.map(r => r.name);
  }

  async getRemotesWithUrls(): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const fromApi = vsRepo.state.remotes;
      if (fromApi.length > 0) {
        return fromApi.map(r => ({
          name: r.name,
          fetchUrl: r.fetchUrl ?? '',
          pushUrl: r.pushUrl ?? r.fetchUrl ?? '',
        }));
      }
    }
    const result = await this.git.getRemotes(true);
    return result.map(r => ({
      name: r.name,
      fetchUrl: r.refs.fetch ?? '',
      pushUrl: r.refs.push ?? r.refs.fetch ?? '',
    }));
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.git.addRemote(name, url);
    // Refresh VS Code's remote state without creating an unhandled rejection
    // when the newly-added endpoint is offline or needs authentication.
    void this.vsRepo()?.fetch?.().catch(() => undefined);
  }

  async removeRemote(name: string): Promise<void> {
    await this.git.removeRemote(name);
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    await this.git.remote(['rename', oldName, newName]);
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    await this.git.remote(['set-url', name, url]);
  }

  async push(force = false, remote?: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    const vsRepo = this.vsRepo();
    // Only use VS Code API when it actually knows the remotes for this repo.
    // If remotes are empty VS Code would push to an unknown remote (exit 128).
    // Repos where VS Code lists no remotes are typically SSH-keyed or use a
    // system credential helper, so falling back to simple-git is safe there.
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      const branchName = vsRepo.state.HEAD?.name;
      const hasUpstream = !!vsRepo.state.HEAD?.upstream;
      const targetRemote = remote ?? vsRepo.state.HEAD?.upstream?.remote ?? vsRepo.state.remotes[0]?.name ?? 'origin';
      const forceMode = force ? ForcePushMode.ForceWithLease : undefined;
      await vsRepo.push(targetRemote, branchName, !hasUpstream, forceMode);
      return;
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    const hasUpstream = !!tracking.trim();
    const branchName = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    // Match the longest configured prefix because Git permits remote names with
    // slashes (for example, team/upstream/main).
    const remoteNames = await this.getRemotes().catch(() => [] as string[]);
    const remoteNamesByLength = [...remoteNames].sort((a, b) => b.length - a.length);
    const trackingName = tracking.trim();
    const trackingRemote = remoteNamesByLength.find(name => trackingName.startsWith(`${name}/`)) ?? '';
    const firstRemote = remoteNames[0] ?? 'origin';
    const targetRemote = remote ?? (trackingRemote || firstRemote);
    const args = ['push'];
    if (!hasUpstream) args.push('--set-upstream', targetRemote, branchName);
    else if (remote) args.push(remote, branchName);
    if (force) args.push('--force-with-lease');
    await this.git.raw(args);
  }

  async pull(): Promise<string> {
    await this.assertPullAllowed();
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      if (!vsRepo.state.HEAD?.upstream) return 'No remote tracking branch — skipped';
      try {
        await vsRepo.pull();
        return 'pulled';
      } catch (error: unknown) {
        throw new Error(gitErrorDetail(error));
      }
    }
    const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
    if (!tracking.trim()) return 'No remote tracking branch — skipped';
    const result = await this.git.pull();
    return `${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
  }

  async pullRebase(): Promise<string> {
    await this.assertPullAllowed();
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) {
      if (!vsRepo.state.HEAD?.upstream) return 'No remote tracking branch — skipped';
      const upstream = vsRepo.state.HEAD.upstream;
      try {
        await vsRepo.fetch();
        await vsRepo.rebase(`${upstream.remote}/${upstream.name}`);
        return 'pulled (rebase)';
      } catch (error: unknown) {
        throw new Error(gitErrorDetail(error));
      }
    }
    const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
    if (!tracking) return 'No remote tracking branch — skipped';
    await this.git.raw(['pull', '--rebase']);
    return 'pulled (rebase)';
  }

  async fetchAll(): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo && vsRepo.state.remotes.length > 0) { await vsRepo.fetch({ all: true, prune: true }); return; }
    await this.git.fetch(['--all', '--prune']);
  }

  async checkout(branchName: string, createNew?: boolean, from?: string): Promise<void> {
    await this.assertCheckoutAllowed();
    this._pendingDetachedTag = undefined;
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      if (createNew) {
        await vsRepo.createBranch(branchName, true, from);
        return;
      }
      const locals = await vsRepo.getBranches({ remote: false });
      // Local branch names commonly contain slashes (feature/foo). Check exact
      // local refs before interpreting a slash as a remote/name separator.
      if (locals.some(branch => branch.name === branchName)) {
        await vsRepo.checkout(branchName);
        return;
      }
      const remoteRefs = await vsRepo.getBranches({ remote: true });
      const remoteRef = remoteRefs.find(branch => branch.type === RefType.RemoteHead && branch.name === branchName);
      if (remoteRef) {
        const remoteNames = vsRepo.state.remotes.map(remote => remote.name).sort((a, b) => b.length - a.length);
        const remoteName = remoteNames.find(name => branchName.startsWith(`${name}/`));
        const localName = remoteName ? branchName.slice(remoteName.length + 1) : branchName.slice(branchName.indexOf('/') + 1);
        if (!localName) throw new Error(t('Cannot determine a local branch name for {0}.', branchName));
        if (!locals.some(branch => branch.name === localName)) {
          await vsRepo.createBranch(localName, false, branchName);
        }
        await vsRepo.checkout(localName);
        return;
      }
      await vsRepo.checkout(branchName);
      return;
    }
    // Fallback: simple-git
    if (createNew) {
      if (from) await this.git.checkout(['-b', branchName, from]);
      else await this.git.checkoutLocalBranch(branchName);
      return;
    }
    const branches = await this.getBranches();
    if (branches.some(branch => !branch.isRemote && branch.name === branchName)) {
      await this.git.checkout(branchName);
      return;
    }
    if (branches.some(branch => branch.isRemote && branch.name === branchName)) {
      const remoteNames = (await this.getRemotes()).sort((a, b) => b.length - a.length);
      const remoteName = remoteNames.find(name => branchName.startsWith(`${name}/`));
      const localName = remoteName ? branchName.slice(remoteName.length + 1) : branchName.slice(branchName.indexOf('/') + 1);
      if (!localName) throw new Error(t('Cannot determine a local branch name for {0}.', branchName));
      const localExists = branches.some(branch => !branch.isRemote && branch.name === localName);
      if (localExists) await this.git.checkout(localName);
      else await this.git.checkout(['-b', localName, '--track', branchName]);
      return;
    }
    await this.git.checkout(branchName);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.createBranch(branchName, false, from); return; }
    await this.git.branch(from ? [branchName, from] : [branchName]);
  }

  async merge(from: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    try {
      await this.git.merge([from]);
    } catch (e: unknown) {
      const isDirty = (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree'
        || String(e).includes('overwritten by merge')
        || String(e).includes('Your local changes');
      if (!isDirty) throw e;
      // Stash uncommitted changes, retry merge, then restore stash.
      // If the merge produces conflicts the stash pop will also conflict —
      // the user resolves both sets in the normal conflict flow.
      const stashRef = `VersionDock WIP before merge of ${from} (${Date.now()})`;
      const previousStash = (await this.git.raw(['rev-parse', '--verify', 'refs/stash']).catch(() => '')).trim();
      await this.git.stash(['push', '--include-untracked', '-m', stashRef]);
      const createdStash = (await this.git.raw(['rev-parse', '--verify', 'refs/stash']).catch(() => '')).trim();
      if (!createdStash || createdStash === previousStash) throw e;
      try {
        await this.git.merge([from]);
      } catch (mergeErr: unknown) {
        // Merge failed (e.g. conflicts) — pop stash on top so the user
        // ends up with both the merge conflicts and their original changes.
        await this.restoreAutoStash(createdStash).catch(() => {});
        throw mergeErr;
      }
      await this.restoreAutoStash(createdStash);
    }
  }

  private async restoreAutoStash(stashHash: string): Promise<void> {
    await this.git.raw(['stash', 'apply', stashHash]);
    const stashList = await this.git.raw(['stash', 'list', '--format=%gd%x00%H']).catch(() => '');
    const matchingRef = stashList.split('\n').map(line => line.split('\0')).find(([, hash]) => hash === stashHash)?.[0];
    if (matchingRef) await this.git.raw(['stash', 'drop', matchingRef]);
  }

  async rebase(onto: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.rebase(onto); return; }
    await this.git.rebase([onto]);
  }

  async deleteBranch(branchName: string, force: boolean): Promise<void> {
    await this.assertBranchOperationAllowed();
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.deleteBranch(branchName, force); return; }
    await this.git.deleteLocalBranch(branchName, force);
  }

  async checkoutForce(branchName: string): Promise<void> {
    await this.assertCheckoutAllowed();
    // VS Code API has no force checkout — use simple-git
    await this.git.checkout(['-f', branchName]);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    // VS Code API has no renameBranch — use simple-git
    await this.git.branch(['-m', oldName, newName]);
  }

  async pullFromRemote(remote: string, branch: string, rebase: boolean): Promise<void> {
    await this.assertPullAllowed();
    // VS Code API pull() doesn't accept remote/branch args — use simple-git
    const args = rebase ? ['pull', '--rebase', remote, branch] : ['pull', remote, branch];
    await this.git.raw(args);
  }

  async cherryPick(hash: string): Promise<void> {
    await this.git.raw(['cherry-pick', hash]);
  }

  async cherryPickContinue(): Promise<void> {
    await this.git.raw(['cherry-pick', '--continue', '--no-edit']);
  }

  async cherryPickSkip(): Promise<void> {
    await this.git.raw(['cherry-pick', '--skip']);
  }

  async cherryPickAbort(): Promise<void> {
    await this.git.raw(['cherry-pick', '--abort']);
  }

  async revertCommit(hash: string): Promise<void> {
    await this.git.raw(['revert', '--no-edit', hash]);
  }

  async checkoutFileFromCommit(hash: string, filePath: string): Promise<void> {
    await this.git.raw(['checkout', hash, '--', this.literalPathspec(filePath)]);
  }

  async revertFileToParent(hash: string, filePath: string): Promise<void> {
    // For added files, 'A' status: the file was created in this commit, so reverting
    // means deleting it from working tree by checking out from the empty tree.
    // For other statuses: restore the file to its state in the parent commit.
    await this.git.raw(['checkout', `${hash}~1`, '--', this.literalPathspec(filePath)]);
  }

  async hasFileAtRef(ref: string, filePath: string): Promise<boolean> {
    try {
      await this.git.raw(['cat-file', '-e', `${this.safeRevisionArg(ref)}:${this.normalizeRepoPath(filePath)}`]);
      return true;
    } catch {
      return false;
    }
  }

  async revertContinue(): Promise<void> {
    await this.git.raw(['revert', '--continue', '--no-edit']);
  }

  async revertAbort(): Promise<void> {
    await this.git.raw(['revert', '--abort']);
  }

  async resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    await this.git.raw(['reset', `--${mode}`, hash]);
  }

  async createPatch(hash: string): Promise<string> {
    return this.git.raw(['format-patch', '-1', '--stdout', hash]);
  }

  async dropCommit(hash: string): Promise<void> {
    await this.git.raw(['rebase', '--onto', `${hash}^`, hash]);
  }

  async squashCommits(hashes: string[], message: string): Promise<void> {
    const normalized = message.trim();
    if (!normalized) {
      throw new Error(t('Commit message cannot be empty'));
    }
    const validation = await this.validateCommitRewriteHashes(hashes, 'squash');
    await this.git.raw(['reset', '--soft', `${validation.oldestHash}^`]);
    await this.git.raw(['commit', '-m', normalized]);
  }

  async cherryPickMulti(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      await this.git.raw(['cherry-pick', hash]);
    }
  }

  async revertCommits(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      await this.git.raw(['revert', '--no-edit', hash]);
    }
  }

  async dropCommits(oldestHash: string): Promise<void> {
    await this.git.raw(['reset', '--hard', `${oldestHash}^`]);
  }

  async undoCommit(): Promise<void> {
    const parentCount = await this.git.raw(['rev-list', '--count', 'HEAD']).then(s => parseInt(s.trim(), 10)).catch(() => 0);
    if (parentCount <= 1) {
      // First commit: unstage all files and delete HEAD so the branch goes back to unborn state
      await this.git.raw(['rm', '-r', '--cached', '.']);
      await this.git.raw(['update-ref', '-d', 'HEAD']);
    } else {
      await this.git.raw(['reset', '--soft', 'HEAD~1']);
    }
  }

  async editCommitMessage(message: string): Promise<void> {
    await this.git.raw(['commit', '--amend', '-m', message]);
  }

  async canSquashCommitRange(hashes: string[]): Promise<{ ok: boolean; hashes: string[]; oldestHash?: string; reason?: string }> {
    try {
      const validated = await this.validateCommitRewriteHashes(hashes, 'squash');
      return { ok: true, hashes: validated.hashes, oldestHash: validated.oldestHash };
    } catch (error: unknown) {
      return { ok: false, hashes: [], reason: String(error instanceof Error ? error.message : error) };
    }
  }

  async canReorganizeCommitRange(hashes: string[]): Promise<{ ok: boolean; hashes: string[]; oldestHash?: string; reason?: string }> {
    try {
      const validated = await this.validateCommitRewriteHashes(hashes, 'reorganize');
      return { ok: true, hashes: validated.hashes, oldestHash: validated.oldestHash };
    } catch (error: unknown) {
      return { ok: false, hashes: [], reason: String(error instanceof Error ? error.message : error) };
    }
  }

  async rewordCommit(newMessage: string): Promise<void> {
    await this.git.raw(['commit', '--amend', '-m', newMessage]);
  }

  async createBranchFromCommit(name: string, hash: string): Promise<void> {
    await this.git.raw(['checkout', '-b', name, hash]);
  }

  async createTag(name: string, hash: string): Promise<void> {
    if (!name || name.startsWith('-') || name.includes('\0')) {
      throw new Error(`Invalid Git tag name: ${name}`);
    }
    await this.git.raw(['check-ref-format', `refs/tags/${name}`]);
    await this.git.raw(['tag', name, this.safeRevisionArg(hash)]);
  }

  async getTags(): Promise<Array<{ name: string; hash: string; date: string }>> {
    // Use %(refname:strip=2) instead of %(refname:short) to always strip refs/tags/
    // prefix — %(refname:short) may return "tags/<name>" when a branch with the
    // same name exists, which causes display and matching issues.
    const out = await this.git.raw([
      'tag', '--sort=-creatordate',
      '--format=%(refname:strip=2)%09%(objectname:short)%09%(creatordate:iso)',
    ]).catch(() => '');
    return out.trim().split('\n').filter(Boolean).map(line => {
      const [name, hash, ...dateParts] = line.split('\t');
      return { name: name.trim(), hash: hash.trim(), date: dateParts.join('\t').trim() };
    });
  }

  async getTagsForCommit(hash: string): Promise<string[]> {
    const out = await this.git.raw(['tag', '--points-at', hash]).catch(() => '');
    return out.trim().split('\n').map(t => t.trim()).filter(Boolean);
  }

  private async getFirstParentHeadChain(): Promise<string[]> {
    const raw = await this.git.raw(['rev-list', '--first-parent', 'HEAD']).catch(() => '');
    return raw.trim().split('\n').map(line => line.trim()).filter(Boolean);
  }

  private async validateCommitRewriteHashes(hashes: string[], mode: 'squash' | 'reorganize'): Promise<{ hashes: string[]; oldestHash: string }> {
    const uniqueHashes = Array.from(new Set(hashes.map(hash => hash.trim()).filter(Boolean)));
    const minimumCount = mode === 'squash' ? 2 : 1;
    if (uniqueHashes.length < minimumCount) {
      throw new Error(mode === 'squash'
        ? t('Select at least two commits to squash.')
        : t('Select at least one commit to reorganize.'));
    }

    const currentBranch = (await this.git.raw(['branch', '--show-current']).catch(() => '')).trim();
    if (!currentBranch) {
      throw new Error(mode === 'squash'
        ? t('Cannot squash commits while HEAD is detached.')
        : t('Cannot reorganize commits while HEAD is detached.'));
    }

    const status = await this.getStatusFresh();
    if (status.stagedFiles.length > 0 || status.conflictCount > 0) {
      throw new Error(mode === 'squash'
        ? t('Clear staged changes and conflicts before squashing commits.')
        : t('Clear staged changes and conflicts before reorganizing commits.'));
    }

    const firstParentChain = await this.getFirstParentHeadChain();
    const indexByHash = new Map<string, number>();
    firstParentChain.forEach((hash, index) => indexByHash.set(hash, index));
    if (uniqueHashes.some(hash => !indexByHash.has(hash))) {
      throw new Error(t('Selected commits must belong to the current branch head.'));
    }

    const orderedHashes = [...uniqueHashes].sort((a, b) => (indexByHash.get(a) ?? Number.MAX_SAFE_INTEGER) - (indexByHash.get(b) ?? Number.MAX_SAFE_INTEGER));
    const expectedPrefix = firstParentChain.slice(0, orderedHashes.length);
    if (orderedHashes.some((hash, index) => hash !== expectedPrefix[index])) {
      throw new Error(t('Selected commits must be the top contiguous unpushed commits on the current branch.'));
    }

    const unpushedHashes = await this.getUnpushedHashes();
    if (unpushedHashes !== 'all') {
      for (const hash of orderedHashes) {
        if (!unpushedHashes.has(hash)) {
          throw new Error(mode === 'squash'
            ? t('Only unpushed commits can be squashed.')
            : t('Only unpushed commits can be reorganized.'));
        }
      }
    }

    const oldestHash = orderedHashes[orderedHashes.length - 1];
    const parent = (await this.git.raw(['rev-parse', `${oldestHash}^1`]).catch(() => '')).trim();
    if (!parent) {
      throw new Error(mode === 'squash'
        ? t('Cannot squash because the oldest selected commit has no parent.')
        : t('Cannot reorganize because the oldest selected commit has no parent.'));
    }

    return { hashes: orderedHashes, oldestHash };
  }

  async deleteTag(name: string): Promise<void> {
    await this.git.raw(['tag', '-d', '--', name]);
  }

  async pushTag(name: string, remote: string): Promise<void> {
    await this.git.raw(['push', remote, `refs/tags/${name}`]);
  }

  async deleteTagRemote(name: string, remote: string): Promise<void> {
    await this.git.raw(['push', remote, `--delete`, `refs/tags/${name}`]);
  }

  async checkoutTag(name: string): Promise<void> {
    await this.assertCheckoutAllowed();
    await this.git.raw(['checkout', '--detach', `refs/tags/${name}`]);
    this._pendingDetachedTag = name;
  }

  async mergeTag(name: string): Promise<void> {
    await this.git.raw(['merge', `refs/tags/${name}`]);
  }

  async getBranchesContaining(hash: string): Promise<{ local: string[]; remote: string[]; tags: string[] }> {
    const [localOut, remoteOut, tagOut] = await Promise.all([
      this.git.raw(['branch', '--contains', hash, '--format=%(refname)']).catch(() => ''),
      this.git.raw(['branch', '-r', '--contains', hash, '--format=%(refname)']).catch(() => ''),
      // --points-at: only tags directly on this commit, not ancestors.
      this.git.raw(['tag', '--points-at', hash]).catch(() => ''),
    ]);
    const parse = (out: string) => out.split('\n').map(b => b.trim()).filter(Boolean);
    // Full ref names avoid Git's ambiguous `%(refname:short)` output when a
    // branch and tag share a name, and preserve local feature/foo branches.
    const local = parse(localOut)
      .filter(ref => ref.startsWith('refs/heads/'))
      .map(ref => ref.slice('refs/heads/'.length));
    // Remote HEAD is a symbolic alias, not a branch. Parsing the full ref is
    // also required because its short form may collapse to just "origin".
    const remote = parse(remoteOut)
      .filter(ref => ref.startsWith('refs/remotes/'))
      .map(ref => ref.slice('refs/remotes/'.length))
      .filter(ref => !ref.endsWith('/HEAD'));
    const tags = parse(tagOut);
    return { local, remote, tags };
  }

  async getFullCommitMessage(hash: string): Promise<string> {
    return this.git.raw(['log', '-1', '--format=%B', hash]);
  }

  async getCommitMeta(hash: string): Promise<{ hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] }> {
    const GS = '\x1D';
    const raw = await this.git.raw(['log', '-1', `--format=%H${GS}%h${GS}%s${GS}%aN${GS}%aE${GS}%aI${GS}%cI${GS}%P`, hash]);
    const parts = raw.trim().split(GS);
    return {
      hash: parts[0] ?? hash,
      shortHash: parts[1] ?? hash.slice(0, 7),
      message: parts[2] ?? '',
      authorName: parts[3] ?? '',
      authorEmail: parts[4] ?? '',
      authorDate: parts[5] ?? '',
      committerDate: parts[6] ?? '',
      parents: parts[7] ? parts[7].trim().split(' ').filter(Boolean) : [],
    };
  }

  async getLastCommitMessage(): Promise<string> {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      try {
        const commit = await vsRepo.getCommit('HEAD');
        return commit.message;
      } catch { /* */ }
    }
    return (await this.git.log(['-1', '--format=%s'])).latest?.message ?? '';
  }

  async getRecentCommitMessages(limit: number): Promise<CommitMessageHistoryEntry[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const fieldSeparator = '\x1f';
    const recordSeparator = '\x1e';
    const raw = await this.git.raw([
      'log',
      `--max-count=${safeLimit}`,
      `--format=%ct%x1f%B%x1e`,
    ]).catch(() => '');

    return raw.split(recordSeparator).flatMap(record => {
      const separatorIndex = record.indexOf(fieldSeparator);
      if (separatorIndex < 0) return [];
      const timestampSeconds = Number(record.slice(0, separatorIndex).trim());
      const message = record.slice(separatorIndex + 1).trim();
      if (!message) return [];
      return [{
        message,
        timestamp: Number.isFinite(timestampSeconds) ? timestampSeconds * 1000 : 0,
      }];
    });
  }

  // ── Stash operations ──────────────────────────────────────────────────────

  async stashCount(): Promise<number> {
    const raw = await this.git.raw(['stash', 'list', '--format=%gd']).catch(() => '');
    return raw.split(/\r?\n/).filter(line => line.trim()).length;
  }

  async stashList(): Promise<StashEntry[]> {
    // Use the stash commit subject instead of the reflog subject. Git flattens
    // multiline stash messages into " - " inside %gs, while %s contains only
    // the actual first-line title.
    const fieldSeparator = '\x1f';
    const recordSeparator = '\x1e';
    const raw = await this.git.raw([
      'stash', 'list', '--format=%gd%x1f%ci%x1f%s%x1f%B%x1e',
    ]).catch(() => '');
    if (!raw.trim()) return [];

    const entries: StashEntry[] = [];
    for (const rawRecord of raw.split(recordSeparator)) {
      const record = rawRecord.replace(/^\r?\n/, '');
      if (!record.trim()) continue;
      const parts = record.split(fieldSeparator);
      if (parts.length < 4) continue;
      const ref = parts[0].trim();          // stash@{N}
      const date = parts[1].trim();         // ISO date
      const subject = parts[2].trim();      // "On branch: message" or "WIP on branch: message"
      const rawFullMessage = parts.slice(3).join(fieldSeparator).trim();

      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

      // Parse branch from subject like "On main: ..." or "WIP on main: ..."
      const branchMatch = subject.match(/^(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1].trim() : '';
      const message = branchMatch ? subject.slice(branchMatch[0].length).trim() : subject;
      const fullMessage = branchMatch && rawFullMessage.startsWith(branchMatch[0])
        ? rawFullMessage.slice(branchMatch[0].length).trim()
        : rawFullMessage || message;

      // Get files for this stash entry
      const files: Array<{ path: string; status: string }> = [];
      try {
        const fileRaw = await this.rawPathSafe(['stash', 'show', '--name-status', '-z', ref]);
        for (const file of parseNameStatusZOutput(fileRaw)) {
          files.push({ path: file.path, status: file.status });
        }
      } catch { /* stash might have no files */ }

      // Also include untracked files saved in stash^3 (created by `git stash -u`)
      try {
        const untrackedRaw = await this.rawPathSafe(['ls-tree', '-r', '--name-only', '-z', `${ref}^3`]);
        const trackedPaths = new Set(files.map(f => f.path));
        for (const filePath of untrackedRaw.split('\0')) {
          if (filePath && !trackedPaths.has(filePath)) {
            files.push({ path: filePath, status: 'untracked' });
          }
        }
      } catch { /* stash^3 may not exist for tracked-only stashes */ }

      entries.push({ ref, index, message, fullMessage, date, branch, files });
    }
    return entries;
  }

  async stashShow(stashRef: string, filePath: string): Promise<string> {
    return this.rawPathSafe(['stash', 'show', '-p', stashRef, '--', this.literalPathspec(filePath)]).catch(() => '');
  }

  async stashPush(message: string, paths?: string[]): Promise<void> {
    const hasHead = await this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (!hasHead) {
      // Native `git stash` cannot create its commit graph without an initial
      // commit. Fail before touching the index; users can use Shelve for this
      // unborn-branch case.
      throw new Error('Cannot create a Git stash before the initial commit.');
    }
    if (!paths || paths.length === 0) {
      await this.git.raw(['stash', 'push', '-u', '-m', message]);
      return;
    }

    // git builds the stash commit tree from the current index, so staged files
    // outside the pathspec appear in the stash even though they weren't
    // requested. Save their exact index patch, temporarily reset those entries,
    // then restore the patch to the index only. Re-running `git add` here would
    // destroy the staged snapshot for files that were edited again after staging.
    const requestedPaths = paths.map(filePath => this.normalizeRepoPath(filePath));
    const status = await this.git.status();
    const requestedPathSet = new Set(requestedPaths);

    // Include both sides of a selected rename. A destination-only pathspec makes
    // Git represent the source deletion as an unrelated index change.
    const stashPaths = new Set(requestedPaths);
    for (const file of status.files) {
      if (!requestedPathSet.has(file.path) && (!file.from || !requestedPathSet.has(file.from))) continue;
      stashPaths.add(file.path);
      if (file.from) stashPaths.add(file.from);
    }

    const stagedOutside = Array.from(new Set(status.files.flatMap(file => {
      const indexStatus = file.index.trim();
      if (!indexStatus || indexStatus === '?' || indexStatus === 'U') return [];
      const filePaths = [file.from, file.path].filter((value): value is string => Boolean(value));
      return filePaths.some(filePath => stashPaths.has(filePath)) ? [] : filePaths;
    })));

    let tempDir: string | undefined;
    let indexPatchPath: string | undefined;
    let outsideIndexWasReset = false;
    let indexWasRestored = false;
    let primaryError: unknown;
    let restoreError: unknown;

    if (stagedOutside.length > 0) {
      const indexPatch = await this.rawPathSafe([
        'diff', '--cached', '--binary', '--full-index', '--',
        ...this.literalPathspecs(stagedOutside),
      ]);
      if (!indexPatch.trim()) {
        throw new Error('Cannot preserve the staged state outside the selected stash paths.');
      }
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-index-'));
      indexPatchPath = path.join(tempDir, 'index.patch');
      fs.writeFileSync(indexPatchPath, indexPatch, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }

    try {
      if (indexPatchPath) {
        await this.git.raw(['reset', 'HEAD', '--', ...this.literalPathspecs(stagedOutside)]);
        outsideIndexWasReset = true;
      }
      await this.git.raw([
        'stash', 'push', '-u', '-m', message, '--',
        ...this.literalPathspecs(Array.from(stashPaths)),
      ]);
    } catch (error) {
      primaryError = error;
    }

    if (outsideIndexWasReset && indexPatchPath) {
      try {
        await this.git.raw(['apply', '--cached', '--binary', '--whitespace=nowarn', indexPatchPath]);
        indexWasRestored = true;
      } catch (error) {
        restoreError = error;
      }
    }
    if (tempDir && (!outsideIndexWasReset || indexWasRestored)) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* temporary recovery file */ }
    }

    if (restoreError && indexPatchPath) {
      const primaryDetail = primaryError ? ` The stash operation also failed: ${gitErrorDetail(primaryError)}.` : '';
      throw new Error(
        `Unable to restore the original staged state.${primaryDetail} The recovery patch was retained at ${indexPatchPath}: ${gitErrorDetail(restoreError)}`,
      );
    }
    if (primaryError) throw primaryError;
  }

  async stashApply(stashRef: string): Promise<void> {
    await this.git.raw(['stash', 'apply', stashRef]);
  }

  async stashPop(stashRef = 'stash@{0}'): Promise<void> {
    await this.git.raw(['stash', 'pop', stashRef]);
  }

  async stashDrop(stashRef: string): Promise<void> {
    await this.git.raw(['stash', 'drop', stashRef]);
  }

  async getStashFileContent(stashRef: string, filePath: string): Promise<string> {
    const relPath = this.normalizeRepoPath(filePath);
    try {
      return await this.git.show([`${stashRef}:${relPath}`]);
    } catch {
      try {
        return await this.git.show([`${stashRef}^3:${relPath}`]);
      } catch {
        return '';
      }
    }
  }

  // ── Unpushed commits ──────────────────────────────────────────────────────

  // ── Submodule push/pull helpers ───────────────────────────────────────────

  async pushSubmodule(): Promise<void> {
    const status = await this.git.status();
    if (status.detached) {
      throw new Error(t('Submodule is in detached HEAD — checkout a branch before pushing.'));
    }
    await this.push();
  }

  async pullSubmodule(rebase = false): Promise<string> {
    await this.assertPullAllowed();
    const status = await this.git.status();
    if (status.detached) {
      // In detached HEAD: fetch then checkout the latest commit on the tracked ref.
      await this.git.fetch();
      return t('fetched (detached HEAD — use Update Submodule to advance to a new commit)');
    }
    return rebase ? this.pullRebase() : this.pull();
  }

  // ── Submodule operations ──────────────────────────────────────────────────

  /** Returns the set of relative paths that are gitlink entries (submodule pointers) in this repo. */
  private async getSubmoduleRelativePaths(): Promise<Set<string>> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return new Set();
    try {
      const raw = fs.readFileSync(gitmodulesPath, 'utf8');
      const paths = new Set<string>();
      for (const line of raw.split('\n')) {
        const m = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
        if (m) paths.add(m[1].trim());
      }
      return paths;
    } catch {
      return new Set();
    }
  }

  async getSubmoduleList(): Promise<SubmoduleEntry[]> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return [];

    // Parse .gitmodules to get names/paths/urls
    const raw = fs.readFileSync(gitmodulesPath, 'utf8');
    const moduleMap = new Map<string, { name: string; path: string; url: string }>();
    let currentName = '';
    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^\[submodule "(.+)"\]/);
      if (sectionMatch) { currentName = sectionMatch[1]; continue; }
      if (!currentName) continue;
      const kvMatch = line.match(/^\s+(\w+)\s*=\s*(.+)/);
      if (!kvMatch) continue;
      const [, key, value] = kvMatch;
      if (!moduleMap.has(currentName)) moduleMap.set(currentName, { name: currentName, path: '', url: '' });
      const entry = moduleMap.get(currentName)!;
      if (key === 'path') entry.path = value.trim();
      if (key === 'url') entry.url = value.trim();
    }

    // Run `git submodule status` to get init state, HEAD commit, dirty flag
    const statusRaw = await this.git.raw(['submodule', 'status']).catch(() => '');
    // Each line: " <hash> <path> (<description>)" or "-<hash> <path>" or "+<hash> <path>"
    // Leading char: ' ' = initialized clean, '-' = not initialized, '+' = different commit, 'U' = conflict
    const statusMap = new Map<string, { initialized: boolean; headCommit: string; isDirty: boolean }>();
    for (const line of statusRaw.trim().split('\n')) {
      if (!line.trim()) continue;
      const parsed = parseSubmoduleStatusLine(line);
      const hash = line.match(/^[ +\-U]([0-9a-f]{40,64})/i)?.[1];
      if (!parsed || !hash) continue;
      statusMap.set(parsed.path, {
        initialized: parsed.flag !== '-',
        headCommit: hash.slice(0, 8),
        isDirty: parsed.flag === '+',
      });
    }

    const entries: SubmoduleEntry[] = [];
    for (const mod of moduleMap.values()) {
      if (!mod.path) continue;
      const subFullPath = path.join(this.rootPath, mod.path);
      const st = statusMap.get(mod.path);
      entries.push({
        name: mod.name,
        path: mod.path,
        url: mod.url,
        repoId: subFullPath,
        initialized: st?.initialized ?? false,
        headCommit: st?.headCommit,
        isDirty: st?.isDirty ?? false,
      });
    }
    return entries;
  }

  async initSubmodule(submodulePath: string): Promise<void> {
    const pathspec = this.literalPathspec(submodulePath);
    await this.git.raw(['submodule', 'init', '--', pathspec]);
    await this.git.raw(['submodule', 'update', '--', pathspec]);
  }

  async deinitSubmodule(submodulePath: string, force = false): Promise<void> {
    const args = ['submodule', 'deinit'];
    if (force) args.push('--force');
    args.push('--', this.literalPathspec(submodulePath));
    await this.git.raw(args);
  }

  async updateSubmodule(submodulePath: string, init = true, recursive = false): Promise<void> {
    const args = ['submodule', 'update'];
    if (init) args.push('--init');
    if (recursive) args.push('--recursive');
    args.push('--', this.literalPathspec(submodulePath));
    await this.git.raw(args);
  }

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    // Two-pass approach: first get structured fields (with %s for subject),
    // then get full messages separately per hash.
    // GS before each record; fields separated by NUL.
    const GS = '\x1D';
    const FORMAT = `%x1D%H%x00%h%x00%s%x00%an%x00%ci`;

    const parseRecords = (raw: string): UnpushedCommit[] => {
      const commits: UnpushedCommit[] = [];
      for (const record of raw.split(GS)) {
        const trimmed = record.trim();
        if (!trimmed) continue;
        const lines = trimmed.split('\n');
        const parts = lines[0].split('\x00');
        if (parts.length < 5) continue;
        const commit: UnpushedCommit = {
          hash: parts[0].trim(),
          shortHash: parts[1].trim(),
          message: parts[2].trim(),
          author: parts[3].trim(),
          date: parts.slice(4).join('\x00').trim(),
        };
        const statLine = lines.find(l => l.includes('changed'));
        if (statLine) {
          const files = statLine.match(/(\d+) files? changed/);
          const ins = statLine.match(/(\d+) insertion/);
          const del = statLine.match(/(\d+) deletion/);
          commit.filesChanged = files ? parseInt(files[1]) : 0;
          commit.additions = ins ? parseInt(ins[1]) : 0;
          commit.deletions = del ? parseInt(del[1]) : 0;
        }
        commits.push(commit);
      }
      return commits;
    };

    const logArgs = (range: string[]): string[] =>
      ['log', ...range, `--format=${FORMAT}`, '--shortstat'];

    try {
      // Fast path: upstream is configured
      const raw = await this.git.raw(logArgs(['@{u}..HEAD']));
      return parseRecords(raw);
    } catch {
      // No upstream — list commits not reachable from any remote ref
      try {
        const remotes = await this.git.getRemotes();
        let raw: string;
        if (remotes.length === 0) {
          // Fully local repo: show recent commits (capped to avoid huge lists)
          raw = await this.git.raw(logArgs(['HEAD', '--max-count=100']));
        } else {
          // Remotes exist but this branch has no tracking ref
          raw = await this.git.raw(logArgs(['HEAD', '--not', '--remotes']));
        }
        return parseRecords(raw);
      } catch {
        return [];
      }
    }
  }

  // ─── Worktree operations ──────────────────────────────────────────────────

  async getWorktrees(): Promise<WorktreeEntry[]> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(raw);
  }

  async createWorktree(worktreePath: string, opts: { branch?: string; newBranch?: string; commitish?: string; noTrack?: boolean }): Promise<void> {
    const args = ['worktree', 'add'];
    if (opts.newBranch) {
      args.push('-b', opts.newBranch);
    } else if (opts.branch) {
      // checkout existing branch — no -b flag, just add path + branch
    }
    if (opts.noTrack) args.push('--no-track');
    args.push(worktreePath);
    if (opts.branch) args.push(opts.branch);
    else if (opts.commitish) args.push(opts.commitish);
    await this.git.raw(args);
  }

  async deleteWorktree(worktreePath: string, force = false): Promise<void> {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(worktreePath);
    await this.git.raw(args);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git.raw(['worktree', 'prune']);
  }

  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    const args = ['worktree', 'lock'];
    if (reason) args.push('--reason', reason);
    args.push(worktreePath);
    await this.git.raw(args);
  }

  async unlockWorktree(worktreePath: string): Promise<void> {
    await this.git.raw(['worktree', 'unlock', worktreePath]);
  }
}

// ─── Worktree types & parser ──────────────────────────────────────────────────

export interface WorktreeEntry {
  path: string;
  head: string;       // commit hash
  branch: string;     // refs/heads/... or empty if detached
  isMain: boolean;
  isDetached: boolean;
  isBare: boolean;
  isLocked: boolean;
  lockReason?: string;
  isPrunable: boolean;
  branchShort: string; // just the branch name without refs/heads/
  isInWorkspace: boolean; // path is inside a VS Code workspace folder
}

function parseWorktreePorcelain(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  const blocks = raw.trim().split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const entry: Partial<WorktreeEntry> = { isLocked: false, isPrunable: false };
    for (const line of lines) {
      if (line.startsWith('worktree '))      entry.path = line.slice(9).trim();
      else if (line.startsWith('HEAD '))     entry.head = line.slice(5).trim();
      else if (line.startsWith('branch '))   entry.branch = line.slice(7).trim();
      else if (line === 'bare')              entry.isBare = true;
      else if (line === 'detached')          entry.isDetached = true;
      else if (line.startsWith('locked'))    { entry.isLocked = true; entry.lockReason = line.slice(6).trim() || undefined; }
      else if (line.startsWith('prunable'))  entry.isPrunable = true;
    }
    if (!entry.path) continue;
    // The main worktree has a .git directory; linked worktrees have a .git file.
    // Checking the entry itself avoids macOS path aliases such as /var vs /private/var.
    const gitDir = path.join(entry.path, '.git');
    entry.isMain = (() => {
      try { return fs.statSync(gitDir).isDirectory(); } catch { return false; }
    })();
    entry.isBare = entry.isBare ?? false;
    entry.isDetached = entry.isDetached ?? false;
    entry.isInWorkspace = false;
    entry.branchShort = entry.branch ? entry.branch.replace(/^refs\/heads\//, '') : '';
    entries.push(entry as WorktreeEntry);
  }
  return entries;
}
