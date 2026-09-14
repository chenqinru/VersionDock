import { type SimpleGit, type TaskOptions } from 'simple-git';
import { execFile, execFileSync } from 'child_process';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  BranchInfo,
  CommitNode,
  CommitLogList,
  GraphCommitNode,
  FileStatus,
  FileDiff,
  GitFileStatus,
  MergeFileVersions,
  RepoStatus,
  SubmoduleStatus,
  LineRange,
  SubmoduleEntry,
  ConflictFileStatus,
  RepoMeta,
} from '../types/git';
import type { StashEntry, UnpushedCommit, SubtreePushStatus, PushCommitFile, IncomingCommit, SyncPullStrategy } from '../types/messages';
import { parseDiff, detectLanguage } from './DiffParser';
import { getVscodeRepository } from './VscodeGitApi';
import { ForcePushMode, Status, RefType } from './git.d';
import { t } from '../utils/l10n';
import { BlameService, type BlameLine } from './BlameService';
import { assertNoSymlinkAncestors, isSameOrChildPath, resolveRepoPath as resolvePathWithinRepo, type ResolvedRepoPath } from '../utils/repoPath';
import { createGitClient, getGitEnvironment, getGitWriteGeneration, waitForGitWrite, withGitWriteLock, withGitWriteLocks } from './GitOperationLock';
import { isBranchProtected } from '../utils/branchProtection';
import type { PublishMissingRemote } from '../remote/types';
import type { GitUpdateSnapshot, VcsUpdateSnapshot } from '../update/types';
import type { VersionDockLogger } from '../utils/Logger';

const STATUS_MAP: Record<string, GitFileStatus> = {
  M: 'modified', A: 'added', D: 'deleted',
  R: 'renamed', C: 'copied', U: 'conflicted',
  '?': 'untracked',
};

const SUBTREE_CANDIDATE_SKIP_DIRS = new Set(['.git', '.hg', '.svn', 'node_modules', 'vendor', 'dist', 'build', 'out']);
const SUBTREE_REMOTE_CACHE_TTL_MS = 300_000; // 5 minutes for successful remote ref queries
const SUBTREE_REMOTE_FAILURE_CACHE_TTL_MS = 30_000; // 30 seconds for unreachable/timed out queries
const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_INLINE_DIFF_FILE_BYTES = 8 * 1024 * 1024;
const LOG_RECORD_FORMAT = '--format=%H%x00%h%x00%P%x00%an%x00%ae%x00%ai%x00%ci%x00%x00%s';
const GRAPH_LOG_RECORD_FORMAT = '--format=%H%x00%P%x00%ci';

export function formatRelativeTime(dateOrTimestamp: number | Date | string): string {
  let seconds: number;
  if (typeof dateOrTimestamp === 'number') {
    seconds = dateOrTimestamp > 1e11 ? Math.floor(dateOrTimestamp / 1000) : dateOrTimestamp;
  } else if (dateOrTimestamp instanceof Date) {
    seconds = Math.floor(dateOrTimestamp.getTime() / 1000);
  } else {
    const num = Number(dateOrTimestamp);
    if (!Number.isNaN(num) && num > 0) {
      seconds = num > 1e11 ? Math.floor(num / 1000) : num;
    } else {
      const parsed = Date.parse(dateOrTimestamp);
      seconds = Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000);
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - seconds);

  if (diff < 60) {
    return t('just now');
  }
  const minutes = Math.floor(diff / 60);
  if (minutes < 60) {
    return minutes === 1 ? t('{0} minute ago', 1) : t('{0} minutes ago', minutes);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? t('{0} hour ago', 1) : t('{0} hours ago', hours);
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return days === 1 ? t('{0} day ago', 1) : t('{0} days ago', days);
  }
  const weeks = Math.floor(days / 7);
  if (days < 30) {
    return weeks === 1 ? t('{0} week ago', 1) : t('{0} weeks ago', weeks);
  }
  const months = Math.floor(days / 30);
  if (days < 365) {
    return months === 1 ? t('{0} month ago', 1) : t('{0} months ago', months);
  }
  const years = Math.floor(days / 365);
  return years === 1 ? t('{0} year ago', 1) : t('{0} years ago', years);
}

export interface CommitMessageHistoryEntry {
  message: string;
  timestamp: number;
}

export interface DetailedUpdateCommit {
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
}

export interface MergeCommitResult {
  sourceBranch?: string;
  targetBranch: string;
}

type ConflictSideStatus = ConflictFileStatus['currentStatus'];

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

function parseGraphLogOutput(
  raw: string,
  repoId: string,
  refsByHash: ReadonlyMap<string, string[]>,
): GraphCommitNode[] {
  const commits: GraphCommitNode[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [hash, parentsRaw, committerDateRaw] = line.split('\x00');
    if (!hash || committerDateRaw === undefined) continue;
    commits.push({
      hash,
      repoId,
      committerDate: committerDateRaw.trim(),
      parents: parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [],
      refs: refsByHash.get(hash) ?? [],
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

function normalizeCombinedDiffStatus(code: string): string {
  const normalized = code.replace(/\d+$/, '');
  if (normalized.length <= 1) return normalized || 'M';
  if (normalized.includes('R')) return 'R';
  if (normalized.includes('C')) return 'C';
  if (normalized.includes('D')) return 'D';
  if (normalized.includes('A')) return 'A';
  return 'M';
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
  isGone?: boolean;
};

type PullStrategy = 'merge' | 'rebase' | 'ff-only' | 'default';

interface PullAutoStash {
  hash: string;
  shortHash: string;
}

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
  const match = line.match(/^([ +\-U]?)([0-9a-f]{40,64})\s+(.+)$/i);
  if (!match) return undefined;
  const flag = match[1] || ' ';
  let submodulePath = match[3];
  // The optional describe suffix is separated from the path by " (". Preserve
  // spaces inside the path itself (the previous \S+ parser truncated them).
  const descriptionIndex = submodulePath.lastIndexOf(' (');
  if (descriptionIndex >= 0 && submodulePath.endsWith(')')) {
    submodulePath = submodulePath.slice(0, descriptionIndex);
  }
  return submodulePath ? { flag, path: submodulePath } : undefined;
}

function gitErrorDetail(error: unknown): string {
  const value = error as { stderr?: unknown; gitErrorCode?: unknown; message?: unknown } | undefined;
  const stderr = typeof value?.stderr === 'string' ? value.stderr.trim() : '';
  if (stderr) return stderr;
  if (typeof value?.gitErrorCode === 'string' && value.gitErrorCode) return value.gitErrorCode;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return 'Unknown error';
}

export type StatusOperationKind = 'checkout' | 'squash' | 'merge' | 'commit' | 'rebase' | 'cherry-pick' | 'revert' | 'sync' | 'stash' | 'stage';
export type SuppressStatusUpdates = <T>(operation: () => Promise<T>, kind: StatusOperationKind, label?: string) => Promise<T>;
export type RefreshStatus = () => Promise<void>;

export interface GitmoduleEntry {
  name: string;
  path: string;
  url?: string;
  branch?: string;
}

export function parseGitConfigEntries(rawConfigZ: string): GitmoduleEntry[] {
  const entries = rawConfigZ.split('\0').filter(Boolean);
  const map = new Map<string, GitmoduleEntry>();
  for (const entry of entries) {
    const nl = entry.indexOf('\n');
    if (nl === -1) continue;
    const key = entry.slice(0, nl);
    const val = entry.slice(nl + 1);
    if (!key.startsWith('submodule.')) continue;
    const lastDot = key.lastIndexOf('.');
    if (lastDot <= 'submodule.'.length - 1) continue;
    const name = key.slice('submodule.'.length, lastDot);
    const prop = key.slice(lastDot + 1);
    let item = map.get(name);
    if (!item) {
      item = { name, path: '' };
      map.set(name, item);
    }
    if (prop === 'path') item.path = val;
    else if (prop === 'url') item.url = val;
    else if (prop === 'branch') item.branch = val;
  }
  return Array.from(map.values()).filter(e => !!e.path);
}

export function unquoteGitConfigValue(val: string): string {
  const trimmed = val.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseGitmodulesFileFallback(gitmodulesPath: string): GitmoduleEntry[] {
  if (!fs.existsSync(gitmodulesPath)) return [];
  try {
    const raw = fs.readFileSync(gitmodulesPath, 'utf8');
    const map = new Map<string, GitmoduleEntry>();
    let currentName = '';
    for (const line of raw.split('\n')) {
      const sectionMatch = line.match(/^\[submodule\s+"(.+)"\]/);
      if (sectionMatch) {
        currentName = sectionMatch[1];
        continue;
      }
      if (!currentName) continue;
      const kvMatch = line.match(/^\s*(\w+)\s*=\s*(.+)$/);
      if (!kvMatch) continue;
      const [, key, rawVal] = kvMatch;
      const unquotedVal = unquoteGitConfigValue(rawVal);
      let item = map.get(currentName);
      if (!item) {
        item = { name: currentName, path: '' };
        map.set(currentName, item);
      }
      if (key === 'path') item.path = unquotedVal;
      else if (key === 'url') item.url = unquotedVal;
      else if (key === 'branch') item.branch = unquotedVal;
    }
    return Array.from(map.values()).filter(e => !!e.path);
  } catch {
    return [];
  }
}

export function parseGitmodulesFileSync(gitmodulesPath: string): GitmoduleEntry[] {
  if (!fs.existsSync(gitmodulesPath)) return [];
  try {
    const raw = execFileSync('git', ['config', '-z', '--file', gitmodulesPath, '-l'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitConfigEntries(raw);
  } catch {
    return parseGitmodulesFileFallback(gitmodulesPath);
  }
}

export async function parseGitmodulesFile(git: SimpleGit, gitmodulesPath: string): Promise<GitmoduleEntry[]> {
  if (!fs.existsSync(gitmodulesPath)) return [];
  try {
    const raw = await git.raw(['config', '-z', '--file', gitmodulesPath, '-l']).catch(() => '');
    if (!raw) return parseGitmodulesFileFallback(gitmodulesPath);
    return parseGitConfigEntries(raw);
  } catch {
    return parseGitmodulesFileFallback(gitmodulesPath);
  }
}

export class GitService {
  public readonly kind: 'git' | 'svn' = 'git';
  private _metaProvider?: () => RepoMeta | undefined;

  public setMetaProvider(provider: () => RepoMeta | undefined): void {
    this._metaProvider = provider;
  }

  public get meta(): RepoMeta {
    const provided = this._metaProvider?.();
    if (provided) return provided;
    return {
      id: this.repoId,
      name: path.basename(this.rootPath),
      rootPath: this.rootPath,
      color: '#4fc1ff',
      kind: this.kind,
    };
  }

  public get name(): string {
    return this.meta.name;
  }

  private git: SimpleGit;
  private readonly blameService = new BlameService();
  private pendingPullAutoStash: PullAutoStash | undefined;
  // Set immediately after a tag checkout, cleared when VS Code API confirms the update.
  private _pendingDetachedTag: string | undefined;
  // Cache of commit hash -> diff stats (immutable commit properties)
  private commitStatsCache = new Map<string, { filesChanged: number; additions: number; deletions: number }>();
  // Cache of stash commit OID -> file entries (immutable commit properties)
  private stashFilesCache = new Map<string, Array<{ path: string; status: string }>>();
  // Cache of { lastCommit: string; splitHash: string } keyed by prefix
  private subtreeSplitCache = new Map<string, { lastCommit: string; splitHash: string }>();
  // Lock to sequence expensive subtree split executions and prevent CPU exhaustion
  private subtreeSplitLock: Promise<unknown> = Promise.resolve();
  // Cache of remote ref lookup results keyed by `${repository}\0${refspec}`
  private subtreeRemoteHashCache = new Map<string, {
    result: { hash?: string; ref?: string; unreachable?: boolean; notFound?: boolean; error?: string };
    cachedAt: number;
  }>();
  // In-flight remote ref queries to deduplicate concurrent requests
  private subtreeRemoteInFlight = new Map<string, Promise<{ hash?: string; ref?: string; unreachable?: boolean; notFound?: boolean; error?: string }>>();

  invalidateSubtreeRemoteCache(repository?: string): void {
    if (repository) {
      const cleanRepo = repository.trim().toLowerCase();
      for (const key of Array.from(this.subtreeRemoteHashCache.keys())) {
        const repoPart = key.split('\0')[0]?.trim().toLowerCase();
        if (repoPart === cleanRepo) {
          this.subtreeRemoteHashCache.delete(key);
        }
      }
      return;
    }
    this.subtreeRemoteHashCache.clear();
  }

  restoreSubtreeSplitCache(cache: Record<string, { lastCommit: string; splitHash: string }>): void {
    if (!cache || typeof cache !== 'object') return;
    for (const [prefix, entry] of Object.entries(cache)) {
      if (entry && typeof entry.lastCommit === 'string' && typeof entry.splitHash === 'string') {
        this.subtreeSplitCache.set(prefix, entry);
      }
    }
  }

  exportSubtreeSplitCache(): Record<string, { lastCommit: string; splitHash: string }> {
    const result: Record<string, { lastCommit: string; splitHash: string }> = {};
    for (const [prefix, entry] of this.subtreeSplitCache.entries()) {
      result[prefix] = entry;
    }
    return result;
  }

  constructor(
    public readonly repoId: string,
    public readonly rootPath: string,
    private readonly suppressStatusUpdates?: SuppressStatusUpdates,
    protected readonly refreshStatus?: RefreshStatus,
    private readonly publishMissingRemote?: PublishMissingRemote,
    protected readonly logger?: VersionDockLogger,
  ) {
    // Git's optional index refresh in commands such as `status` is a read
    // operation from VersionDock's perspective. Disable that refresh, while
    // leaving independent read-only commands free to run concurrently. Git
    // mutations are serialized explicitly by GitOperationLock instead.
    this.git = createGitClient(rootPath);
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

  private logMetadataCache: {
    timestamp: number;
    refsByHash: Map<string, string[]>;
    unpushedHashes: Set<string> | 'all';
    incomingHashes: Set<string>;
    worktreeUnpushedHashes: Set<string>;
  } | null = null;
  private pendingLogMetadataPromise: Promise<{
    refsByHash: Map<string, string[]>;
    unpushedHashes: Set<string> | 'all';
    incomingHashes: Set<string>;
    worktreeUnpushedHashes: Set<string>;
  }> | null = null;

  public invalidateLogMetadataCache(): void {
    this.logMetadataCache = null;
    this.pendingLogMetadataPromise = null;
  }

  protected runStatusSensitiveOperation<T>(operation: () => Promise<T>, kind: StatusOperationKind, label?: string): Promise<T> {
    this.invalidateLogMetadataCache();
    // Hold the repository lock only for the Git mutation itself. The status
    // suppression helper may wait for a refresh after the mutation; keeping
    // the lock during that wait could block the auto-commit triggered by that
    // refresh.
    const lockedOperation = () => this.withWriteLock(operation);
    return this.suppressStatusUpdates ? this.suppressStatusUpdates(lockedOperation, kind, label) : lockedOperation();
  }

  private async refreshStatusAfterOperation(): Promise<void> {
    await this.refreshStatus?.().catch(() => {});
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return withGitWriteLock(this.rootPath, operation);
  }

  /** Run a compound working-tree operation without allowing another Git writer to interleave. */
  async runWithGitWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withWriteLock(operation);
  }

  private async rawPathSafe(args: string[]): Promise<string> {
    await waitForGitWrite(this.rootPath);
    return this.git.raw(['-c', 'core.quotepath=false', ...args]);
  }

  resolveRepoPath(filePath: string, options: { allowRoot?: boolean } = {}): ResolvedRepoPath {
    return resolvePathWithinRepo(this.rootPath, filePath, options);
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

  private getCatFileFlag(): string {
    const mode = vscode.workspace
      .getConfiguration('versiondock')
      .get<'filters' | 'textconv' | 'none'>('git.catFileFilterMode', 'filters');
    if (mode === 'textconv') return '--textconv';
    if (mode === 'none') return '-p';
    return '--filters';
  }

  /**
   * Reads file content from a Git revision or stage applying configured content transformations
   * (e.g. Git LFS smudge filters or format textconv), with safe fallback to raw content.
   */
  async readGitFileContent(revision: string, filePath: string): Promise<string> {
    const relPath = this.normalizeRepoPath(filePath);
    const spec = revision ? `${this.safeRevisionArg(revision)}:${relPath}` : `:${relPath}`;
    const flag = this.getCatFileFlag();

    if (flag === '-p') {
      try {
        return await this.git.raw(['cat-file', '-p', spec]);
      } catch {
        return '';
      }
    }

    try {
      return await this.git.raw(['cat-file', flag, spec]);
    } catch {
      // Fall back to raw cat-file -p if filters or textconv fail
      try {
        return await this.git.raw(['cat-file', '-p', spec]);
      } catch {
        return '';
      }
    }
  }

  private async showStageFileBuffer(stage: 1 | 2 | 3, filePath: string): Promise<Buffer> {
    const relPath = this.normalizeRepoPath(filePath);
    const spec = `:${stage}:${relPath}`;
    const flag = this.getCatFileFlag();
    if (flag === '-p') {
      return this.git.showBuffer(spec);
    }
    try {
      const output = await this.git.raw(['cat-file', flag, spec]);
      return Buffer.from(output, 'binary');
    } catch {
      return this.git.showBuffer(spec);
    }
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
    const first = await this.readStatusFreshSnapshot();
    if (getGitWriteGeneration(this.rootPath) === first.generation) return first.status;

    // A write started while the parallel status queries were running. Read one
    // more complete snapshot, but do not wait for future queued writers.
    return (await this.readStatusFreshSnapshot()).status;
  }

  private async readStatusFreshSnapshot(): Promise<{ status: RepoStatus; generation: number }> {
    await waitForGitWrite(this.rootPath);
    const generation = getGitWriteGeneration(this.rootPath);
    const [status, branchInfo, submoduleStatuses, operationState] = await Promise.all([
      this.git.status(),
      this.getCurrentBranch(),
      this.getSubmoduleStatuses(),
      this.getOperationState(),
    ]);

    // Override aheadBehind with a direct git count — always attempt rev-list since
    // the VS Code API's HEAD.upstream can lag and arrive undefined even when a tracking
    // branch is configured, causing ahead/behind to be silently skipped.
    // Also directly query HEAD commit to ensure fresh lastCommitHash after operations like reset/undo.
    let freshBranchInfo = branchInfo;
    try {
      const [aheadRaw, behindRaw, headRaw] = await Promise.all([
        this.git.raw(['rev-list', '--count', '@{u}..HEAD']).catch(() => ''),
        this.git.raw(['rev-list', '--count', 'HEAD..@{u}']).catch(() => ''),
        this.git.raw(['rev-parse', 'HEAD']).catch(() => ''),
      ]);
      const ahead = parseInt(aheadRaw.trim(), 10);
      const behind = parseInt(behindRaw.trim(), 10);
      const headCommit = headRaw.trim() || undefined;
      freshBranchInfo = {
        ...branchInfo,
        aheadBehind: (!isNaN(ahead) && !isNaN(behind)) ? { ahead, behind } : branchInfo.aheadBehind,
        lastCommitHash: headCommit ?? branchInfo.lastCommitHash,
        detachedHash: status.detached ? (headCommit ? headCommit.slice(0, 8) : branchInfo.detachedHash) : branchInfo.detachedHash,
      };
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

    return {
      status: { repoId: this.repoId, branch: freshBranchInfo, stagedFiles, unstagedFiles, isDetachedHead: status.detached, conflictCount, operationState },
      generation,
    };
  }

  protected async assertPullAllowed(): Promise<void> {
    const status = await this.getStatusFresh();
    if (status.conflictCount > 0 || status.operationState) {
      throw new Error(t('Cannot update while conflicts are unresolved or another version-control operation is in progress. Resolve the conflicts and complete or abort the current operation first.'));
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
    await waitForGitWrite(this.rootPath);
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
      let upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
      let aheadBehind = (head?.ahead !== undefined && head?.behind !== undefined)
        ? { ahead: head.ahead, behind: head.behind }
        : undefined;

      let isGone: boolean | undefined;
      if (!isDetached) {
        try {
          const tracking = (await this.getLocalBranchTrackingInfo()).get(branchName);
          if (tracking) {
            upstream = tracking.upstream ?? upstream;
            if (tracking.aheadBehind !== undefined) {
              aheadBehind = tracking.aheadBehind;
            }
            if (tracking.isGone !== undefined) {
              isGone = tracking.isGone;
            }
          }
        } catch { /* ignore fallback */ }
      }

      if (!isDetached && upstream && (aheadBehind === undefined || (aheadBehind.ahead === 0 && aheadBehind.behind === 0))) {
        try {
          const [aheadRaw, behindRaw] = await Promise.all([
            this.git.raw(['rev-list', '--count', '@{u}..HEAD']).catch(() => ''),
            this.git.raw(['rev-list', '--count', 'HEAD..@{u}']).catch(() => ''),
          ]);
          const ahead = parseInt(aheadRaw.trim(), 10);
          const behind = parseInt(behindRaw.trim(), 10);
          if (!isNaN(ahead) && !isNaN(behind)) {
            aheadBehind = { ahead, behind };
          }
        } catch { /* ignore fallback */ }
      }

      const branchInfo: BranchInfo = {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream,
        aheadBehind,
        detachedTag,
        detachedHash,
        isGone,
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

  private _lastBranchInfo?: BranchInfo;

  getCachedBranch(): BranchInfo | undefined {
    const vsRepo = this.vsRepo();
    if (vsRepo) {
      const head = vsRepo.state.HEAD;
      if (!head) return this._lastBranchInfo;
      const vsTagName = head.type === RefType.Tag ? head.name : undefined;
      const isDetached = head.type !== RefType.Head && Boolean(vsTagName || !head.name);
      const branchName = head.name || (isDetached ? 'HEAD' : undefined);
      if (!branchName) return this._lastBranchInfo;
      const upstream = head.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
      const aheadBehind = (head.ahead !== undefined && head.behind !== undefined)
        ? { ahead: head.ahead, behind: head.behind }
        : undefined;
      return {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream,
        aheadBehind,
        lastCommitHash: head.commit,
        detachedTag: vsTagName,
        detachedHash: isDetached && !vsTagName ? head.commit?.slice(0, 8) : undefined,
        isProtected: !isDetached && isBranchProtected(branchName),
      };
    }
    return this._lastBranchInfo;
  }

  async getCurrentBranch(): Promise<BranchInfo> {
    await waitForGitWrite(this.rootPath);
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
      const isNamedBranch = Boolean(resolvedBranchName) && head?.type !== RefType.Tag;
      const isDetached = !isNamedBranch;
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
      let upstream = head?.upstream ? `${head.upstream.remote}/${head.upstream.name}` : undefined;
      let aheadBehind = (head?.ahead !== undefined && head?.behind !== undefined)
        ? { ahead: head.ahead, behind: head.behind }
        : undefined;

      let isGone: boolean | undefined;
      if (isNamedBranch) {
        // If upstream and aheadBehind are already provided by vsRepo HEAD, skip running
        // the external `git for-each-ref` CLI unless tracking information is missing.
        if (!upstream || aheadBehind === undefined) {
          try {
            const tracking = (await this.getLocalBranchTrackingInfo()).get(branchName);
            if (tracking) {
              upstream = tracking.upstream ?? upstream;
              if (tracking.aheadBehind !== undefined) {
                aheadBehind = tracking.aheadBehind;
              }
              if (tracking.isGone !== undefined) {
                isGone = tracking.isGone;
              }
            }
          } catch { /* ignore fallback */ }
        }
      }

      const result: BranchInfo = {
        repoId: this.repoId,
        name: branchName,
        fullName: isDetached ? `HEAD` : `refs/heads/${branchName}`,
        isHead: true,
        isRemote: false,
        upstream,
        aheadBehind,
        lastCommitHash: head?.commit,
        detachedTag,
        detachedHash,
        isGone,
        isProtected: !isDetached && isBranchProtected(branchName),
      };
      this._lastBranchInfo = result;
      return result;
    }
    const status = await this.git.status();
    const isDetached = status.detached;
    const branchName = await this.resolveHeadName(status.current ?? undefined);
    const detachedTag = isDetached ? await this.getDetachedTag() : undefined;
    let lastCommitHash: string | undefined;
    try {
      lastCommitHash = (await this.git.raw(['rev-parse', 'HEAD'])).trim() || undefined;
    } catch { /* ignore */ }
    const detachedHash = (isDetached && !detachedTag) ? (lastCommitHash ? lastCommitHash.slice(0, 8) : await this.getShortHash()) : undefined;
    let upstream = status.tracking ?? undefined;
    let aheadBehind = status.tracking ? { ahead: status.ahead, behind: status.behind } : undefined;
    let isGone: boolean | undefined;
    if (!isDetached) {
      try {
        const tracking = (await this.getLocalBranchTrackingInfo()).get(branchName);
        if (tracking) {
          upstream = tracking.upstream ?? upstream;
          if (tracking.aheadBehind !== undefined) {
            aheadBehind = tracking.aheadBehind;
          }
          if (tracking.isGone !== undefined) {
            isGone = tracking.isGone;
          }
        }
      } catch { /* ignore fallback */ }
    }
    const fallbackResult: BranchInfo = {
      repoId: this.repoId,
      name: branchName,
      fullName: isDetached ? 'HEAD' : `refs/heads/${branchName}`,
      isHead: true,
      isRemote: false,
      upstream,
      aheadBehind,
      lastCommitHash,
      detachedTag,
      detachedHash,
      isGone,
      isProtected: !isDetached && isBranchProtected(branchName),
    };
    this._lastBranchInfo = fallbackResult;
    return fallbackResult;
  }

  async getBranches(): Promise<BranchInfo[]> {
    await waitForGitWrite(this.rootPath);
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
            ?? ((isHead && head?.ahead !== undefined && head?.behind !== undefined)
              ? { ahead: head.ahead, behind: head.behind }
              : undefined),
          isGone: tracking?.isGone,
          isProtected: isBranchProtected(name),
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
          isProtected: isBranchProtected(name),
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
    const [result, trackingInfo] = await Promise.all([
      this.git.branch(['-avv', '--sort=-committerdate']),
      this.getLocalBranchTrackingInfo().catch(() => new Map<string, BranchTrackingInfo>()),
    ]);
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
      const tracking = !isRemote ? trackingInfo.get(cleanName) : undefined;
      branches.push({
        repoId: this.repoId,
        name: cleanName,
        fullName: isRemote ? `refs/remotes/${cleanName}` : `refs/heads/${cleanName}`,
        isHead: branch.current,
        isRemote,
        remoteName,
        lastCommitHash: fullHashMap.get(cleanName) ?? branch.commit,
        upstream: tracking?.upstream,
        aheadBehind: tracking?.aheadBehind ?? aheadBehind,
        isGone: tracking?.isGone ?? (branch.label?.includes(': gone]') ?? false),
        isProtected: isBranchProtected(cleanName),
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
        const isGone = Boolean(track && track.includes('[gone]'));
        const aheadBehind = upstream
          ? (parseAheadBehindTrack(track ?? '') ?? { ahead: 0, behind: 0 })
          : undefined;
        map.set(name, {
          upstream: upstream || undefined,
          upstreamRemote: upstreamRemote || undefined,
          upstreamRemoteRef: upstreamRemoteRef || undefined,
          aheadBehind,
          isGone,
        });
      }
    } catch {
      // Branch list rendering should not fail just because tracking metadata is unavailable.
    }
    return map;
  }

  async getGoneBranches(): Promise<string[]> {
    const tracking = await this.getLocalBranchTrackingInfo();
    const gone: string[] = [];
    for (const [name, info] of tracking.entries()) {
      if (info.isGone) gone.push(name);
    }
    return gone;
  }

  async getHeadCommit(): Promise<{ hash: string; shortHash: string; message: string; relativeDate: string; author: string } | undefined> {
    try {
      const raw = await this.git.raw(['log', '-1', '--format=%H%x00%h%x00%s%x00%ct%x00%an']);
      const parts = raw.trim().split('\x00');
      if (parts.length >= 5 && parts[0] && parts[1]) {
        return {
          hash: parts[0],
          shortHash: parts[1],
          message: parts[2] || '',
          relativeDate: formatRelativeTime(parts[3] || 0),
          author: parts[4] || '',
        };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  async getBranchLastCommits(): Promise<Map<string, { message: string; relativeDate: string; author: string }>> {
    const map = new Map<string, { message: string; relativeDate: string; author: string }>();
    try {
      const raw = await this.git.raw([
        'for-each-ref',
        '--format=%(refname:short)%00%(contents:subject)%00%(committerdate:unix)%00%(authorname)',
        'refs/heads/',
        'refs/remotes/',
      ]);
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const [ref, message, relativeDate, author] = line.split('\x00');
        if (ref) {
          map.set(ref, {
            message: (message || '').trim(),
            relativeDate: formatRelativeTime(relativeDate || 0),
            author: (author || '').trim(),
          });
        }
      }
    } catch { /* ignore */ }
    return map;
  }

  async captureUpdateSnapshot(branchName?: string): Promise<VcsUpdateSnapshot | undefined> {
    const currentBranch = await this.getCurrentBranch();
    if (branchName && branchName !== currentBranch.name) return undefined;

    const upstreamRef = (await this.git.raw([
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ]).catch(() => '')).trim() || undefined;
    const beforeHeadHash = (await this.git.raw(['rev-parse', '--verify', 'HEAD']).catch(() => '')).trim() || undefined;

    return {
      kind: 'git',
      repoId: this.repoId,
      branchName: currentBranch.name,
      beforeHeadHash,
      upstreamRef,
    } satisfies GitUpdateSnapshot;
  }

  async getUpdateCommitsDetailed(snapshot: VcsUpdateSnapshot): Promise<DetailedUpdateCommit[]> {
    if (snapshot.kind !== 'git' || snapshot.repoId !== this.repoId) return [];
    if (!snapshot.upstreamRef || !snapshot.beforeHeadHash) return [];

    const currentBranch = await this.getCurrentBranch();
    if (currentBranch.name !== snapshot.branchName) return [];

    const afterUpstreamHash = (await this.git.raw([
      'rev-parse',
      '--verify',
      snapshot.upstreamRef,
    ]).catch(() => '')).trim();
    if (!afterUpstreamHash) return [];

    const GS = '\x1D';
    const RS = '\x1E';
    const raw = await this.git.raw([
      'log',
      `--format=%x1E%H%x1D%h%x1D%s%x1D%B%x1D%aN%x1D%aE%x1D%aI%x1D%cI%x1D%P`,
      `${this.safeRevisionArg(snapshot.beforeHeadHash)}..${this.safeRevisionArg(afterUpstreamHash)}`,
    ]);

    const commits: DetailedUpdateCommit[] = [];
    const entries = raw.split(RS).filter(Boolean);
    for (const entry of entries) {
      const parts = entry.split(GS);
      const hash = parts[0]?.trim();
      if (!hash) continue;
      const shortHash = parts[1]?.trim() || hash.slice(0, 7);
      const message = parts[2]?.trim() ?? '';
      const fullMessage = parts[3]?.trim() ?? message;
      const authorName = parts[4]?.trim() ?? '';
      const authorEmail = parts[5]?.trim() ?? '';
      const authorDate = parts[6]?.trim() ?? '';
      const committerDate = parts[7]?.trim() ?? '';
      const parents = parts[8] ? parts[8].trim().split(' ').filter(Boolean) : [];
      commits.push({
        hash,
        shortHash,
        message,
        fullMessage,
        authorName,
        authorEmail,
        authorDate,
        committerDate,
        parents,
      });
    }
    return commits;
  }

  async getUpdateCommitHashes(snapshot: VcsUpdateSnapshot): Promise<string[]> {
    const detailed = await this.getUpdateCommitsDetailed(snapshot);
    return detailed.map(c => c.hash);
  }

  async pullBranch(branchName: string): Promise<string> {
    return this.withWriteLock(async () => {
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
    });
  }

  private async getLogMetadata(worktreeServices: GitService[] = [], forceFresh = false): Promise<{
    refsByHash: Map<string, string[]>;
    unpushedHashes: Set<string> | 'all';
    incomingHashes: Set<string>;
    worktreeUnpushedHashes: Set<string>;
  }> {
    const TTL = 10_000;
    if (!forceFresh && this.logMetadataCache && (Date.now() - this.logMetadataCache.timestamp < TTL)) {
      return this.logMetadataCache;
    }
    if (!forceFresh && this.pendingLogMetadataPromise) {
      return this.pendingLogMetadataPromise;
    }

    const fetchTask = (async () => {
      const [refsByHash, unpushedHashes, incomingHashes, ...worktreeUnpushedResults] = await Promise.all([
        this.getDecoratedRefsByCommit(),
        this.getUnpushedHashes(),
        this.getIncomingHashes(),
        ...worktreeServices.map(wt => wt.getUnpushedHashes()),
      ]);

      const worktreeUnpushedHashes = new Set<string>();
      for (const wtResult of worktreeUnpushedResults) {
        if (wtResult !== 'all') {
          wtResult.forEach(h => worktreeUnpushedHashes.add(h));
        }
      }

      const snapshot = {
        timestamp: Date.now(),
        refsByHash,
        unpushedHashes,
        incomingHashes,
        worktreeUnpushedHashes,
      };
      this.logMetadataCache = snapshot;
      this.pendingLogMetadataPromise = null;
      return snapshot;
    })();

    this.pendingLogMetadataPromise = fetchTask;
    return fetchTask;
  }

  private isNoCommitsError(err: unknown): boolean {
    const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
    return (
      text.includes('unknown revision or path not in the working tree') ||
      text.includes('does not have any commits yet') ||
      text.includes("bad default revision 'head'") ||
      text.includes("ambiguous argument 'head'") ||
      text.includes('needed a single revision') ||
      text.includes('cannot be used with --all')
    );
  }

  // Log uses raw git format for graph rendering — VS Code API's log() lacks graph parents/refs.
  async getGraphLog(limit?: number): Promise<GraphCommitNode[]> {
    if (limit !== undefined && limit <= 0) return [];
    const args = [
      'log',
      '--date-order',
      ...(limit === undefined ? [] : [`--max-count=${limit}`]),
      GRAPH_LOG_RECORD_FORMAT,
      '--date=iso-strict',
      'HEAD',
      '--exclude=refs/stash',
      '--exclude=refs/versiondock/ai-composer/*',
      '--all',
    ];
    try {
      const [raw, metadata] = await Promise.all([
        this.git.raw(args),
        this.getLogMetadata([], false),
      ]);
      return parseGraphLogOutput(raw, this.repoId, metadata.refsByHash);
    } catch (err: unknown) {
      if (this.isNoCommitsError(err)) {
        return [];
      }
      throw err;
    }
  }

  // Full log data stays paginated because it also resolves author/message and
  // local/remote state. The lightweight graph log above is safe to prefetch.
  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange; worktreeServices?: GitService[]; consumer?: string }): Promise<CommitNode[]> {
    const revisionSearch = await this.resolveRevisionSearch(opts?.filterText);
    if (revisionSearch !== undefined && (skip > 0 || !revisionSearch)) return [];
    if (revisionSearch !== undefined && opts?.filterBranch && !(await this.isAncestor(revisionSearch, opts.filterBranch))) {
      return [];
    }

    const args: string[] = [
      'log',
      // Match JetBrains' history ordering: prioritize commit dates while
      // still respecting the parent/child relationship between commits.
      '--date-order',
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
      // Put the checked-out history first when several tips have the same
      // commit timestamp. This matches JetBrains and avoids `--all`'s ref
      // enumeration order placing a remote/incoming branch above HEAD.
      args.push('HEAD', '--exclude=refs/stash', '--exclude=refs/versiondock/ai-composer/*', '--all');
    }
    if (opts?.filterPath && !lineRange) args.push('--', this.literalPathspec(opts.filterPath));

    const worktreeServices = opts?.worktreeServices ?? [];
    const forceFresh = skip === 0;
    let raw = '';
    let metadata: {
      refsByHash: Map<string, string[]>;
      unpushedHashes: Set<string> | 'all';
      incomingHashes: Set<string>;
      worktreeUnpushedHashes: Set<string>;
    };
    try {
      const [rawResult, metaResult] = await Promise.all([
        this.git.raw(args),
        this.getLogMetadata(worktreeServices, forceFresh),
      ]);
      raw = rawResult;
      metadata = metaResult;
    } catch (err: unknown) {
      if (this.isNoCommitsError(err)) {
        const emptyList: CommitLogList = [];
        emptyList.hasMore = false;
        return emptyList;
      }
      throw err;
    }
    const commits = parseLogOutput(raw, this.repoId, metadata.refsByHash);

    // Mark unpushed commits: hashes ahead of the remote tracking branch.
    // 'all' means there is no upstream — every commit on this branch is local.
    const { unpushedHashes, incomingHashes, worktreeUnpushedHashes } = metadata;
    const allUnpushedHashes = new Set<string>();
    if (unpushedHashes === 'all') {
      for (const c of commits) c.unpushed = true;
    } else {
      unpushedHashes.forEach(h => allUnpushedHashes.add(h));
    }
    worktreeUnpushedHashes.forEach(h => allUnpushedHashes.add(h));
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

  async getIncomingCount(): Promise<number> {
    try {
      const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (!tracking) return 0;
      const raw = await this.git.raw(['rev-list', '--count', `HEAD..${tracking}`]);
      return parseInt(raw.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  async getSyncCounts(): Promise<{ unpushed: number; incoming: number }> {
    const [unpushed, incoming] = await Promise.all([
      this.getUnpushedCount(),
      this.getIncomingCount(),
    ]);
    return { unpushed, incoming };
  }

  private parseCommitStats(raw: string): Record<string, { filesChanged: number; additions: number; deletions: number }> {
    const result: Record<string, { filesChanged: number; additions: number; deletions: number }> = {};
    for (const block of raw.split('\x1E')) {
      if (!block.trim()) continue;
      const lines = block.trim().split('\n');
      const hash = lines[0]?.trim();
      if (!hash) continue;

      let filesChanged = 0;
      let additions = 0;
      let deletions = 0;
      let hasNumstat = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length >= 3) {
          hasNumstat = true;
          filesChanged++;
          if (parts[0] !== '-') {
            const add = parseInt(parts[0], 10);
            if (!isNaN(add)) additions += add;
          }
          if (parts[1] !== '-') {
            const del = parseInt(parts[1], 10);
            if (!isNaN(del)) deletions += del;
          }
        }
      }

      let statLine: string | undefined;
      if (!hasNumstat) {
        // 兼容短文本兜底
        statLine = lines.find(l => /(\d+)\s+files? changed|(\d+)\s+insertions?|(\d+)\s+deletions?/i.test(l));
        if (statLine) {
          const files = statLine.match(/(\d+)\s+files? changed/i);
          const ins = statLine.match(/(\d+)\s+insertions?/i);
          const del = statLine.match(/(\d+)\s+deletions?/i);
          filesChanged = files ? parseInt(files[1], 10) : 0;
          additions = ins ? parseInt(ins[1], 10) : 0;
          deletions = del ? parseInt(del[1], 10) : 0;
        }
      }

      if (!hasNumstat && !statLine) {
        // 既没有 numstat 也没有统计摘要行，说明 Git 未输出该提交的统计
        // 跳过缓存，避免将“统计不可用”错误显示为“0 files changed”
        continue;
      }

      const stat = { filesChanged, additions, deletions };
      result[hash] = stat;
      this.commitStatsCache.set(hash, stat);
    }
    return result;
  }

  private async runCommitStatsLog(rangeArgs: string[]): Promise<string> {
    try {
      return await this.git.raw(['log', ...rangeArgs, '--format=%x1E%H', '--diff-merges=first-parent', '--numstat']);
    } catch {
      return await this.git.raw(['log', ...rangeArgs, '--format=%x1E%H', '--numstat']).catch(() => '');
    }
  }

  async getUnpushedCommitsStats(): Promise<Record<string, { filesChanged: number; additions: number; deletions: number }>> {
    try {
      const raw = await this.runCommitStatsLog(['@{u}..HEAD']);
      if (raw) return this.parseCommitStats(raw);
      throw new Error('No upstream stats');
    } catch {
      try {
        const remotes = await this.git.getRemotes();
        const range = remotes.length === 0
          ? ['HEAD', '--max-count=100']
          : ['HEAD', '--not', '--remotes'];
        const raw = await this.runCommitStatsLog(range);
        return this.parseCommitStats(raw);
      } catch {
        return {};
      }
    }
  }

  async getIncomingCommitsStats(): Promise<Record<string, { filesChanged: number; additions: number; deletions: number }>> {
    try {
      const tracking = (await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
      if (!tracking) return {};
      const raw = await this.runCommitStatsLog([`HEAD..${tracking}`]);
      return this.parseCommitStats(raw);
    } catch {
      return {};
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

  public async getCommitParents(hash: string, knownParents?: string[]): Promise<string[]> {
    if (knownParents && knownParents.length > 0) {
      return knownParents.map(parent => this.safeRevisionArg(parent));
    }
    const raw = await this.git.raw(['log', '-1', '--format=%P', this.safeRevisionArg(hash)]).catch(() => '');
    return raw.trim().split(' ').filter(Boolean).map(parent => this.safeRevisionArg(parent));
  }

  private async getFilesBetween(baseHash: string, targetHash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const [nameStatus, numStat] = await Promise.all([
      this.rawPathSafe(['diff', '--name-status', '-z', '-M', baseHash, targetHash]),
      this.rawPathSafe(['diff', '--numstat', '-z', '-M', baseHash, targetHash]),
    ]);
    const stats = parseNumStatZOutput(numStat);
    return parseNameStatusZOutput(nameStatus).map(file => {
      const stat = stats.get(file.path);
      return {
        status: file.code.replace(/\d+$/, ''),
        path: file.path,
        added: stat?.added,
        removed: stat?.removed,
      };
    });
  }

  async getMergeParentChanges(hash: string, knownParents?: string[]): Promise<import('../types/messages').MergeParentChange[]> {
    const safeHash = this.safeRevisionArg(hash);
    const parents = await this.getCommitParents(safeHash, knownParents);
    if (parents.length < 2) return [];

    const changes = await Promise.all(parents.map(async (parentHash, parentIndex) => {
      const [metadata, changedPaths] = await Promise.all([
        this.git.raw(['show', '-s', '--format=%h%x00%an%x00%ai%x00%s', parentHash]),
        this.rawPathSafe(['diff', '--name-only', '-z', '-M', parentHash, safeHash]),
      ]);
      const [shortHash = parentHash.slice(0, 7), authorName = '', authorDate = '', ...messageParts] = metadata.trimEnd().split('\x00');
      return {
        hash: parentHash,
        shortHash,
        message: messageParts.join('\x00'),
        authorName,
        authorDate,
        parentIndex,
        fileCount: changedPaths.split('\x00').filter(Boolean).length,
      };
    }));

    return changes.filter(change => change.fileCount > 0);
  }

  async getMergeParentFiles(hash: string, parentHash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const safeHash = this.safeRevisionArg(hash);
    const safeParentHash = this.safeRevisionArg(parentHash);
    const parents = await this.getCommitParents(safeHash);
    if (!parents.includes(safeParentHash)) {
      throw new Error(`Commit ${safeParentHash} is not a parent of merge commit ${safeHash}`);
    }
    return this.getFilesBetween(safeParentHash, safeHash);
  }

  async getCommitFiles(hash: string, knownParents?: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const safeHash = this.safeRevisionArg(hash);
    const parents = await this.getCommitParents(safeHash, knownParents);
    const isMerge = parents.length >= 2;

    if (isMerge) {
      return this.getFilesBetween(parents[0], safeHash);
    }

    const [nameStatus, numStat] = await Promise.all([
      this.rawPathSafe(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--name-status', safeHash]),
      this.rawPathSafe(['diff-tree', '--root', '--no-commit-id', '-r', '-z', '-M', '--numstat', safeHash]),
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

  async getCommitFilesForLogDetail(hash: string, knownParents?: string[]): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const safeHash = this.safeRevisionArg(hash);
    const parents = await this.getCommitParents(safeHash, knownParents);
    if (parents.length < 2) {
      return this.getCommitFiles(safeHash, parents);
    }

    // A combined diff contains only paths changed by the merge resolution
    // itself. Differences introduced by each parent are exposed separately
    // through getMergeParentChanges()/getMergeParentFiles().
    const nameStatus = await this.rawPathSafe([
      'diff-tree', '--no-commit-id', '-r', '--cc', '-z', '-M', '--name-status', safeHash,
    ]);
    return parseNameStatusZOutput(nameStatus).map(file => ({
      status: normalizeCombinedDiffStatus(file.code),
      path: file.path,
    }));
  }

  async getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
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
      diff.originalContent = await this.readGitFileContent(`${hash}~1`, originalPath);
      diff.modifiedContent = await this.readGitFileContent(hash, modifiedPath);
      return diff;
    } catch (error) {
      this.logger?.debug('GitService', 'Failed to get file diff', { repoId, hash, filePath, error: String(error) });
      return null;
    }
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
      diff.originalContent = await this.readGitFileContent('HEAD', relPath);
      const stagedModified = await this.readGitFileContent('', relPath);
      diff.modifiedContent = stagedModified || (workingFile?.content ?? '');
      return diff;
    } catch (error) {
      this.logger?.debug('GitService', 'Failed to get staged diff', { repoId, filePath, error: String(error) });
      return null;
    }
  }

  async getUnstagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    try {
      const relPath = this.normalizeRepoPath(filePath);
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
      diff.originalContent = await this.readGitFileContent('', relPath);
      diff.modifiedContent = workingFile?.content ?? '';
      return diff;
    } catch (error) {
      this.logger?.debug('GitService', 'Failed to get unstaged diff', { repoId, filePath, error: String(error) });
      return null;
    }
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
      diff.originalContent = await this.readGitFileContent(safeBaseRef, originalPath);
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

  private async execGitLsRemote(
    args: string[],
    timeoutMs = 8000,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'core.quotepath=false', ...args],
        {
          cwd: this.rootPath,
          env: getGitEnvironment(),
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const out = stdout?.toString() ?? '';
          const err = stderr?.toString() ?? '';
          if (error) {
            const errObj = error as NodeJS.ErrnoException & { killed?: boolean };
            if (errObj.code === 'ETIMEDOUT' || errObj.killed) {
              reject(new Error(`git ls-remote timed out after ${timeoutMs}ms (process killed)`));
              return;
            }
            const detail = err.trim() || out.trim() || error.message;
            reject(new Error(detail));
            return;
          }
          resolve(out);
        },
      );
    });
  }

  async listSubtreeRepositoryRefs(repository: string): Promise<Array<{ name: string; type: 'branch' | 'tag' }>> {
    const output = await this.execGitLsRemote(['ls-remote', '--heads', '--tags', repository], 10000);
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
    return this.withWriteLock(async () => {
      const args = ['subtree', 'add', this.subtreePrefixArg(prefix)];
      if (squash) args.push('--squash');
      if (message?.trim()) args.push('-m', message.trim());
      args.push(repository, ref);
      return this.rawPathSafe(args);
    });
  }

  async pullSubtree(prefix: string, repository: string, ref: string, squash: boolean, message?: string): Promise<string> {
    return this.withWriteLock(async () => {
      await this.assertPullAllowed();
      const args = ['subtree', 'pull', this.subtreePrefixArg(prefix)];
      if (squash) args.push('--squash');
      if (message?.trim()) args.push('-m', message.trim());
      args.push(repository, ref);
      return this.rawPathSafe(args);
    });
  }

  async pushSubtree(prefix: string, repository: string, refspec: string): Promise<string> {
    return this.withWriteLock(() => this.rawPathSafe(['subtree', 'push', this.subtreePrefixArg(prefix), repository, refspec]));
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


  private async getSubtreePrefixLastCommit(prefix: string): Promise<string> {
    try {
      const output = await this.git.raw(['log', '-1', '--format=%H', 'HEAD', '--', prefix]);
      return output.trim().toLowerCase();
    } catch {
      return '';
    }
  }

  private async getSubtreeSplitHashFast(prefix: string): Promise<string> {
    const lastCommit = await this.getSubtreePrefixLastCommit(prefix);
    if (lastCommit) {
      const cached = this.subtreeSplitCache.get(prefix);
      if (cached && cached.lastCommit === lastCommit && cached.splitHash) {
        return cached.splitHash;
      }
    }

    // Sequence heavy subtree splits to avoid CPU/IO starvation
    const executeSplit = async (): Promise<string> => {
      const splitOutput = await this.rawPathSafe(['subtree', 'split', this.subtreePrefixArg(prefix)]);
      const splitHash = this.parseSubtreeSplitHash(splitOutput);
      if (!splitHash) {
        throw new Error(t('Cannot determine subtree split commit.'));
      }

      if (lastCommit) {
        this.subtreeSplitCache.set(prefix, { lastCommit, splitHash });
      }
      return splitHash;
    };

    const nextTask = this.subtreeSplitLock.then(executeSplit, executeSplit);
    this.subtreeSplitLock = nextTask.then(() => {}, () => {});
    return nextTask;
  }

  private async getSubtreeRemoteHash(
    repository: string,
    refspec: string,
    options?: { forceRemote?: boolean },
  ): Promise<{ hash?: string; ref?: string; unreachable?: boolean; notFound?: boolean; error?: string }> {
    const candidates = this.subtreeRemoteRefCandidates(refspec);
    if (candidates.length === 0) return { error: 'No ref specified' };

    const cacheKey = `${repository.trim()}\0${refspec.trim()}`;
    const now = Date.now();

    // 1. Check cache unless forced
    if (!options?.forceRemote) {
      const cached = this.subtreeRemoteHashCache.get(cacheKey);
      if (cached) {
        const ttl = cached.result.unreachable
          ? SUBTREE_REMOTE_FAILURE_CACHE_TTL_MS
          : SUBTREE_REMOTE_CACHE_TTL_MS;
        if (now - cached.cachedAt < ttl) {
          return cached.result;
        }
      }
    }

    // 2. In-flight deduplication: reuse running query for the same repository & refspec
    const inFlight = this.subtreeRemoteInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    // 3. Query remote with true process timeout kill
    const task = (async (): Promise<{ hash?: string; ref?: string; unreachable?: boolean; notFound?: boolean; error?: string }> => {
      try {
        const output = await this.execGitLsRemote(['ls-remote', repository, ...candidates], 8000);
        const rows = output.split('\n')
          .map(line => {
            const [hash, ref] = line.trim().split(/\s+/);
            return hash && ref && /^[0-9a-f]{40}$/i.test(hash) ? { hash: hash.toLowerCase(), ref } : undefined;
          })
          .filter((row): row is { hash: string; ref: string } => Boolean(row));
        for (const candidate of candidates) {
          const exact = rows.find(row => row.ref === candidate);
          if (exact) {
            this.subtreeRemoteHashCache.set(cacheKey, { result: exact, cachedAt: Date.now() });
            return exact;
          }
        }
        const notFoundResult = { notFound: true, ref: this.normalizeSubtreeRemoteRef(refspec) };
        this.subtreeRemoteHashCache.set(cacheKey, { result: notFoundResult, cachedAt: Date.now() });
        return notFoundResult;
      } catch (error) {
        this.logger?.warn('Subtree', `Failed or timed out querying remote hash for ${repository}`, { error: String(error) });
        const failureResult = { unreachable: true, error: String(error) };
        this.subtreeRemoteHashCache.set(cacheKey, { result: failureResult, cachedAt: Date.now() });
        return failureResult;
      } finally {
        this.subtreeRemoteInFlight.delete(cacheKey);
      }
    })();

    this.subtreeRemoteInFlight.set(cacheKey, task);
    return task;
  }

  private async getSubtreeLocalTrackingHash(repository: string, refspec: string): Promise<string | undefined> {
    const normalizedRef = this.normalizeSubtreeRemoteRef(refspec);
    if (!normalizedRef) return undefined;

    try {
      const remotes = await this.git.getRemotes(true);
      const cleanRepo = repository.trim().replace(/\.git$/, '').toLowerCase();
      const matchedRemote = remotes.find(r => {
        const fetchUrl = (r.refs.fetch || '').trim().replace(/\.git$/, '').toLowerCase();
        const pushUrl = (r.refs.push || '').trim().replace(/\.git$/, '').toLowerCase();
        return fetchUrl === cleanRepo || pushUrl === cleanRepo || r.name.toLowerCase() === cleanRepo;
      });

      const candidateRefs: string[] = [];
      if (matchedRemote) {
        candidateRefs.push(`refs/remotes/${matchedRemote.name}/${normalizedRef}`);
      }
      for (const remote of remotes) {
        const candidate = `refs/remotes/${remote.name}/${normalizedRef}`;
        if (!candidateRefs.includes(candidate)) candidateRefs.push(candidate);
      }

      for (const refName of candidateRefs) {
        try {
          const hash = (await this.git.raw(['rev-parse', '--verify', refName])).trim().toLowerCase();
          if (hash && /^[0-9a-f]{40}$/.test(hash)) {
            return hash;
          }
        } catch {
          // continue
        }
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private async countSubtreeAheadCommits(remoteHash: string, splitHash: string): Promise<number | undefined> {
    try {
      if (remoteHash === splitHash) return 0;

      const remoteCommitExists = await this.git.raw(['cat-file', '-e', `${remoteHash}^{commit}`])
        .then(() => true)
        .catch(() => false);
      if (!remoteCommitExists) return undefined;

      const isAncestor = await this.git.raw(['merge-base', '--is-ancestor', remoteHash, splitHash])
        .then(() => true)
        .catch(() => false);
      if (isAncestor) {
        const count = Number.parseInt((await this.git.raw(['rev-list', '--count', `${remoteHash}..${splitHash}`])).trim(), 10);
        return Number.isFinite(count) ? count : undefined;
      }

      const isRemoteAhead = await this.git.raw(['merge-base', '--is-ancestor', splitHash, remoteHash])
        .then(() => true)
        .catch(() => false);
      if (isRemoteAhead) {
        return 0;
      }

      const base = (await this.git.raw(['merge-base', remoteHash, splitHash])).trim();
      if (base) {
        const count = Number.parseInt((await this.git.raw(['rev-list', '--count', `${base}..${splitHash}`])).trim(), 10);
        return Number.isFinite(count) ? count : undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async getSubtreePushStatus(
    prefix: string,
    repository: string,
    refspec: string,
    options?: { forceRemote?: boolean },
  ): Promise<SubtreePushStatus> {
    const normalizedRef = this.normalizeSubtreeRemoteRef(refspec);

    // 1. Fetch remote ref query (or cached result)
    const remote = await this.getSubtreeRemoteHash(repository, refspec, options);

    if (remote.unreachable) {
      const localTrackingHash = await this.getSubtreeLocalTrackingHash(repository, refspec);
      if (localTrackingHash) {
        const unavailableError = t('Unable to reach remote repository; status is based on the last fetched remote reference.');

        const splitHash = await this.getSubtreeSplitHashFast(prefix);
        if (localTrackingHash === splitHash) {
          return {
            aheadCount: 0,
            hasUpdates: false,
            remoteRef: normalizedRef,
            splitHash,
            remoteHash: localTrackingHash,
            error: unavailableError,
          };
        }
        const aheadCount = await this.countSubtreeAheadCommits(localTrackingHash, splitHash);
        return {
          aheadCount,
          hasUpdates: aheadCount === undefined || aheadCount > 0,
          remoteRef: normalizedRef,
          splitHash,
          remoteHash: localTrackingHash,
          error: unavailableError,
        };
      }

      return {
        remoteRef: normalizedRef,
        error: t('Unable to reach remote repository.'),
      };
    }

    if (remote.notFound || !remote.hash) {
      const splitHash = await this.getSubtreeSplitHashFast(prefix).catch(() => undefined);
      return {
        aheadCount: undefined,
        hasUpdates: true,
        remoteRef: normalizedRef,
        splitHash,
      };
    }

    // 2. Calculate synthetic split hash and ahead commits
    const splitHash = await this.getSubtreeSplitHashFast(prefix);

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

    const aheadCount = await this.countSubtreeAheadCommits(remote.hash, splitHash);
    return {
      aheadCount,
      hasUpdates: aheadCount === undefined || aheadCount > 0,
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
    return this.withWriteLock(async () => {
      const args = ['subtree', 'split', this.subtreePrefixArg(prefix)];
      if (branch?.trim()) args.push('--branch', branch.trim());
      if (annotate?.trim()) args.push('--annotate', annotate.trim());
      if (onto?.trim()) args.push('--onto', onto.trim());
      if (rejoin) args.push('--rejoin');
      if (commit?.trim()) args.push(commit.trim());
      return this.rawPathSafe(args);
    });
  }

  async mergeSubtree(prefix: string, commit: string, squash: boolean, message?: string): Promise<string> {
    return this.withWriteLock(async () => {
      const args = ['subtree', 'merge', this.subtreePrefixArg(prefix)];
      if (squash) args.push('--squash');
      if (message?.trim()) args.push('-m', message.trim());
      args.push(commit);
      return this.rawPathSafe(args);
    });
  }

  async removeSubtree(prefix: string): Promise<string> {
    return this.withWriteLock(async () => {
      const relPath = this.normalizeRepoPath(prefix);
      return this.rawPathSafe(['rm', '-r', '--', this.literalPathspec(relPath)]);
    });
  }

  async stageFiles(paths: string[]): Promise<void> {
    return this.withWriteLock(async () => {
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
    });
  }

  async getConflictFiles(): Promise<string[]> {
    const output = await this.rawPathSafe(['diff', '--name-only', '--diff-filter=U', '-z']);
    return output.split('\0').filter(Boolean);
  }

  async getConflictFileStatuses(): Promise<Map<string, ConflictFileStatus>> {
    const output = await this.rawPathSafe(['status', '--porcelain', '-z']);
    const statuses = new Map<string, ConflictFileStatus>();
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
    return this.withWriteLock(async () => {
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
    });
  }

  async deleteMergedFile(filePath: string): Promise<void> {
    return this.withWriteLock(async () => {
    const relPath = this.normalizeRepoPath(filePath);
    const absolutePath = path.join(this.rootPath, relPath);
    assertNoSymlinkAncestors(this.rootPath, absolutePath);
    if (fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
    });
  }

  async acceptOurs(filePath: string): Promise<void> {
    return this.withWriteLock(async () => {
      const relPath = this.normalizeRepoPath(filePath);
      await this.acceptConflictSide(relPath, 'ours');
    });
  }

  async acceptTheirs(filePath: string): Promise<void> {
    return this.withWriteLock(async () => {
      const relPath = this.normalizeRepoPath(filePath);
      await this.acceptConflictSide(relPath, 'theirs');
    });
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
    return this.withWriteLock(async () => {
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
    });
  }

  async unstageFiles(paths: string[]): Promise<void> {
    return this.withWriteLock(async () => {
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
    });
  }

  async unstageAll(): Promise<void> {
    return this.withWriteLock(async () => {
    const hasHead = await this.git.raw(['rev-parse', '--verify', 'HEAD']).then(() => true).catch(() => false);
    if (hasHead) {
      await this.git.raw(['reset', 'HEAD']);
      return;
    }
    await this.git.raw(['rm', '-r', '--cached', '--ignore-unmatch', '--', '.']);
    });
  }

  async discardFile(filePath: string): Promise<void> {
    return this.withWriteLock(async () => {
      const relPath = this.normalizeRepoPath(filePath);
      const absPath = path.join(this.rootPath, relPath);
      assertNoSymlinkAncestors(this.rootPath, absPath);

      // Use git status --porcelain to reliably detect untracked (??) vs tracked files,
      // regardless of vsRepo API availability.
      const pathspec = this.literalPathspec(relPath);
      const status = await this.git.raw(['status', '--porcelain', '--', pathspec]);
      const isUntracked = status.trimStart().startsWith('??');

      if (isUntracked) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true });
        } catch {
          fs.rmSync(absPath, { recursive: true, force: true });
        }
        return;
      }

      // Check if the file actually exists in the current HEAD.
      const existsInHead = await this.hasFileAtRef('HEAD', relPath);

      if (!existsInHead) {
        // The file does not exist in HEAD (e.g. newly added & staged, or incoming file during merge conflict).
        // Discarding changes means returning to the HEAD state (where this file does not exist).
        // 1. Remove working tree file if it exists
        try {
          if (fs.existsSync(absPath)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true });
          }
        } catch {
          fs.rmSync(absPath, { recursive: true, force: true });
        }
        // 2. Remove from index / unstage
        await this.git.raw(['rm', '-f', '--cached', '--ignore-unmatch', '--', pathspec]).catch(() => '');
        return;
      }

      // File exists in HEAD: restore both index and working tree to HEAD version.
      try {
        await this.git.raw(['restore', '--source=HEAD', '--staged', '--worktree', '--', pathspec]);
      } catch {
        try {
          await this.git.raw(['restore', '--staged', '--worktree', '--', pathspec]);
        } catch {
          try {
            await this.git.checkout(['HEAD', '--', pathspec]);
          } catch (checkoutError) {
            const errStr = String(checkoutError);
            if (errStr.includes('did not match any file(s) known to git')) {
              // Path is no longer known to git; ensure working tree file is removed if it shouldn't exist
              if (fs.existsSync(absPath)) {
                try {
                  await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true });
                } catch {
                  fs.rmSync(absPath, { recursive: true, force: true });
                }
              }
              return;
            }
            throw checkoutError;
          }
        }
      }
    });
  }

  async commit(
    message: string,
    amend: boolean,
    credentials?: { gitName: string; gitEmail: string },
    log?: (s: string) => void,
    noVerify?: boolean,
  ): Promise<string> {
    const shouldNoVerify = noVerify ?? vscode.workspace.getConfiguration('versiondock').get<boolean>('git.noVerify', false);
    return this.runStatusSensitiveOperation(async () => {
      log?.(`GitService.commit — credentials=${credentials ? 'provided' : 'default'} amend=${amend} noVerify=${shouldNoVerify}`);
      if (credentials?.gitName && credentials?.gitEmail) {
        const flags = [
          '-c', `user.name=${credentials.gitName}`,
          '-c', `user.email=${credentials.gitEmail}`,
          'commit', '-m', message,
          ...(amend ? ['--amend'] : []),
          ...(shouldNoVerify ? ['--no-verify'] : []),
        ];
        log?.('GitService.commit — running git commit with an explicit identity');
        await this.git.raw(flags);
        return '';
      }
      log?.(`GitService.commit — no credentials, using vsRepo/simple-git`);
      const vsRepo = this.vsRepo();
      if (vsRepo) {
        await vsRepo.commit(message, { amend, noVerify: shouldNoVerify });
        return '';
      }
      const commitOptions: TaskOptions = {};
      if (amend) commitOptions['--amend'] = null;
      if (shouldNoVerify) commitOptions['--no-verify'] = null;
      const result = await this.git.commit(message, undefined, commitOptions);
      return result.summary.changes.toString();
    }, 'commit', message);
  }

  private async getAbsoluteGitDir(): Promise<string | undefined> {
    const rawGitDir = await this.git.raw(['rev-parse', '--absolute-git-dir'])
      .catch(() => this.git.raw(['rev-parse', '--git-dir']).catch(() => ''));
    const gitDirValue = rawGitDir.trim();
    if (!gitDirValue) return undefined;
    return path.isAbsolute(gitDirValue) ? gitDirValue : path.resolve(this.rootPath, gitDirValue);
  }

  private async getMergeMessageDetails(): Promise<{ sourceBranch?: string; targetBranch?: string }> {
    const gitDir = await this.getAbsoluteGitDir();
    if (!gitDir) return {};
    try {
      const firstLine = fs.readFileSync(path.join(gitDir, 'MERGE_MSG'), 'utf8')
        .split(/\r?\n/, 1)[0]
        .trim();
      const match = firstLine.match(/^Merge (?:branch|remote-tracking branch|tag) '(.+?)' into '?(.+?)'?$/);
      if (!match) return {};
      return { sourceBranch: match[1], targetBranch: match[2] };
    } catch {
      return {};
    }
  }

  async getOperationState(): Promise<'merge' | 'rebase' | 'cherry-pick' | 'revert' | null> {
    await waitForGitWrite(this.rootPath);
    const gitDir = await this.getAbsoluteGitDir();
    if (!gitDir) return null;
    if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) return 'merge';
    if (fs.existsSync(path.join(gitDir, 'rebase-merge')) || fs.existsSync(path.join(gitDir, 'rebase-apply'))) return 'rebase';
    if (fs.existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
    if (fs.existsSync(path.join(gitDir, 'REVERT_HEAD'))) return 'revert';
    return null;
  }

  async commitMergeIfResolved(): Promise<MergeCommitResult | undefined> {
    return this.withWriteLock(async () => {
    if (this.kind !== 'git' || await this.getOperationState() !== 'merge') return undefined;
    if ((await this.getConflictFiles()).length > 0) return undefined;

    const currentBranch = await this.getCurrentBranch();
    const mergeDetails = await this.getMergeMessageDetails();
    await this.git.raw(['commit', '--no-edit']);
    return {
      sourceBranch: mergeDetails.sourceBranch,
      targetBranch: mergeDetails.targetBranch ?? currentBranch.name,
    };
    });
  }

  async getMergeRebaseState(): Promise<'merge' | 'rebase' | 'cherry-pick' | 'revert' | null> {
    return this.getOperationState();
  }

  async abortMerge(): Promise<void> {
    return this.withWriteLock(async () => {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.mergeAbort(); return; }
    await this.git.raw(['merge', '--abort']);
    });
  }

  async abortRebase(): Promise<void> {
    return this.withWriteLock(async () => {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.rebase('--abort' as string); return; }
    await this.git.raw(['rebase', '--abort']);
    });
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
    return this.withWriteLock(async () => {
      await this.git.addRemote(name, url);
      // Refresh VS Code's remote state without creating an unhandled rejection
      // when the newly-added endpoint is offline or needs authentication.
      void this.vsRepo()?.fetch?.().catch(() => undefined);
    });
  }

  async removeRemote(name: string): Promise<void> {
    return this.withWriteLock(() => this.git.removeRemote(name).then(() => undefined));
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    return this.withWriteLock(() => this.git.remote(['rename', oldName, newName]).then(() => undefined));
  }

  async setRemoteUrl(name: string, url: string): Promise<void> {
    return this.withWriteLock(() => this.git.remote(['set-url', name, url]).then(() => undefined));
  }

  async push(force = false, remote?: string): Promise<void> {
    // Publishing a repository without a remote may open several prompts and
    // perform a network request. Do that before taking the Git write lock so
    // the repository is not blocked while the user is interacting with UI.
    await this.assertBranchOperationAllowed();
    let configuredRemotes = await this.getRemotes().catch(() => [] as string[]);
    if (configuredRemotes.length === 0 && this.publishMissingRemote) {
      await this.publishMissingRemote(this.repoId, this.rootPath);
    }

    return this.withWriteLock(async () => {
      await this.assertBranchOperationAllowed();
      configuredRemotes = await this.getRemotes().catch(() => [] as string[]);
      const vsRepo = this.vsRepo();
      // Only use VS Code API when it actually knows the remotes for this repo.
      // If remotes are empty VS Code would push to an unknown remote (exit 128).
      // Repos where VS Code lists no remotes are typically SSH-keyed or use a
      // system credential helper, so falling back to simple-git is safe there.
      const useSafeForcePush = vscode.workspace
        .getConfiguration('versiondock')
        .get<boolean>('git.useSafeForcePush', true);

      const currentBranch = await this.getCurrentBranch().catch(() => undefined);
      const isGone = Boolean(currentBranch?.isGone);
      const branchName = currentBranch?.name
        ?? vsRepo?.state.HEAD?.name
        ?? (await this.git.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')).trim();

      // Resolve configured tracking remote if any (critical when remote tracking branch is deleted/gone)
      let configuredTrackingRemote: string | undefined;
      if (branchName) {
        try {
          const trackingInfo = (await this.getLocalBranchTrackingInfo()).get(branchName);
          configuredTrackingRemote = trackingInfo?.upstreamRemote;
        } catch { /* ignore */ }
        if (!configuredTrackingRemote) {
          try {
            const rawConfigRemote = (await this.git.raw(['config', `branch.${branchName}.remote`])).trim();
            if (rawConfigRemote) configuredTrackingRemote = rawConfigRemote;
          } catch { /* ignore */ }
        }
      }

      const validConfiguredRemote = configuredTrackingRemote && (configuredRemotes.length === 0 || configuredRemotes.includes(configuredTrackingRemote))
        ? configuredTrackingRemote
        : undefined;

      if (vsRepo && vsRepo.state.remotes.length > 0) {
        const hasUpstream = !isGone && Boolean(vsRepo.state.HEAD?.upstream);
        const targetRemote = remote
          ?? validConfiguredRemote
          ?? vsRepo.state.HEAD?.upstream?.remote
          ?? vsRepo.state.remotes[0]?.name
          ?? 'origin';
        const forceMode = force
          ? (useSafeForcePush ? ForcePushMode.ForceWithLease : ForcePushMode.Force)
          : undefined;
        await vsRepo.push(targetRemote, branchName, !hasUpstream, forceMode);
        return;
      }
      const tracking = await this.git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
      const hasUpstream = !isGone && Boolean(tracking.trim());
      // Match the longest configured prefix because Git permits remote names with
      // slashes (for example, team/upstream/main).
      const remoteNames = configuredRemotes;
      const remoteNamesByLength = [...remoteNames].sort((a, b) => b.length - a.length);
      const trackingName = tracking.trim() || currentBranch?.upstream || '';
      const trackingRemote = remoteNamesByLength.find(name => trackingName.startsWith(`${name}/`)) ?? '';
      const firstRemote = remoteNames[0] ?? 'origin';
      const targetRemote = remote ?? validConfiguredRemote ?? (trackingRemote || firstRemote);
      const args = ['push'];
      if (!hasUpstream) args.push('--set-upstream', targetRemote, branchName);
      else if (remote) args.push(remote, branchName);
      if (force) args.push(useSafeForcePush ? '--force-with-lease' : '--force');
      await this.git.raw(args);
    });
  }

  async pushTags(remote?: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    return this.withWriteLock(async () => {
      const configuredRemotes = await this.getRemotes().catch(() => [] as string[]);
      let targetRemote = remote;
      if (!targetRemote) {
        const branch = await this.getCurrentBranch().catch(() => undefined);
        if (branch) {
          try {
            const trackingInfo = (await this.getLocalBranchTrackingInfo()).get(branch.name);
            if (trackingInfo?.upstreamRemote && (configuredRemotes.length === 0 || configuredRemotes.includes(trackingInfo.upstreamRemote))) {
              targetRemote = trackingInfo.upstreamRemote;
            }
          } catch { /* ignore */ }
        }
        if (!targetRemote && branch?.upstream) {
          const remoteNamesByLength = [...configuredRemotes].sort((a, b) => b.length - a.length);
          targetRemote = remoteNamesByLength.find(name => branch.upstream!.startsWith(`${name}/`));
        }
      }
      if (!targetRemote) {
        targetRemote = configuredRemotes[0] ?? 'origin';
      }
      await this.git.raw(['push', targetRemote, '--tags']);
    });
  }

  async pull(): Promise<string> {
    return this.withWriteLock(() => this.pullWithStrategy('merge'));
  }

  async pullRebase(): Promise<string> {
    return this.withWriteLock(() => this.pullWithStrategy('rebase'));
  }

  async pullWithCustomStrategy(strategy: SyncPullStrategy = 'default'): Promise<string> {
    return this.withWriteLock(() => this.pullWithStrategy(strategy));
  }

  private async pullWithStrategy(strategy: PullStrategy, remote?: string, branch?: string): Promise<string> {
    await this.assertPullAllowed();
    if (!remote || !branch) {
      const tracking = await this.git.raw([
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{u}',
      ]).catch(() => '');
      if (!tracking.trim()) return 'No remote tracking branch — skipped';
    }

    const autoStash = await this.createPullAutoStash();
    let strategyOptions: string[];
    switch (strategy) {
      case 'rebase':
        strategyOptions = ['--rebase'];
        break;
      case 'ff-only':
        strategyOptions = ['--ff-only'];
        break;
      case 'default':
        strategyOptions = [];
        break;
      case 'merge':
      default:
        strategyOptions = ['--no-rebase', '--ff'];
        break;
    }
    let result: Awaited<ReturnType<SimpleGit['pull']>>;
    try {
      result = remote && branch
        ? await this.git.pull(remote, branch, strategyOptions)
        : await this.git.pull(strategyOptions);
    } catch (error: unknown) {
      const pullError = gitErrorDetail(error);

      const status = await this.getStatusFresh().catch(() => undefined);
      if (status && (status.conflictCount > 0 || status.operationState)) {
        await this.openPullConflicts();
        if (autoStash) {
          throw new Error(t(
            'Update stopped with conflicts: {0} Your local tracked changes remain safe in VersionDock auto-stash {1}. Resolve or abort the current operation, then restore the stash from the Stash panel.',
            pullError,
            autoStash.shortHash,
          ));
        }
        throw new Error(pullError);
      }

      if (!autoStash) throw new Error(pullError);

      try {
        await this.restorePullAutoStash(autoStash);
      } catch (restoreError: unknown) {
        throw new Error(t(
          'Update failed: {0} VersionDock also could not restore the local changes: {1}',
          pullError,
          gitErrorDetail(restoreError),
        ));
      }
      throw new Error(pullError);
    }

    if (autoStash) {
      try {
        await this.restorePullAutoStash(autoStash);
      } catch (error: unknown) {
        throw new Error(t(
          'Update completed, but VersionDock could not restore the local changes: {0}',
          gitErrorDetail(error),
        ));
      }
    }

    const summary = `${result.summary.changes} changes, ${result.summary.insertions} insertions, ${result.summary.deletions} deletions`;
    return strategy === 'rebase' ? `pulled (rebase): ${summary}` : summary;
  }

  private async createPullAutoStash(): Promise<PullAutoStash | undefined> {
    const trackedStatus = await this.git.raw([
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
    ]);
    if (!trackedStatus.trim()) return undefined;

    const marker = `versiondock-${process.pid}-${Date.now().toString(36)}`;
    const message = t('VersionDock automatic stash before update ({0})', marker);
    await this.git.raw(['stash', 'push', '-m', message]);

    const entry = (await this.getStashIdentities()).find(candidate => candidate.subject.includes(marker));
    if (entry) {
      return { hash: entry.hash, shortHash: entry.hash.slice(0, 12) };
    }

    // A dirty submodule can appear in porcelain status even though `git stash`
    // has no superproject change to save. In that case leave it untouched and
    // let pull decide whether the working tree is safe to update.
    const remainingStatus = await this.git.raw([
      'status',
      '--porcelain=v1',
      '--untracked-files=no',
    ]);
    if (remainingStatus.trim()) return undefined;

    throw new Error(t(
      'VersionDock stashed the local changes but could not identify the automatic stash. Restore the entry named "{0}" from the Stash panel before retrying.',
      message,
    ));
  }

  private async restorePullAutoStash(autoStash: PullAutoStash): Promise<void> {
    const entry = (await this.getStashIdentities()).find(candidate => candidate.hash === autoStash.hash);
    if (!entry) {
      throw new Error(t(
        'VersionDock auto-stash {0} could not be found. Check the Stash panel before making further changes.',
        autoStash.shortHash,
      ));
    }

    try {
      // `--index` restores both the file contents and the staged/unstaged split.
      // Git keeps the stash automatically if applying it produces conflicts.
      await this.git.raw(['stash', 'pop', '--index', entry.ref]);
    } catch (error: unknown) {
      const status = await this.getStatusFresh().catch(() => undefined);
      if ((status?.conflictCount ?? 0) > 0) {
        this.pendingPullAutoStash = autoStash;
        await this.openPullConflicts();
        throw new Error(t(
          'Restoring VersionDock auto-stash {0} produced conflicts: {1}. The Conflicts panel has been opened, and the stash remains as a backup until resolution is complete.',
          autoStash.shortHash,
          gitErrorDetail(error),
        ));
      }
      throw new Error(t(
        'Could not restore VersionDock auto-stash {0}: {1}. The stash was kept for manual recovery in the Stash panel.',
        autoStash.shortHash,
        gitErrorDetail(error),
      ));
    }
  }

  private async openPullConflicts(): Promise<void> {
    await this.refreshStatusAfterOperation();
  }

  getPendingPullAutoStash(): { hash: string; shortHash: string } | undefined {
    return this.pendingPullAutoStash ? { ...this.pendingPullAutoStash } : undefined;
  }

  clearPendingPullAutoStash(): void {
    this.pendingPullAutoStash = undefined;
  }

  async dropPendingPullAutoStash(): Promise<boolean> {
    return this.withWriteLock(async () => {
      const pending = this.pendingPullAutoStash;
      if (!pending) return false;
      const entry = (await this.getStashIdentities()).find(candidate => candidate.hash === pending.hash);
      if (!entry) {
        this.pendingPullAutoStash = undefined;
        return false;
      }
      await this.git.raw(['stash', 'drop', entry.ref]);
      this.pendingPullAutoStash = undefined;
      return true;
    });
  }

  private async getStashIdentities(): Promise<Array<{ hash: string; ref: string; subject: string }>> {
    const raw = await this.git.raw(['stash', 'list', '--format=%H%x00%gd%x00%gs']);
    return raw.split(/\r?\n/).flatMap(line => {
      if (!line) return [];
      const [hash, ref, subject] = line.split('\0');
      return hash && ref ? [{ hash, ref, subject: subject ?? '' }] : [];
    });
  }

  async fetchAll(): Promise<void> {
    return this.withWriteLock(async () => {
      const fetchTags = vscode.workspace
        .getConfiguration('versiondock')
        .get<'auto' | 'all' | 'none'>('git.fetchTags', 'auto');

      const vsRepo = this.vsRepo();
      if (fetchTags === 'auto' && vsRepo && vsRepo.state.remotes.length > 0) {
        await vsRepo.fetch({ all: true, prune: true });
        return;
      }

      const args = ['--all', '--prune'];
      if (fetchTags === 'all') {
        args.push('--tags');
      } else if (fetchTags === 'none') {
        args.push('--no-tags');
      }
      await this.git.fetch(args);
    });
  }

  async checkout(branchName: string, createNew?: boolean, from?: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
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
    }, 'checkout', branchName);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    return this.withWriteLock(async () => {
    const vsRepo = this.vsRepo();
    if (vsRepo) { await vsRepo.createBranch(branchName, false, from); return; }
    await this.git.branch(from ? [branchName, from] : [branchName]);
    });
  }

  async merge(from: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
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
      } finally {
        if (!this.suppressStatusUpdates) await this.refreshStatusAfterOperation();
      }
    }, 'merge', from);
  }

  private async restoreAutoStash(stashHash: string): Promise<void> {
    await this.git.raw(['stash', 'apply', stashHash]);
    const stashList = await this.git.raw(['stash', 'list', '--format=%gd%x00%H']).catch(() => '');
    const matchingRef = stashList.split('\n').map(line => line.split('\0')).find(([, hash]) => hash === stashHash)?.[0];
    if (matchingRef) await this.git.raw(['stash', 'drop', matchingRef]);
  }

  async rebase(onto: string): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      await this.assertBranchOperationAllowed();
      const vsRepo = this.vsRepo();
      if (vsRepo) { await vsRepo.rebase(onto); return; }
      await this.git.rebase([onto]);
    }, 'rebase', onto);
  }

  async rebaseContinue(): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      const vsRepo = this.vsRepo();
      if (vsRepo) {
        try {
          await vsRepo.rebase('--continue' as string);
          return;
        } catch { /* fallback to simple-git */ }
      }
      await this.git.raw(['rebase', '--continue']);
    }, 'rebase');
  }

  async deleteBranch(branchName: string, force: boolean): Promise<void> {
    return this.withWriteLock(async () => {
      await this.assertBranchOperationAllowed();
      if (isBranchProtected(branchName, undefined, this.repoId)) {
        throw new Error(t("Cannot delete protected branch '{0}'.", branchName));
      }
      const vsRepo = this.vsRepo();
      if (vsRepo) { await vsRepo.deleteBranch(branchName, force); return; }
      await this.git.deleteLocalBranch(branchName, force);
    });
  }

  async checkoutForce(branchName: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
      await this.assertCheckoutAllowed();
      // VS Code API has no force checkout — use simple-git
      await this.git.checkout(['-f', branchName]);
    }, 'checkout', branchName);
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    return this.withWriteLock(async () => {
      // VS Code API has no renameBranch — use simple-git
      await this.git.branch(['-m', oldName, newName]);
    });
  }

  async pullFromRemote(remote: string, branch: string, rebase: boolean): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      await this.pullWithStrategy(rebase ? 'rebase' : 'merge', remote, branch);
    }, rebase ? 'rebase' : 'merge', `${remote}/${branch}`);
  }

  async cherryPick(hash: string): Promise<void> {
    const addSuffix = vscode.workspace.getConfiguration('versiondock').get<boolean>('git.cherryPickAddSuffix', true);
    const args = ['cherry-pick'];
    if (addSuffix) args.push('-x');
    args.push(hash);
    return this.withWriteLock(() => this.git.raw(args).then(() => undefined));
  }

  async cherryPickContinue(): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['cherry-pick', '--continue', '--no-edit']).then(() => undefined));
  }

  async cherryPickSkip(): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['cherry-pick', '--skip']).then(() => undefined));
  }

  async cherryPickAbort(): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['cherry-pick', '--abort']).then(() => undefined));
  }

  async revertCommit(hash: string): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['revert', '--no-edit', hash]).then(() => undefined));
  }

  async checkoutFileFromCommit(hash: string, filePath: string): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['checkout', hash, '--', this.literalPathspec(filePath)]).then(() => undefined));
  }

  async revertFileToParent(hash: string, filePath: string): Promise<void> {
    return this.withWriteLock(async () => {
      const relPath = this.normalizeRepoPath(filePath);
      const absPath = path.join(this.rootPath, relPath);
      assertNoSymlinkAncestors(this.rootPath, absPath);

      // Check if parent commit exists and contains this file.
      const parentRef = `${hash}~1`;
      const existsInParent = await this.hasFileAtRef(parentRef, relPath);
      if (existsInParent) {
        await this.git.raw(['checkout', parentRef, '--', this.literalPathspec(relPath)]);
      } else {
        // File was created in commit `hash`, so reverting to parent means removing it from the working tree.
        try {
          if (fs.existsSync(absPath)) {
            await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: false });
          }
        } catch {
          fs.rmSync(absPath, { recursive: true, force: true });
        }
      }
    });
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
    return this.withWriteLock(() => this.git.raw(['revert', '--continue', '--no-edit']).then(() => undefined));
  }

  async revertAbort(): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['revert', '--abort']).then(() => undefined));
  }

  async resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard'): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['reset', `--${mode}`, hash]).then(() => undefined));
  }

  async createPatch(hash: string): Promise<string> {
    return this.git.raw(['format-patch', '-1', '--stdout', hash]);
  }

  async dropCommit(hash: string): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['rebase', '--onto', `${hash}^`, hash]).then(() => undefined));
  }

  async squashCommits(hashes: string[], message: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
      const normalized = message.trim();
      if (!normalized) {
        throw new Error(t('Commit message cannot be empty'));
      }
      const validation = await this.validateCommitRewriteHashes(hashes, 'squash');
      await this.git.raw(['reset', '--soft', `${validation.oldestHash}^`]);
      await this.git.raw(['commit', '-m', normalized]);
    }, 'squash');
  }

  async cherryPickMulti(hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    const addSuffix = vscode.workspace.getConfiguration('versiondock').get<boolean>('git.cherryPickAddSuffix', true);
    return this.runStatusSensitiveOperation(async () => {
      const args = ['cherry-pick'];
      if (addSuffix) args.push('-x');
      args.push(...hashes);
      try {
        await this.git.raw(args);
      } catch (error: unknown) {
        const detail = gitErrorDetail(error);
        throw new Error(t('Cherry-pick failed: {0}', detail));
      }
    }, 'cherry-pick');
  }

  async revertCommits(hashes: string[]): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      for (let i = 0; i < hashes.length; i++) {
        const hash = hashes[i];
        try {
          await this.git.raw(['revert', '--no-edit', hash]);
        } catch (error: unknown) {
          const remaining = hashes.slice(i + 1);
          const shortHash = hash.slice(0, 7);
          const detail = gitErrorDetail(error);
          if (remaining.length > 0) {
            throw new Error(t(
              'Revert stopped at commit {0} ({1}/{2}): {3}. There are {4} remaining commit(s) not reverted.',
              shortHash,
              i + 1,
              hashes.length,
              detail,
              remaining.length,
            ));
          }
          throw new Error(t('Revert failed at commit {0}: {1}', shortHash, detail));
        }
      }
    }, 'revert');
  }

  async dropCommits(oldestHash: string): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['reset', '--hard', `${oldestHash}^`]).then(() => undefined));
  }

  async undoCommit(): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      const parentCount = await this.git.raw(['rev-list', '--count', 'HEAD']).then(s => parseInt(s.trim(), 10)).catch(() => 0);
      if (parentCount <= 1) {
        // First commit: unstage all files and delete HEAD so the branch goes back to unborn state
        await this.git.raw(['rm', '-r', '--cached', '.']);
        await this.git.raw(['update-ref', '-d', 'HEAD']);
      } else {
        await this.git.raw(['reset', '--soft', 'HEAD~1']);
      }
    }, 'squash');
  }

  async editCommitMessage(message: string): Promise<void> {
    return this.withWriteLock(() => this.git.raw(['commit', '--amend', '-m', message]).then(() => undefined));
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
    return this.withWriteLock(() => this.git.raw(['commit', '--amend', '-m', newMessage]).then(() => undefined));
  }

  async createBranchFromCommit(name: string, hash: string): Promise<void> {
    await this.runStatusSensitiveOperation(() => this.git.raw(['checkout', '-b', name, hash]), 'checkout', name);
  }

  async createTag(name: string, hash: string): Promise<void> {
    return this.withWriteLock(async () => {
    if (!name || name.startsWith('-') || name.includes('\0')) {
      throw new Error(`Invalid Git tag name: ${name}`);
    }
    await this.git.raw(['check-ref-format', `refs/tags/${name}`]);
    await this.git.raw(['tag', name, this.safeRevisionArg(hash)]);
    });
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
    return this.withWriteLock(() => this.git.raw(['tag', '-d', '--', name]).then(() => undefined));
  }

  async pushTag(name: string, remote: string): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['push', remote, `refs/tags/${name}`]).then(() => undefined), 'sync', name);
  }

  async deleteTagRemote(name: string, remote: string): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['push', remote, `--delete`, `refs/tags/${name}`]).then(() => undefined), 'sync', name);
  }

  async checkoutTag(name: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
      await this.assertCheckoutAllowed();
      await this.git.raw(['checkout', '--detach', `refs/tags/${name}`]);
      this._pendingDetachedTag = name;
    }, 'checkout', name);
  }

  async mergeTag(name: string): Promise<void> {
    await this.runStatusSensitiveOperation(async () => {
      try {
        await this.git.raw(['merge', `refs/tags/${name}`]);
      } finally {
        if (!this.suppressStatusUpdates) await this.refreshStatusAfterOperation();
      }
    }, 'merge', name);
  }

  async getBranchesContaining(hash: string): Promise<{ local: string[]; remote: string[]; tags: string[]; isHead?: boolean }> {
    const [localOut, remoteOut, tagOut, headHash] = await Promise.all([
      this.git.raw(['branch', '--contains', hash, '--format=%(refname)']).catch(() => ''),
      this.git.raw(['branch', '-r', '--contains', hash, '--format=%(refname)']).catch(() => ''),
      // --points-at: only tags directly on this commit, not ancestors.
      this.git.raw(['tag', '--points-at', hash]).catch(() => ''),
      this.git.raw(['rev-parse', 'HEAD']).then(r => r.trim()).catch(() => ''),
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
    const isHead = Boolean(headHash && (headHash === hash || headHash.startsWith(hash) || hash.startsWith(headHash)));
    return { local, remote, tags, isHead };
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
      'stash', 'list', '--format=%gd%x1f%H%x1f%ci%x1f%s%x1f%B%x1e',
    ]).catch(() => '');
    if (!raw.trim()) return [];

    const entries: StashEntry[] = [];
    for (const rawRecord of raw.split(recordSeparator)) {
      const record = rawRecord.replace(/^\r?\n/, '');
      if (!record.trim()) continue;
      const parts = record.split(fieldSeparator);
      if (parts.length < 5) continue;
      const ref = parts[0].trim();          // stash@{N}
      const oid = parts[1].trim();          // stable stash commit id
      const date = parts[2].trim();         // ISO date
      const subject = parts[3].trim();      // "On branch: message" or "WIP on branch: message"
      const rawFullMessage = parts.slice(4).join(fieldSeparator).trim();

      const indexMatch = ref.match(/stash@\{(\d+)\}/);
      const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

      // Parse branch from subject like "On main: ..." or "WIP on main: ..."
      const branchMatch = subject.match(/^(?:WIP on|On) ([^:]+):/);
      const branch = branchMatch ? branchMatch[1].trim() : '';
      const message = branchMatch ? subject.slice(branchMatch[0].length).trim() : subject;
      const fullMessage = branchMatch && rawFullMessage.startsWith(branchMatch[0])
        ? rawFullMessage.slice(branchMatch[0].length).trim()
        : rawFullMessage || message;

      const cachedFiles = oid ? this.stashFilesCache.get(oid) : undefined;
      entries.push({
        ref,
        oid: oid || undefined,
        index,
        message,
        fullMessage,
        date,
        branch,
        files: cachedFiles ? [...cachedFiles] : undefined,
      });
    }

    // 与 Shelve 保持一致：确保每个 stash 条目在列表返回时携带完整的 files 数据。
    // 已缓存在内存中的条目直接复用，未缓存的条目并发查询并存入缓存。
    const limit = 8;
    const executing = new Set<Promise<void>>();
    for (const entry of entries) {
      if (entry.files !== undefined) continue;
      const stashId = entry.oid ?? entry.ref;
      const p = (async () => {
        try {
          entry.files = await this.getStashFiles(stashId);
        } catch {
          entry.files = [];
        }
      })();
      executing.add(p);
      const clean = () => executing.delete(p);
      p.then(clean, clean);
      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
    await Promise.all(executing);

    return entries;
  }

  async getStashFiles(stashRef: string): Promise<Array<{ path: string; status: string }>> {
    const cached = this.stashFilesCache.get(stashRef);
    if (cached) return [...cached];

    const files: Array<{ path: string; status: string }> = [];
    try {
      const fileRaw = await this.rawPathSafe(['stash', 'show', '--name-status', '-z', stashRef]);
      for (const file of parseNameStatusZOutput(fileRaw)) {
        files.push({ path: file.path, status: file.status });
      }
    } catch { /* stash might have no files */ }

    // Also include untracked files saved in stash^3 (created by `git stash -u`)
    try {
      const untrackedRaw = await this.rawPathSafe(['ls-tree', '-r', '--name-only', '-z', `${stashRef}^3`]);
      const trackedPaths = new Set(files.map(f => f.path));
      for (const filePath of untrackedRaw.split('\0')) {
        if (filePath && !trackedPaths.has(filePath)) {
          files.push({ path: filePath, status: 'untracked' });
        }
      }
    } catch { /* stash^3 may not exist for tracked-only stashes */ }

    if (/^[0-9a-f]{40,64}$/i.test(stashRef)) {
      this.stashFilesCache.set(stashRef, files);
    }
    return files;
  }

  async stashShow(stashRef: string, filePath: string): Promise<string> {
    return this.rawPathSafe(['stash', 'show', '-p', stashRef, '--', this.literalPathspec(filePath)]).catch(() => '');
  }

  async stashPush(message: string, paths?: string[]): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
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
    }, 'stash', message);
  }

  async stashApply(stashRef: string): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['stash', 'apply', stashRef]).then(() => undefined), 'stash', stashRef);
  }

  async stashPop(stashRef = 'stash@{0}'): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['stash', 'pop', stashRef]).then(() => undefined), 'stash', stashRef);
  }

  async stashDrop(stashRef: string): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['stash', 'drop', stashRef]).then(() => undefined), 'stash', stashRef);
  }

  async getStashFileContent(stashRef: string, filePath: string): Promise<string> {
    const relPath = this.normalizeRepoPath(filePath);
    const content = await this.readGitFileContent(stashRef, relPath);
    if (content) return content;
    return await this.readGitFileContent(`${stashRef}^3`, relPath);
  }

  async getStashParentFileContent(stashRef: string, filePath: string): Promise<string> {
    const relPath = this.normalizeRepoPath(filePath);
    return await this.readGitFileContent(`${stashRef}^1`, relPath);
  }

  // ── Unpushed commits ──────────────────────────────────────────────────────

  // ── Submodule push/pull helpers ───────────────────────────────────────────

  async pushSubmodule(): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      const status = await this.git.status();
      if (status.detached) {
        throw new Error(t('Submodule is in detached HEAD — checkout a branch before pushing.'));
      }
      await this.push();
    }, 'sync', 'push submodule');
  }

  async pullSubmodule(rebase = false): Promise<string> {
    return this.runStatusSensitiveOperation(async () => {
      await this.assertPullAllowed();
      const status = await this.git.status();
      if (status.detached) {
        // In detached HEAD: fetch then checkout the latest commit on the tracked ref.
        await this.git.fetch();
        return t('fetched (detached HEAD — use Update Submodule to advance to a new commit)');
      }
      return rebase ? this.pullRebase() : this.pull();
    }, 'sync', 'pull submodule');
  }

  // ── Submodule operations ──────────────────────────────────────────────────

  /** Returns the set of relative paths that are gitlink entries (submodule pointers) in this repo. */
  private async getSubmoduleRelativePaths(): Promise<Set<string>> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
    return new Set(entries.map(e => e.path));
  }

  async getSubmoduleList(): Promise<SubmoduleEntry[]> {
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    const hasGitmodules = fs.existsSync(gitmodulesPath);

    // 性能优化快速路径：若无 .gitmodules，先只检查是否有未合并的 160000 冲突项
    // 避免在无 submodule 的大型 Monorepo 每次全量遍历 HEAD tree 和 stage
    if (!hasGitmodules) {
      const hasConflict = await this.hasUnmergedGitlinks();
      if (!hasConflict) {
        return [];
      }
    }

    const parsedEntries = hasGitmodules ? await parseGitmodulesFile(this.git, gitmodulesPath) : [];
    const moduleMap = new Map<string, { name: string; path: string; url: string; branch?: string }>();
    for (const item of parsedEntries) {
      moduleMap.set(item.name, {
        name: item.name,
        path: item.path,
        url: item.url || '',
        branch: item.branch,
      });
    }

    // 收集所有已知的 submodule 相对路径
    const knownPaths = parsedEntries.map(e => this.normalizeRepoPath(e.path));

    // 始终合并暂存区未合并条目，提取 160000 gitlink 路径，并全局保留所有未合并条目用于伴生路径与类型变更检测
    const unmergedLs = await this.git.raw(['ls-files', '-u', '-z']).catch(() => '');
    const allUnmergedEntries: { mode: string; stage: string; path: string }[] = [];
    for (const line of unmergedLs.split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const meta = line.slice(0, tab).trim();
      const filePath = line.slice(tab + 1);
      const parts = meta.split(/\s+/);
      if (parts.length >= 3 && filePath) {
        allUnmergedEntries.push({ mode: parts[0], stage: parts[2], path: filePath });
        if (parts[0] === '160000') {
          knownPaths.push(this.normalizeRepoPath(filePath));
        }
      }
    }

    const uniqueKnownPaths = Array.from(new Set(knownPaths));
    if (uniqueKnownPaths.length === 0) {
      return [];
    }

    // 针对已知子模块路径使用精准 pathspec 查询，免去全库全量遍历 HEAD tree 和 index
    const pathspecs = uniqueKnownPaths.map(p => this.literalPathspec(p));

    const [lsTreeRaw, lsStageRaw, statusRaw] = await Promise.all([
      this.git.raw(['ls-tree', '-r', '-z', 'HEAD', '--', ...pathspecs]).catch(() => ''),
      this.git.raw(['ls-files', '-z', '--stage', '--', ...pathspecs]).catch(() => ''),
      this.git.raw(['submodule', 'status', '--', ...pathspecs]).catch(() => ''),
    ]);

    const parentHeadCommitMap = new Map<string, string>();
    for (const entry of lsTreeRaw.split('\0')) {
      if (!entry.startsWith('160000 commit ')) continue;
      const tabIdx = entry.indexOf('\t');
      if (tabIdx === -1) continue;
      const metaPart = entry.slice(0, tabIdx).trim();
      const subPath = entry.slice(tabIdx + 1);
      const parts = metaPart.split(/\s+/);
      if (parts.length >= 3 && subPath) {
        parentHeadCommitMap.set(subPath, parts[2].slice(0, 8));
      }
    }

    // Format: <mode> <hash> <stage>\t<path>\0
    // Stage: 0 = normal, 1 = base, 2 = ours, 3 = theirs
    const recordedCommitMap = new Map<string, string>();
    const conflictStagesMap = new Map<string, { base?: string; ours?: string; theirs?: string }>();

    for (const entry of lsStageRaw.split('\0')) {
      if (!entry) continue;
      const tabIdx = entry.indexOf('\t');
      if (tabIdx === -1) continue;
      const metaPart = entry.slice(0, tabIdx).trim();
      const finalPath = entry.slice(tabIdx + 1);
      const parts = metaPart.split(/\s+/);
      if (parts.length >= 3 && finalPath) {
        const mode = parts[0];
        const hash = parts[1].slice(0, 8);
        const stage = parts[2];

        if (mode === '160000') {
          if (stage === '0') {
            recordedCommitMap.set(finalPath, hash);
          } else {
            let conf = conflictStagesMap.get(finalPath);
            if (!conf) {
              conf = {};
              conflictStagesMap.set(finalPath, conf);
            }
            if (stage === '1') conf.base = hash;
            else if (stage === '2') conf.ours = hash;
            else if (stage === '3') conf.theirs = hash;
          }
        }
      }
    }

    // Leading char: ' ' = initialized clean, '-' = not initialized, '+' = different commit, 'U' = conflict
    const statusMap = new Map<string, { flag: string; initialized: boolean; headCommit: string; isDirty: boolean }>();
    for (const line of statusRaw.split(/\r?\n/)) {
      if (!line || !line.trim()) continue;
      const parsed = parseSubmoduleStatusLine(line);
      const hash = line.match(/^([ +\-U]?)([0-9a-f]{40,64})/i)?.[2];
      if (!parsed || !hash) continue;
      statusMap.set(parsed.path, {
        flag: parsed.flag,
        initialized: parsed.flag !== '-',
        headCommit: hash.slice(0, 8),
        isDirty: parsed.flag === '+',
      });
    }

    const handledPaths = new Set<string>();
    const entries: SubmoduleEntry[] = [];
    for (const mod of moduleMap.values()) {
      if (!mod.path) continue;
      const normModPath = this.normalizeRepoPath(mod.path);
      handledPaths.add(normModPath);

      const subFullPath = path.join(this.rootPath, mod.path);
      const st = statusMap.get(mod.path);
      const indexRecorded = recordedCommitMap.get(mod.path);
      const parentHeadRecorded = parentHeadCommitMap.get(mod.path);
      const recorded = parentHeadRecorded ?? indexRecorded;
      const hasGit = fs.existsSync(path.join(subFullPath, '.git'));
      const initialized = st ? st.initialized : hasGit;
      const headCommit = st?.headCommit;
      const conflictStages = conflictStagesMap.get(mod.path);

      // 检查是否存在伴生路径冲突（如 dep~theirs）或同名类型变更冲突（普通文件/软链接）
      let isTypeChange = false;
      let companionPath: string | undefined;
      const prefix = normModPath + '~';
      for (const ue of allUnmergedEntries) {
        const normUe = this.normalizeRepoPath(ue.path);
        if (normUe === normModPath && ue.mode !== '160000') {
          isTypeChange = true;
          companionPath = ue.path;
          break;
        }
        if (normUe.startsWith(prefix)) {
          isTypeChange = true;
          companionPath = ue.path;
          break;
        }
      }

      let syncStatus: import('../types/git').SubmoduleSyncStatus = 'synced';
      if (conflictStages || st?.flag === 'U' || isTypeChange) {
        syncStatus = 'conflict';
      } else if (!initialized) {
        syncStatus = 'uninitialized';
      } else if (st?.flag === '+' || (recorded && headCommit && !headCommit.startsWith(recorded) && !recorded.startsWith(headCommit))) {
        syncStatus = 'out-of-sync';
      }

      entries.push({
        name: mod.name,
        path: mod.path,
        url: mod.url,
        branch: mod.branch,
        repoId: subFullPath,
        initialized,
        headCommit,
        recordedCommit: recorded,
        indexCommit: indexRecorded,
        syncStatus,
        conflictStages,
        isDirty: st?.isDirty ?? false,
        isTypeChange,
        companionPath,
      });
    }

    // 补充在 .gitmodules 中已不存在但暂存区存在未解决冲突的 gitlink 条目 (例如一方删除了 submodule)
    for (const [conflictPath, conf] of conflictStagesMap.entries()) {
      const normConflictPath = this.normalizeRepoPath(conflictPath);
      if (handledPaths.has(normConflictPath)) continue;
      handledPaths.add(normConflictPath);

      const subFullPath = path.join(this.rootPath, conflictPath);
      const st = statusMap.get(conflictPath);
      const parentHeadRecorded = parentHeadCommitMap.get(conflictPath);
      const hasGit = fs.existsSync(path.join(subFullPath, '.git'));
      const headCommit = st?.headCommit;

      let isTypeChange = false;
      let companionPath: string | undefined;
      const prefix = normConflictPath + '~';
      for (const ue of allUnmergedEntries) {
        const normUe = this.normalizeRepoPath(ue.path);
        if (normUe === normConflictPath && ue.mode !== '160000') {
          isTypeChange = true;
          companionPath = ue.path;
          break;
        }
        if (normUe.startsWith(prefix)) {
          isTypeChange = true;
          companionPath = ue.path;
          break;
        }
      }

      entries.push({
        name: path.basename(conflictPath),
        path: conflictPath,
        url: '',
        repoId: subFullPath,
        initialized: st ? st.initialized : hasGit,
        headCommit,
        recordedCommit: parentHeadRecorded ?? conf.ours ?? conf.theirs ?? conf.base,
        syncStatus: 'conflict',
        conflictStages: conf,
        isDirty: st?.isDirty ?? false,
        isTypeChange,
        companionPath,
      });
    }

    return entries;
  }

  private submoduleGit: SimpleGit | null = null;
  private getSubmoduleGit(): SimpleGit {
    if (!this.submoduleGit) {
      this.submoduleGit = createGitClient(this.rootPath, { allowUnsafeProtocolOverride: true });
    }
    return this.submoduleGit;
  }

  async addSubmodule(url: string, submodulePath: string, branch?: string, allowFileProtocol = false): Promise<void> {
    return withGitWriteLock(this.rootPath, async () => {
      const args = ['submodule', 'add'];
      if (allowFileProtocol) {
        args.unshift('-c', 'protocol.file.allow=always');
      }
      if (branch && branch.trim()) {
        args.push('-b', branch.trim());
      }
      args.push('--', url.trim(), this.normalizeRepoPath(submodulePath));
      await this.getSubmoduleGit().raw(args);
    });
  }

  async syncSubmodule(submodulePath?: string): Promise<void> {
    return withGitWriteLock(this.rootPath, async () => {
      const args = ['submodule', 'sync'];
      if (submodulePath) {
        args.push('--', this.literalPathspec(submodulePath));
      }
      await this.getSubmoduleGit().raw(args);
    });
  }

  private async getModulesBase(): Promise<string> {
    try {
      const raw = await this.git.raw(['rev-parse', '--git-path', 'modules']).catch(() => '');
      const trimmed = raw.trim();
      if (trimmed) {
        return path.isAbsolute(trimmed) ? trimmed : path.resolve(this.rootPath, trimmed);
      }
    } catch {
      // fallback below
    }
    const dotGit = path.join(this.rootPath, '.git');
    if (fs.existsSync(dotGit)) {
      try {
        const stat = fs.statSync(dotGit);
        if (stat.isFile()) {
          const content = fs.readFileSync(dotGit, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match) {
            const actualGitDir = path.resolve(this.rootPath, match[1].trim());
            return path.join(actualGitDir, 'modules');
          }
        }
      } catch {
        // ignore
      }
    }
    return path.resolve(this.rootPath, '.git', 'modules');
  }

  async removeSubmodule(submodulePath: string): Promise<void> {
    const normPath = this.normalizeRepoPath(submodulePath);
    const subAbsPath = path.join(this.rootPath, normPath);

    // 1. 从子模块内部 .git 解析真实 gitdir (若存在)
    let actualGitDir: string | undefined;
    const dotGitFile = path.join(subAbsPath, '.git');
    if (fs.existsSync(dotGitFile)) {
      try {
        const stat = fs.statSync(dotGitFile);
        if (stat.isFile()) {
          const content = fs.readFileSync(dotGitFile, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match) {
            actualGitDir = path.resolve(subAbsPath, match[1].trim());
          }
        }
      } catch {
        // ignore read error
      }
    }

    // 2. 从 .gitmodules 获取该 path 对应的自定义 submodule name
    let submoduleName = normPath;
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (fs.existsSync(gitmodulesPath)) {
      try {
        const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
        const match = entries.find(e => this.normalizeRepoPath(e.path) === normPath);
        if (match?.name) {
          submoduleName = match.name;
        }
      } catch {
        // ignore .gitmodules parse error
      }
    }

    const modulesBase = await this.getModulesBase();

    return withGitWriteLocks([this.rootPath, subAbsPath], async () => {
      // 1. git submodule deinit -f -- <path>
      await this.git.raw(['submodule', 'deinit', '-f', '--', this.literalPathspec(submodulePath)]).catch(() => {});
      // 2. git rm -f -- <path>
      await this.git.raw(['rm', '-f', '--', this.literalPathspec(submodulePath)]);
      // 3. remove .git/modules/<name or path> safely
      const candidatesToClean = new Set<string>();
      const isSubmoduleMetaDir = (dir: string) => isSameOrChildPath(modulesBase, dir) && path.relative(modulesBase, dir) !== '';

      if (actualGitDir && isSubmoduleMetaDir(actualGitDir)) {
        candidatesToClean.add(actualGitDir);
      }
      const namedDir = path.join(modulesBase, submoduleName);
      if (isSubmoduleMetaDir(namedDir)) {
        candidatesToClean.add(namedDir);
      }
      const pathDir = path.join(modulesBase, normPath);
      if (isSubmoduleMetaDir(pathDir)) {
        candidatesToClean.add(pathDir);
      }

      for (const dir of candidatesToClean) {
        if (fs.existsSync(dir)) {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch (e: unknown) {
            this.logger?.warn('Git', `Failed to delete submodule metadata directory: ${dir}`, { error: String(e) });
          }
        }
      }
    });
  }

  async getDefaultRemoteUrl(): Promise<string | undefined> {
    const remotes = await this.getRemotesWithUrls().catch(() => []);
    const origin = remotes.find(r => r.name === 'origin') ?? remotes[0];
    return origin?.fetchUrl || undefined;
  }

  collectSubmodulePathsRecursive(
    basePath: string,
    visited = new Set<string>(),
    depth = 0
  ): string[] {
    const MAX_SUBMODULE_DEPTH = 10;
    if (depth >= MAX_SUBMODULE_DEPTH) return [];

    let realRoot = this.rootPath;
    try {
      realRoot = fs.realpathSync(this.rootPath);
    } catch {
      // ignore
    }

    if (depth === 0) {
      try {
        visited.add(fs.realpathSync(basePath));
      } catch {
        visited.add(basePath);
      }
    }

    const gitmodulesPath = path.join(basePath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return [];
    const results: string[] = [];
    try {
      const entries = parseGitmodulesFileSync(gitmodulesPath);
      for (const entry of entries) {
        const subRelPath = entry.path?.trim();
        if (!subRelPath || subRelPath === '.') continue;

        const subAbsPath = path.resolve(basePath, subRelPath);
        const relToBase = path.relative(basePath, subAbsPath);
        // 仅当相对路径真正跳出 basePath 时才跳过（避免误杀 ..vendor 等以 .. 开头的合法命名）
        if (relToBase === '' || relToBase === '.' || relToBase.startsWith('..' + path.sep) || relToBase === '..') {
          continue;
        }

        if (subAbsPath === basePath || subAbsPath === this.rootPath) continue;
        if (!isSameOrChildPath(this.rootPath, subAbsPath)) continue;

        let realTarget: string;
        try {
          if (!fs.existsSync(subAbsPath) || !fs.statSync(subAbsPath).isDirectory()) continue;
          realTarget = fs.realpathSync(subAbsPath);
        } catch {
          continue;
        }

        // 核心防御：realTarget 必须同样限制在 realRoot 之内，严防指向根外的符号链接逃逸！
        if (!isSameOrChildPath(realRoot, realTarget)) continue;

        if (visited.has(realTarget)) continue;
        visited.add(realTarget);

        results.push(subAbsPath);
        results.push(...this.collectSubmodulePathsRecursive(subAbsPath, visited, depth + 1));
      }
    } catch {
      // ignore
    }
    return results;
  }

  async getSubmoduleConfigUrl(submodulePath: string): Promise<string | undefined> {
    const normPath = this.normalizeRepoPath(submodulePath);
    // 1. 优先读取 .git/config 中可能已配置或覆盖的 URL
    try {
      const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
      let subName = normPath;
      if (fs.existsSync(gitmodulesPath)) {
        const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
        const match = entries.find(e => this.normalizeRepoPath(e.path) === normPath);
        if (match?.name) subName = match.name;
      }
      const directConfigUrl = await this.git.raw(['config', '-z', '--get', `submodule.${subName}.url`]).catch(() => '');
      const trimmedDirect = directConfigUrl.split('\0')[0]?.trim();
      if (trimmedDirect) return trimmedDirect;
    } catch {
      // ignore config lookup error
    }

    // 2. 回退到 .gitmodules 中读取
    const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return undefined;
    try {
      const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
      const match = entries.find(e => this.normalizeRepoPath(e.path) === normPath);
      return match?.url;
    } catch {
      return undefined;
    }
  }

  async hasUnmergedGitlinks(): Promise<boolean> {
    try {
      const raw = await this.git.raw(['ls-files', '-u', '-z']).catch(() => '');
      return raw.split('\0').some(entry => entry.startsWith('160000 '));
    } catch {
      return false;
    }
  }

  /**
   * 检查子模块路径是否存在伴生冲突路径（如 dep~theirs, dep~HEAD）或同名路径自身模式非 160000 的 type-change 冲突。
   * 若存在，返回伴生路径或冲突路径；若不存在返回 null。
   */
  async checkSubmoduleTypeChangeOrCompanionConflict(submodulePath: string): Promise<string | null> {
    const normPath = this.normalizeRepoPath(submodulePath);
    const prefix = normPath + '~';
    const rawLs = await this.git.raw(['ls-files', '-u', '-z']).catch(() => '');
    for (const entry of rawLs.split('\0')) {
      if (!entry) continue;
      const tabIdx = entry.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = entry.slice(0, tabIdx).trim();
      const filePath = this.normalizeRepoPath(entry.slice(tabIdx + 1));
      const parts = meta.split(/\s+/);
      const mode = parts[0];

      // 1. 同名路径存在非 160000 模式（例如已被替换为普通文件 100644 或软链接 120000）
      if (filePath === normPath && mode !== '160000') {
        return filePath;
      }
      // 2. 存在伴生冲突路径（如 Git 自动将冲突文件放置在 dep~theirs 等伴生路径）
      if (filePath.startsWith(prefix)) {
        return filePath;
      }
    }
    return null;
  }

  /**
   * 检查子模块工作区或元数据仓库是否存在未提交的修改、未跟踪文件或未推送到任何远程的提交。
   * 覆盖当前 HEAD、所有本地分支、tag、stash 以及无工作区仅留存 .git/modules 时的元数据安全性。
   */
  async isSubmoduleDirty(submodulePath: string): Promise<boolean> {
    const normPath = this.normalizeRepoPath(submodulePath);
    const subAbsPath = path.join(this.rootPath, normPath);

    // 1. 尝试解析子模块的真实 gitdir (元数据目录) 与工作区目录
    let actualGitDir: string | undefined;
    const workTreeExists = fs.existsSync(subAbsPath);
    const dotGit = path.join(subAbsPath, '.git');

    if (workTreeExists && fs.existsSync(dotGit)) {
      try {
        const stat = fs.statSync(dotGit);
        if (stat.isFile()) {
          const content = fs.readFileSync(dotGit, 'utf8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/i);
          if (match) {
            actualGitDir = path.resolve(subAbsPath, match[1].trim());
          }
        } else if (stat.isDirectory()) {
          actualGitDir = dotGit;
        }
      } catch {
        // ignore read error
      }
    }

    // 若工作区缺失或无 .git，尝试从 .gitmodules 与父仓库 .git/config 探查 .git/modules 中的元数据仓库
    if (!actualGitDir) {
      let submoduleName = normPath;
      const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
      if (fs.existsSync(gitmodulesPath)) {
        try {
          const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
          const match = entries.find(e => this.normalizeRepoPath(e.path) === normPath);
          if (match?.name) submoduleName = match.name;
        } catch {
          // ignore
        }
      }
      if (submoduleName === normPath) {
        const configPathMappings = await this.git.raw(['config', '-z', '--get-regexp', '^submodule\\..*\\.path$']).catch(() => '');
        for (const entry of configPathMappings.split('\0')) {
          if (!entry) continue;
          const newlineIdx = entry.indexOf('\n');
          if (newlineIdx === -1) continue;
          const key = entry.slice(0, newlineIdx);
          const val = entry.slice(newlineIdx + 1);
          if (this.normalizeRepoPath(val) === normPath) {
            const nameMatch = key.match(/^submodule\.(.+)\.path$/);
            if (nameMatch) {
              submoduleName = nameMatch[1];
              break;
            }
          }
        }
      }

      const modulesBase = await this.getModulesBase();
      const candidateMetaDirs = [
        path.join(modulesBase, submoduleName),
        path.join(modulesBase, normPath),
      ];
      for (const dir of candidateMetaDirs) {
        if (fs.existsSync(dir) && isSameOrChildPath(modulesBase, dir)) {
          actualGitDir = dir;
          break;
        }
      }
    }

    // 2. 如果工作区存在但不是有效 git 仓库（且没有找到 gitdir），检查工作区是否有任何普通文件
    if (workTreeExists && !actualGitDir) {
      try {
        const files = fs.readdirSync(subAbsPath).filter(f => f !== '.DS_Store');
        return files.length > 0;
      } catch {
        return false;
      }
    }

    // 如果工作区不存在且没有任何元数据目录，安全返回 false
    if (!workTreeExists && !actualGitDir) {
      return false;
    }

    // 3. 执行深度 Git 脏污与未推送提交检查
    try {
      // 3.1 若工作区存在且包含有效 git 客户端，检查 working tree 与 index 状态
      if (workTreeExists && fs.existsSync(dotGit)) {
        const subGit = createGitClient(subAbsPath);
        const status = await subGit.status();
        if (status.files.length > 0) {
          return true;
        }
        if ((status.ahead ?? 0) > 0) {
          return true;
        }
      } else if (workTreeExists) {
        // 工作区存在但没有 .git（可能被 deinit），检查是否有遗留未跟踪文件
        try {
          const files = fs.readdirSync(subAbsPath).filter(f => f !== '.DS_Store');
          if (files.length > 0) return true;
        } catch {
          // 忽略目录无法访问的异常
        }
      }

      // 3.2 检查真实 gitdir 中的 refs、branches、tags、stash
      if (actualGitDir && fs.existsSync(actualGitDir)) {
        const effectiveWorkTree = (workTreeExists && fs.existsSync(dotGit)) ? subAbsPath : actualGitDir;
        const metaArgs = ['--git-dir=' + actualGitDir, '--work-tree=' + effectiveWorkTree];

        // A. 检查 stash
        const hasStash = await this.git.raw([...metaArgs, 'rev-parse', '--verify', 'refs/stash']).then(() => true).catch(() => false);
        if (hasStash) {
          return true;
        }

        // B. 检查是否存在远程仓库
        const remotesRaw = await this.git.raw([...metaArgs, 'remote']).catch(() => '');
        const hasRemotes = remotesRaw.trim().length > 0;
        if (hasRemotes) {
          // 全面检查：当前 HEAD、所有本地分支、所有本地 tag 是否包含未推送到远程的提交
          const unpushed = await this.git.raw([...metaArgs, 'log', 'HEAD', '--branches', '--tags', '--not', '--remotes', '-n', '1', '--']).catch(() => '');
          if (unpushed.trim().length > 0) {
            return true;
          }
        } else {
          // 无远程仓库时，检查 HEAD 是否偏离父仓库记录的指针
          const parentSha = await this.git.raw(['rev-parse', `:${normPath}`]).then(s => s.trim()).catch(() => '');
          const headSha = await this.git.raw([...metaArgs, 'rev-parse', 'HEAD']).then(s => s.trim()).catch(() => '');
          if (parentSha && headSha && parentSha !== headSha) {
            return true;
          }
          // 检查是否有除当前分支以外的其他本地分支
          const branches = await this.git.raw([...metaArgs, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']).then(s => s.trim().split(/\r?\n/).filter(Boolean)).catch(() => []);
          if (branches.length > 1) {
            return true;
          }
        }
      }

      return false;
    } catch {
      // 发生异常时保守返回 true，避免强行删除无法确认状态的目录或元数据
      return true;
    }
  }

  async isSubmoduleConflictDeleteSide(submodulePath: string, side: 'ours' | 'theirs'): Promise<boolean> {
    // 若存在伴生路径或类型变更冲突，绝不能当成常规删除侧！
    const companion = await this.checkSubmoduleTypeChangeOrCompanionConflict(submodulePath);
    if (companion) {
      return false;
    }

    const targetStage = side === 'ours' ? '2' : '3';
    const rawLs = await this.git.raw(['ls-files', '-u', '-z', '--', this.literalPathspec(submodulePath)]).catch(() => '');
    let hasTargetStage = false;
    let hasAnyStage = false;
    for (const entry of rawLs.split('\0')) {
      if (!entry) continue;
      const tabIdx = entry.indexOf('\t');
      if (tabIdx === -1) continue;
      const meta = entry.slice(0, tabIdx).trim();
      const parts = meta.split(/\s+/);
      if (parts.length >= 3) {
        hasAnyStage = true;
        if (parts[2] === targetStage) {
          hasTargetStage = true;
          break;
        }
      }
    }
    return hasAnyStage && !hasTargetStage;
  }

  async resolveSubmoduleConflict(
    submodulePath: string,
    side: 'ours' | 'theirs',
    options?: { removeDirectory?: boolean; force?: boolean }
  ): Promise<{ conflictResolved: boolean; cleanupWarning?: string }> {
    const normPath = this.normalizeRepoPath(submodulePath);
    const subAbsPath = path.join(this.rootPath, normPath);
    return withGitWriteLocks([this.rootPath, subAbsPath], async () => {
      // 1. 前置伴生路径与类型变更冲突检查：若存在 companion 路径（如 dep~theirs），明确拦截为复杂冲突
      const companion = await this.checkSubmoduleTypeChangeOrCompanionConflict(submodulePath);
      if (companion) {
        throw new Error(
          t('This is a directory-file or type-change conflict with companion path "{0}". Please resolve it via the Merge Conflicts editor.', companion)
        );
      }

      // 2. 从 git ls-files -u -z 读取该路径下所有 unmerged stages
      const targetStage = side === 'ours' ? '2' : '3';
      const rawLs = await this.git.raw(['ls-files', '-u', '-z', '--', this.literalPathspec(submodulePath)]);
      const stages: Record<string, { mode: string; sha: string }> = {};
      for (const entry of rawLs.split('\0')) {
        if (!entry) continue;
        // 格式: <mode> <sha> <stage>\t<path>
        const tabIdx = entry.indexOf('\t');
        if (tabIdx === -1) continue;
        const meta = entry.slice(0, tabIdx).trim();
        const parts = meta.split(/\s+/);
        if (parts.length >= 3) {
          stages[parts[2]] = { mode: parts[0], sha: parts[1] };
        }
      }

      // 如果当前没有任何未合并 stage，说明该冲突已经在外部被解决或撤销，严禁 force-remove 误删正常指针
      if (Object.keys(stages).length === 0) {
        throw new Error(t('Submodule "{0}" is no longer in a conflicted state. Please refresh the panel.', submodulePath));
      }

      // 再次校验同路径非 160000 模式
      const isTypeChange = Object.values(stages).some(s => s.mode !== '160000');
      if (isTypeChange) {
        throw new Error(
          t('This is a type-change conflict (submodule replaced by a regular file or link). Please resolve it via the Merge Conflicts editor.')
        );
      }

      const targetEntry = stages[targetStage];
      if (targetEntry) {
        // 写入选定指针，彻底解决 conflict
        await this.git.raw(['update-index', '--cacheinfo', '160000', targetEntry.sha, normPath]);
        return { conflictResolved: true };
      } else {
        // 确实处于未合并冲突状态中，但选定侧不存在对应 stage（说明该侧删除了子模块），表示用户选择删除该 gitlink

        // 关键安全修复：在执行任何物理删除之前，提前预解析并保存真实 actualGitDir、submoduleName 和待清理候选列表
        let actualGitDir: string | undefined;
        let submoduleName = normPath;
        const candidatesToClean = new Set<string>();

        if (options?.removeDirectory) {
          // 1. 从当前存在的工作区 .git 解析真实 actualGitDir
          const dotGitFile = path.join(subAbsPath, '.git');
          if (fs.existsSync(dotGitFile)) {
            try {
              const stat = fs.statSync(dotGitFile);
              if (stat.isFile()) {
                const content = fs.readFileSync(dotGitFile, 'utf8').trim();
                const match = content.match(/^gitdir:\s*(.+)$/i);
                if (match) {
                  actualGitDir = path.resolve(subAbsPath, match[1].trim());
                }
              } else if (stat.isDirectory()) {
                actualGitDir = dotGitFile;
              }
            } catch {
              // ignore read error
            }
          }

          // 2. 从 .gitmodules 或本地 git config 解析精确 submoduleName
          const gitmodulesPath = path.join(this.rootPath, '.gitmodules');
          if (fs.existsSync(gitmodulesPath)) {
            try {
              const entries = await parseGitmodulesFile(this.git, gitmodulesPath);
              const match = entries.find(e => this.normalizeRepoPath(e.path) === normPath);
              if (match?.name) {
                submoduleName = match.name;
              }
            } catch {
              // ignore .gitmodules parse error
            }
          }
          if (submoduleName === normPath) {
            const configPathMappings = await this.git.raw(['config', '-z', '--get-regexp', '^submodule\\..*\\.path$']).catch(() => '');
            for (const entry of configPathMappings.split('\0')) {
              if (!entry) continue;
              const newlineIdx = entry.indexOf('\n');
              if (newlineIdx === -1) continue;
              const key = entry.slice(0, newlineIdx);
              const val = entry.slice(newlineIdx + 1);
              if (this.normalizeRepoPath(val) === normPath) {
                const nameMatch = key.match(/^submodule\.(.+)\.path$/);
                if (nameMatch) {
                  submoduleName = nameMatch[1];
                  break;
                }
              }
            }
          }

          const modulesBase = await this.getModulesBase();
          const isSubmoduleMetaDir = (dir: string) => isSameOrChildPath(modulesBase, dir) && path.relative(modulesBase, dir) !== '';

          if (actualGitDir && isSubmoduleMetaDir(actualGitDir)) {
            candidatesToClean.add(actualGitDir);
          }
          const namedDir = path.join(modulesBase, submoduleName);
          if (isSubmoduleMetaDir(namedDir)) {
            candidatesToClean.add(namedDir);
          }
          const pathDir = path.join(modulesBase, normPath);
          if (isSubmoduleMetaDir(pathDir)) {
            candidatesToClean.add(pathDir);
          }

          // 3. 安全前置校验：检查子模块是否存在未提交工作或未推送提交
          const isDirty = await this.isSubmoduleDirty(submodulePath).catch(() => false);
          if (isDirty && !options.force) {
            throw new Error(
              t('Submodule "{0}" has uncommitted local changes or unpushed commits. Aborting directory deletion to prevent data loss.', path.basename(submodulePath) || submodulePath)
            );
          }
        }

        // 先执行 Git index 的解决
        await this.git.raw(['update-index', '--force-remove', '--', normPath]);

        // 执行磁盘物理清理与元数据清理
        let cleanupWarning: string | undefined;
        if (options?.removeDirectory) {
          if (fs.existsSync(subAbsPath)) {
            try {
              fs.rmSync(subAbsPath, { recursive: true, force: true });
            } catch (e: unknown) {
              cleanupWarning = t('Failed to delete submodule directory "{0}": {1}', subAbsPath, String(e));
              this.logger?.warn('Git', `Failed to delete submodule directory: ${subAbsPath}`, { error: String(e) });
            }
          }

          for (const dir of candidatesToClean) {
            if (fs.existsSync(dir)) {
              try {
                fs.rmSync(dir, { recursive: true, force: true });
              } catch (e: unknown) {
                this.logger?.warn('Git', `Failed to delete submodule metadata directory: ${dir}`, { error: String(e) });
              }
            }
          }
        }

        return { conflictResolved: true, cleanupWarning };
      }
    });
  }

  async initSubmodule(submodulePath: string, allowFileProtocol = false): Promise<void> {
    const submoduleRoot = path.join(this.rootPath, this.normalizeRepoPath(submodulePath));
    const nestedSubmodules = this.collectSubmodulePathsRecursive(submoduleRoot);
    return withGitWriteLocks([this.rootPath, submoduleRoot, ...nestedSubmodules], async () => {
      const pathspec = this.literalPathspec(submodulePath);
      const initArgs = ['submodule', 'init'];
      const updateArgs = ['submodule', 'update', '--init', '--recursive'];
      if (allowFileProtocol) {
        initArgs.unshift('-c', 'protocol.file.allow=always');
        updateArgs.unshift('-c', 'protocol.file.allow=always');
      }
      initArgs.push('--', pathspec);
      updateArgs.push('--', pathspec);
      await this.getSubmoduleGit().raw(initArgs);
      await this.getSubmoduleGit().raw(updateArgs);
    });
  }

  async deinitSubmodule(submodulePath: string, force = false): Promise<void> {
    const submoduleRoot = path.join(this.rootPath, this.normalizeRepoPath(submodulePath));
    return withGitWriteLocks([this.rootPath, submoduleRoot], async () => {
      const args = ['submodule', 'deinit'];
      if (force) args.push('--force');
      args.push('--', this.literalPathspec(submodulePath));
      await this.git.raw(args);
    });
  }

  async updateSubmodule(submodulePath: string, init = true, recursive = false, remote = false, allowFileProtocol = false): Promise<void> {
    const submoduleRoot = path.join(this.rootPath, this.normalizeRepoPath(submodulePath));
    const nestedSubmodules = recursive ? this.collectSubmodulePathsRecursive(submoduleRoot) : [];
    return withGitWriteLocks([this.rootPath, submoduleRoot, ...nestedSubmodules], async () => {
      // 当对齐到父仓库记录指针时（非 remote 更新），若父仓库暂存区中存在该子模块指针改动，
      // 先将暂存区指针恢复至 HEAD，否则 git submodule update 只会对齐至 index，导致如果 index 已被暂存则无任何反应
      if (!remote) {
        await this.git.raw(['checkout', 'HEAD', '--', this.literalPathspec(submodulePath)]).catch(() => {});
      }
      const args = ['submodule', 'update'];
      if (allowFileProtocol) {
        args.unshift('-c', 'protocol.file.allow=always');
      }
      if (init) args.push('--init');
      if (recursive) args.push('--recursive');
      if (remote) args.push('--remote');
      args.push('--', this.literalPathspec(submodulePath));
      await this.getSubmoduleGit().raw(args);
    });
  }

  async updateAllSubmodules(recursive = true, init = true, allowFileProtocol = false): Promise<void> {
    const targetSubmodulePaths = recursive
      ? this.collectSubmodulePathsRecursive(this.rootPath)
      : (await this.getSubmoduleList().catch(() => [])).map(e => path.join(this.rootPath, this.normalizeRepoPath(e.path)));

    return withGitWriteLocks([this.rootPath, ...targetSubmodulePaths], async () => {
      // 对齐所有子模块至父仓库 HEAD 记录时，若有子模块指针已被暂存，先将暂存区指针恢复至 HEAD
      const entries = await this.getSubmoduleList().catch(() => []);
      for (const entry of entries) {
        if (entry.indexCommit && entry.recordedCommit && entry.indexCommit !== entry.recordedCommit) {
          await this.git.raw(['checkout', 'HEAD', '--', this.literalPathspec(entry.path)]).catch(() => {});
        }
      }
      const args = ['submodule', 'update'];
      if (allowFileProtocol) {
        args.unshift('-c', 'protocol.file.allow=always');
      }
      if (init) args.push('--init');
      if (recursive) args.push('--recursive');
      await this.getSubmoduleGit().raw(args);
    });
  }

  async getSubmoduleDiffSummary(submodulePath: string): Promise<{
    oldHash?: string;
    newHash?: string;
    summary?: string;
    parentCommit?: string;
    indexCommit?: string;
    headCommit?: string;
  }> {
    const normPath = this.normalizeRepoPath(submodulePath);
    const subAbsPath = path.join(this.rootPath, normPath);

    // 1. 从父仓库 HEAD 树解析真实父提交指针
    let parentCommit: string | undefined;
    try {
      const rawHead = (await this.git.raw(['rev-parse', `HEAD:${normPath}`])).trim();
      if (/^[0-9a-f]{40}$/i.test(rawHead)) {
        parentCommit = rawHead;
      }
    } catch {
      // HEAD may not exist or new submodule not committed yet
    }

    // 2. 从 index 读取暂存区指针
    let indexCommit: string | undefined;
    try {
      const lsStageRaw = await this.git.raw(['ls-files', '--stage', '--', this.literalPathspec(normPath)]);
      for (const line of lsStageRaw.split('\n')) {
        if (!line.startsWith('160000 ')) continue;
        const parts = line.split(/\s+/);
        if (parts.length >= 2 && /^[0-9a-f]{40}$/i.test(parts[1])) {
          indexCommit = parts[1];
          break;
        }
      }
    } catch {
      // ignore stage error
    }

    // 3. 读取子模块工作区当前检出的 HEAD
    let headCommit: string | undefined;
    if (fs.existsSync(path.join(subAbsPath, '.git'))) {
      try {
        const rawSubHead = (await createGitClient(subAbsPath, { allowUnsafeProtocolOverride: true }).raw(['rev-parse', 'HEAD'])).trim();
        if (/^[0-9a-f]{40}$/i.test(rawSubHead)) {
          headCommit = rawSubHead;
        }
      } catch {
        // ignore submodule rev-parse error
      }
    }

    const oldHash = parentCommit ?? indexCommit;
    const newHash = headCommit ?? indexCommit;
    let summary: string | undefined;

    if (fs.existsSync(path.join(subAbsPath, '.git'))) {
      const compareBase = parentCommit ?? indexCommit;
      const compareTarget = headCommit ?? indexCommit;
      if (compareBase && compareTarget && compareBase !== compareTarget) {
        try {
          const logOutput = await createGitClient(subAbsPath, { allowUnsafeProtocolOverride: true }).raw(['log', '--oneline', '-n', '10', `${compareBase}..${compareTarget}`]);
          if (logOutput.trim()) {
            summary = logOutput.trim();
          }
        } catch {
          // commits might not be connected directly
        }
      }
    }

    return {
      oldHash,
      newHash,
      summary,
      parentCommit,
      indexCommit,
      headCommit,
    };
  }

  async countUnpushedCommits(): Promise<number> {
    try {
      const raw = await this.git.raw(['rev-list', '@{u}..HEAD', '--count']);
      return parseInt(raw.trim(), 10) || 0;
    } catch {
      try {
        const remotes = await this.git.getRemotes();
        if (remotes.length === 0) {
          const raw = await this.git.raw(['rev-list', 'HEAD', '--count', '--max-count=100']);
          return parseInt(raw.trim(), 10) || 0;
        }
        const raw = await this.git.raw(['rev-list', 'HEAD', '--not', '--remotes', '--count']);
        return parseInt(raw.trim(), 10) || 0;
      } catch {
        return 0;
      }
    }
  }

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    const RS = '\x1E';
    const FS = '\x1F';
    const FORMAT = `%x1E%H%x1F%h%x1F%s%x1F%an%x1F%ci%x1F%B%x1F%b%x1F%P%x1F`;

    const parseRecords = (raw: string): UnpushedCommit[] => {
      const commits: UnpushedCommit[] = [];
      for (const record of raw.split(RS)) {
        if (!record.trim()) continue;
        const parts = record.split(FS);
        if (parts.length < 6) continue;
        const hash = parts[0].trim();
        const shortHash = parts[1].trim();
        const message = parts[2].trim();
        const author = parts[3].trim();
        const date = parts[4].trim();
        const fullMessage = parts[5].trim();
        const body = parts[6]?.trim() || undefined;
        const parentsRaw = parts[7]?.trim() || '';
        const parents = parentsRaw ? parentsRaw.split(/\s+/) : [];
        const statText = parts.slice(8).join(FS);

        const commit: UnpushedCommit = {
          hash,
          shortHash,
          message,
          fullMessage: fullMessage || message,
          body: body || undefined,
          author,
          date,
          parents,
        };
        const cachedStat = this.commitStatsCache.get(hash);
        if (cachedStat) {
          commit.filesChanged = cachedStat.filesChanged;
          commit.additions = cachedStat.additions;
          commit.deletions = cachedStat.deletions;
        } else {
          const statLine = statText.split('\n').find(l => l.includes('changed'));
          if (statLine) {
            const files = statLine.match(/(\d+) files? changed/);
            const ins = statLine.match(/(\d+) insertion/);
            const del = statLine.match(/(\d+) deletion/);
            commit.filesChanged = files ? parseInt(files[1], 10) : 0;
            commit.additions = ins ? parseInt(ins[1], 10) : 0;
            commit.deletions = del ? parseInt(del[1], 10) : 0;
          }
        }
        commits.push(commit);
      }
      return commits;
    };

    const logArgs = (range: string[]): string[] =>
      ['log', ...range, `--format=${FORMAT}`];

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

  async getMergeBase(ref1: string, ref2: string): Promise<string | undefined> {
    try {
      const base = (await this.git.raw(['merge-base', ref1, ref2])).trim();
      return base || undefined;
    } catch {
      return undefined;
    }
  }

  async getUnpushedAggregateBase(oldestHash?: string): Promise<string | undefined> {
    if (oldestHash) {
      try {
        return (await this.git.raw(['rev-parse', '--verify', `${oldestHash}^`])).trim() || undefined;
      } catch {
        return EMPTY_TREE_HASH;
      }
    }
    try {
      const tracking = (await this.git.raw(['rev-parse', '--verify', '@{u}'])).trim();
      if (tracking) {
        const mergeBase = (await this.git.raw(['merge-base', 'HEAD', '@{u}'])).trim();
        if (mergeBase) return mergeBase;
      }
    } catch {
      // no upstream or merge-base failed
    }
    return undefined;
  }

  async getUnpushedAggregatedChanges(oldestHash?: string): Promise<PushCommitFile[]> {
    const baseRef = await this.getUnpushedAggregateBase(oldestHash);
    if (!baseRef) return [];

    const [nameStatusRaw, numStatRaw] = await Promise.all([
      this.rawPathSafe(['diff', '--name-status', '-z', '-M', baseRef, 'HEAD']),
      this.rawPathSafe(['diff', '--numstat', '-z', '-M', baseRef, 'HEAD']),
    ]);
    const stats = parseNumStatZOutput(numStatRaw);
    const files: PushCommitFile[] = [];
    for (const file of parseNameStatusZOutput(nameStatusRaw)) {
      const stat = stats.get(file.path);
      files.push({
        path: file.path,
        status: file.code.replace(/\d+$/, ''),
        added: stat?.added,
        removed: stat?.removed,
      });
    }
    return files;
  }

  async fetchSingleRepo(remote?: string): Promise<void> {
    return this.withWriteLock(async () => {
      const args = remote ? [remote] : ['--prune'];
      await this.git.fetch(args);
    });
  }

  async getIncomingCommits(): Promise<IncomingCommit[]> {
    const RS = '\x1E';
    const FS = '\x1F';
    const FORMAT = `%x1E%H%x1F%h%x1F%s%x1F%an%x1F%ci%x1F%B%x1F%b%x1F%P%x1F`;

    const logArgs = (range: string[]): string[] =>
      ['log', ...range, `--format=${FORMAT}`];

    const tracking = await this.git.raw(['rev-parse', '--verify', '@{u}']).catch(() => '');
    if (!tracking.trim()) return [];

    const raw = await this.git.raw(logArgs(['HEAD..@{u}']));
    const commits: IncomingCommit[] = [];

    for (const record of raw.split(RS)) {
      if (!record.trim()) continue;
      const parts = record.split(FS);
      if (parts.length < 8) continue;
      const hash = parts[0].trim();
      const shortHash = parts[1].trim();
      const message = parts[2].trim();
      const author = parts[3].trim();
      const date = parts[4].trim();
      const fullMessage = parts[5].trim();
      const body = parts[6]?.trim() || undefined;
      const parentsRaw = parts[7]?.trim() || '';
      const parents = parentsRaw ? parentsRaw.split(/\s+/) : [];
      const statText = parts.slice(8).join(FS);

      const commit: IncomingCommit = {
        hash,
        shortHash,
        message,
        fullMessage: fullMessage || message,
        body: body || undefined,
        author,
        date,
        parents,
      };
      const cachedStat = this.commitStatsCache.get(hash);
      if (cachedStat) {
        commit.filesChanged = cachedStat.filesChanged;
        commit.additions = cachedStat.additions;
        commit.deletions = cachedStat.deletions;
      } else {
        const statLine = statText.split('\n').find(l => l.includes('changed'));
        if (statLine) {
          const files = statLine.match(/(\d+) files? changed/);
          const ins = statLine.match(/(\d+) insertion/);
          const del = statLine.match(/(\d+) deletion/);
          commit.filesChanged = files ? parseInt(files[1], 10) : 0;
          commit.additions = ins ? parseInt(ins[1], 10) : 0;
          commit.deletions = del ? parseInt(del[1], 10) : 0;
        }
      }
      commits.push(commit);
    }

    if (commits.length === 0) return [];

    try {
      const status = await this.getStatus().catch(() => null);
      const localModifiedPaths = new Set<string>();
      if (status) {
        for (const f of [...status.stagedFiles, ...status.unstagedFiles]) {
          if (f.path) localModifiedPaths.add(f.path);
        }
      }

      if (localModifiedPaths.size > 0) {
        await Promise.all(
          commits.map(async commit => {
            try {
              const commitFiles = await this.getCommitFiles(commit.hash);
              const conflicts = commitFiles
                .map(f => f.path)
                .filter(p => localModifiedPaths.has(p));
              if (conflicts.length > 0) {
                commit.potentialConflictPaths = conflicts;
              }
            } catch {
              // Ignore failure for individual commit files
            }
          })
        );
      }
    } catch {
      // Fallback gracefully
    }

    return commits;
  }

  async getIncomingAggregatedChanges(): Promise<PushCommitFile[]> {
    const tracking = await this.git.raw(['rev-parse', '--verify', '@{u}']).catch(() => '');
    if (!tracking.trim()) return [];

    const [nameStatusRaw, numStatRaw] = await Promise.all([
      this.rawPathSafe(['diff', '--name-status', '-z', '-M', 'HEAD...@{u}']).catch(() =>
        this.rawPathSafe(['diff', '--name-status', '-z', '-M', 'HEAD', '@{u}'])
      ),
      this.rawPathSafe(['diff', '--numstat', '-z', '-M', 'HEAD...@{u}']).catch(() =>
        this.rawPathSafe(['diff', '--numstat', '-z', '-M', 'HEAD', '@{u}'])
      ),
    ]);
    const stats = parseNumStatZOutput(numStatRaw);
    const files: PushCommitFile[] = [];
    for (const file of parseNameStatusZOutput(nameStatusRaw)) {
      const stat = stats.get(file.path);
      files.push({
        path: file.path,
        status: file.code.replace(/\d+$/, ''),
        added: stat?.added,
        removed: stat?.removed,
      });
    }
    return files;
  }

  // ─── Worktree operations ──────────────────────────────────────────────────

  async getWorktrees(): Promise<WorktreeEntry[]> {
    const raw = await this.git.raw(['worktree', 'list', '--porcelain']);
    return parseWorktreePorcelain(raw);
  }

  async createWorktree(worktreePath: string, opts: { branch?: string; newBranch?: string; commitish?: string; noTrack?: boolean }): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      return withGitWriteLocks([this.rootPath, worktreePath], async () => {
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
      });
    }, 'checkout', worktreePath);
  }

  async deleteWorktree(worktreePath: string, force = false): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      return withGitWriteLocks([this.rootPath, worktreePath], async () => {
        const args = ['worktree', 'remove'];
        if (force) args.push('--force');
        args.push(worktreePath);
        await this.git.raw(args);
      });
    }, 'sync', worktreePath);
  }

  async pruneWorktrees(): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['worktree', 'prune']).then(() => undefined), 'sync', 'prune worktrees');
  }

  async lockWorktree(worktreePath: string, reason?: string): Promise<void> {
    return this.runStatusSensitiveOperation(async () => {
      const args = ['worktree', 'lock'];
      if (reason) args.push('--reason', reason);
      args.push(worktreePath);
      await this.git.raw(args);
    }, 'sync', worktreePath);
  }

  async unlockWorktree(worktreePath: string): Promise<void> {
    return this.runStatusSensitiveOperation(() => this.git.raw(['worktree', 'unlock', worktreePath]).then(() => undefined), 'sync', worktreePath);
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
