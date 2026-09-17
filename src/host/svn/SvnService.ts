import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, type CommitMessageHistoryEntry, type SuppressStatusUpdates, type RefreshStatus } from '../git/GitService';
import { detectLanguage, parseDiff } from '../git/DiffParser';
import type { BlameLine } from '../git/BlameService';
import type {
  BranchInfo,
  CommitNode,
  CommitLogList,
  ConflictFileStatus,
  ConflictPropertyValue,
  ConflictType,
  FileDiff,
  FileStatus,
  GitFileStatus,
  GraphCommitNode,
  LineRange,
  RepoStatus,
} from '../types/git';
import type { StashEntry, UnpushedCommit } from '../types/messages';
import { CliError, execCli } from '../vcs/cli';
import { t } from '../utils/l10n';
import { resolveRepoPath as resolvePathWithinRepo } from '../utils/repoPath';
import { scopedKey } from '../utils/scopedKey';
import type { SvnUpdateSnapshot, VcsUpdateSnapshot } from '../update/types';

const SVN_REVISION_CONTENT_CACHE_LIMIT = 200;
const SVN_REVISION_CONTENT_MAX_TOTAL_BYTES = 30 * 1024 * 1024;
const SVN_MAX_CACHEABLE_FILE_BYTES = 1 * 1024 * 1024;
const SVN_STATUS_CACHE_TTL_MS = 2500;
const SVN_COMMIT_META_CACHE_LIMIT = 500;
const SVN_COMMIT_FILES_CACHE_LIMIT = 200;
const SVN_BLAME_CACHE_LIMIT = 20;
const SVN_AUTH_REPROMPT_DELAY_MS = 30_000;
const SVN_INCOMING_STATE_CACHE_TTL_MS = 60_000;
const SVN_INCOMING_STATE_FAILURE_RETRY_MS = 60_000;
const SVN_REMOTE_BRANCHES_CACHE_TTL_MS = 300_000;
const SVN_REMOTE_TAGS_CACHE_TTL_MS = 300_000;
const SVN_FILTER_SEARCH_SCAN_LIMIT = 1000;
const SVN_GRAPH_LOG_SAFE_LIMIT = 100;
const SVN_MAX_INLINE_DIFF_FILE_BYTES = 8 * 1024 * 1024;
const SVN_AUTH_CACHE_ARGS = [
  '--config-option', 'servers:global:store-passwords=yes',
  '--config-option', 'servers:global:store-auth-creds=yes',
];

interface SvnInfo {
  url: string;
  rootUrl: string;
  relativeUrl: string;
  revision?: string;
}

export interface SvnRepositoryInfo {
  url: string;
  rootUrl: string;
  relativeUrl: string;
}

export interface SvnAuthenticationStatus {
  authKey?: string;
  realm?: string;
  username?: string;
  source: 'session' | 'svn-scm' | 'native-cache' | 'unknown';
  hasCachedCredentials: boolean;
}

interface SvnLogPath {
  path: string;
  action: string;
  kind?: string;
}

interface SvnLogEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
  paths?: SvnLogPath[];
}

interface SvnIncomingState {
  url: string;
  localRevision?: number;
  remoteRevision?: number;
  behind: number;
  incomingRevisions: Set<string>;
  checkedAt: number;
}

interface SvnStatusEntry extends FileStatus {
  svnItem: string;
  svnProps?: string;
  svnCopied: boolean;
  treeConflicted: boolean;
  isTruncated?: boolean;
}

interface SvnListEntry {
  name: string;
  kind?: string;
  revision?: string;
  date: string;
}

interface PendingSvnRevert {
  message: string;
  paths: string[];
  addedPaths: string[];
}

interface PendingSvnMerge {
  paths: string[];
  addedPaths: string[];
}

interface SvnRemoteStatusEntry {
  path: string;
  baseRevision?: number;
}

interface SvnRemoteStatus {
  remoteRevision?: number;
  entries: SvnRemoteStatusEntry[];
}

interface SvnCommandOptions {
  timeout?: number;
  signal?: AbortSignal;
}

export interface SvnIgnoreEntry {
  directoryPath: string;
  entry: string;
  fullPath: string;
}

export interface SvnIgnoreUpdateResult extends SvnIgnoreEntry {
  alreadyExists: boolean;
}

interface SvnCredentials {
  username: string;
  password: string;
  remember?: boolean;
}

interface SvnScmStoredAuth {
  account: string;
  password: string;
}

interface SvnScmRepositoryBridge {
  root?: string;
  workspaceRoot?: string;
  username?: string;
  password?: string;
  loadStoredAuths?: () => Promise<SvnScmStoredAuth[]>;
}

interface SvnScmManagerBridge {
  isInitialized?: Promise<void>;
  getRepository?: (hint: unknown) => SvnScmRepositoryBridge | null;
  repositories?: SvnScmRepositoryBridge[];
  tryOpenRepository?: (repoPath: string) => Promise<void>;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#(?:x([0-9a-f]+)|(\d+));/gi, (entity, hexadecimal: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hexadecimal ?? decimal ?? '', hexadecimal ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
      try { return String.fromCodePoint(codePoint); } catch { return entity; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function textTag(source: string, name: string, trim = true): string {
  const match = source.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  if (!match) return '';
  const decoded = decodeXml(match[1]);
  return trim ? decoded.trim() : decoded;
}

function limitConflictPropertyValue(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  return normalized.length > 4096 ? `${normalized.slice(0, 4096)}…` : normalized;
}

function parsePropertyConflictContent(content: string): ConflictPropertyValue[] {
  const conflicts: ConflictPropertyValue[] = [];
  for (const block of content.split(/\n(?=Trying to )/)) {
    const propertyName = block.match(/property '([^']+)'/)?.[1];
    if (!propertyName || conflicts.some(conflict => conflict.name === propertyName)) continue;

    const localMarker = block.indexOf('<<<<<<<');
    const separator = localMarker >= 0 ? block.indexOf('=======', localMarker) : -1;
    const baseMarker = localMarker >= 0 ? block.indexOf('|||||||', localMarker) : -1;
    const incomingMarker = separator >= 0 ? block.indexOf('>>>>>>>', separator) : -1;
    const currentEnd = baseMarker >= 0 && (separator < 0 || baseMarker < separator) ? baseMarker : separator;
    const currentValue = localMarker >= 0 && separator >= 0
      ? limitConflictPropertyValue(block.slice(block.indexOf('\n', localMarker) + 1, currentEnd))
      : undefined;
    const incomingValue = separator >= 0 && incomingMarker >= 0
      ? limitConflictPropertyValue(block.slice(separator + '======='.length, incomingMarker))
      : undefined;

    conflicts.push({ name: propertyName, currentValue, incomingValue });
  }
  return conflicts;
}

function normalizeRelPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\/+/, '');
}

function isNestedVcsPath(filePath: string): boolean {
  const norm = normalizeRelPath(filePath).toLowerCase();
  return norm.split('/').some(segment => segment === '.git' || segment === '.hg');
}

function pruneRedundantChildPaths(paths: string[]): string[] {
  const normalized = Array.from(new Set(paths.map(p => normalizeRelPath(p))));
  const pathSet = new Set(normalized);
  return normalized.filter(p => {
    let slashIdx = p.lastIndexOf('/');
    while (slashIdx > 0) {
      const parent = p.slice(0, slashIdx);
      if (pathSet.has(parent)) {
        return false;
      }
      slashIdx = p.lastIndexOf('/', slashIdx - 1);
    }
    return true;
  });
}

function splitIgnoreLines(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => line.length > 0);
}

function svnItemToStatus(item: string, props?: string): GitFileStatus | null {
  if (props === 'conflicted') return 'conflicted';
  switch (item) {
    case 'modified':
    case 'replaced':
      return 'modified';
    case 'added':
      return 'added';
    case 'deleted':
    case 'missing':
      return 'deleted';
    case 'unversioned':
      return 'untracked';
    case 'conflicted':
    case 'obstructed':
      return 'conflicted';
    case 'normal':
    case 'none':
      return props === 'modified' ? 'modified' : null;
    case 'ignored':
    case 'external':
    case 'incomplete':
      return null;
    default:
      return 'modified';
  }
}

function svnSummaryItemToStatus(item: string): string {
  switch (item) {
    case 'added': return 'A';
    case 'deleted': return 'D';
    case 'modified':
    case 'replaced':
    case 'none':
    default:
      return 'M';
  }
}

function parseRevision(hash: string): string {
  return hash.replace(/^r/i, '').trim();
}

function parseRevisionNumber(value?: string): number | undefined {
  const revision = parseRevision(value ?? '');
  if (!/^\d+$/.test(revision)) return undefined;
  const parsed = Number(revision);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function requireRevision(value: string): string {
  const revision = parseRevisionNumber(value);
  if (revision === undefined) throw new Error(t('Invalid SVN revision: {0}', value));
  return String(revision);
}

function decodeSvnRelativeUrl(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function escapePegRevision(target: string): string {
  return target.includes('@') ? `${target}@` : target;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeCharInClass(c: string): string {
  if (c === '\\' || c === ']' || c === '[') return '\\' + c;
  return c;
}

function matchSvnGlob(pattern: string, filename: string): boolean {
  if (pattern === filename) return true;
  let regexStr = '^';
  let i = 0;
  const len = pattern.length;
  while (i < len) {
    const c = pattern[i];
    if (c === '\\') {
      if (i + 1 < len) {
        i++;
        regexStr += escapeRegExp(pattern[i]);
      } else {
        regexStr += '\\\\';
      }
    } else if (c === '*') {
      regexStr += '.*';
    } else if (c === '?') {
      regexStr += '.';
    } else if (c === '[') {
      let j = i + 1;
      let isNegated = false;
      if (j < len && (pattern[j] === '!' || pattern[j] === '^')) {
        isNegated = true;
        j++;
      }
      if (j < len && pattern[j] === ']') {
        j++;
      }
      let closeIdx = -1;
      while (j < len) {
        if (pattern[j] === '\\') {
          j += 2;
          continue;
        }
        if (pattern[j] === ']') {
          closeIdx = j;
          break;
        }
        j++;
      }
      if (closeIdx === -1) {
        regexStr += '\\[';
      } else {
        let inside = '';
        let k = (pattern[i + 1] === '!' || pattern[i + 1] === '^') ? i + 2 : i + 1;
        while (k < closeIdx) {
          const char = pattern[k];
          if (char === '\\') {
            if (k + 1 < closeIdx) {
              k++;
              const next = pattern[k];
              if (/[\\-\]^]/.test(next)) {
                inside += '\\' + next;
              } else {
                inside += escapeRegExp(next);
              }
            } else {
              inside += '\\\\';
            }
          } else if (char === ']') {
            inside += '\\]';
          } else if (char === '^' && inside.length === 0 && !isNegated) {
            inside += '\\^';
          } else if (char === '-') {
            if (inside.length === 0 || k === closeIdx - 1) {
              inside += '\\-';
            } else {
              inside += '-';
            }
          } else {
            inside += escapeCharInClass(char);
          }
          k++;
        }
        regexStr += '[' + (isNegated ? '^' : '') + inside + ']';
        i = closeIdx;
      }
    } else {
      regexStr += escapeRegExp(c);
    }
    i++;
  }
  regexStr += '$';
  try {
    return new RegExp(regexStr).test(filename);
  } catch {
    return false;
  }
}

function parseSvnDate(value: string): Date {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function isLikelyBinaryContent(value: string): boolean {
  return value.includes('\0') || value.includes('\ufffd');
}

function decodeUtf8Buffer(buffer: Buffer): { content: string; isBinary: boolean } {
  const content = buffer.toString('utf8');
  return {
    content,
    isBinary: buffer.includes(0) || !Buffer.from(content, 'utf8').equals(buffer),
  };
}

function parseInfoRevision(raw: string): number | undefined {
  const entryRevision = attr(raw.match(/<entry\b[^>]*>/)?.[0] ?? '', 'revision');
  const commitRevision = attr(raw.match(/<commit\b[^>]*>/)?.[0] ?? '', 'revision');
  return parseRevisionNumber(entryRevision ?? commitRevision);
}

function buildSyntheticGitDiff(raw: string, forcedFilePath?: string): string {
  if (!raw.trim()) return '';
  const chunks = raw.split(/^Index: /m).filter(Boolean);
  if (chunks.length === 0) return raw;
  return chunks.map(chunk => {
    const nl = chunk.indexOf('\n');
    const filePath = forcedFilePath
      ?? normalizeRelPath((nl === -1 ? chunk : chunk.slice(0, nl)).replace(/\r$/, ''));
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    const modeMarker = /^--- .*\(nonexistent\)\s*$/m.test(body)
      ? 'new file mode 100644\n'
      : /^\+\+\+ .*\(nonexistent\)\s*$/m.test(body)
        ? 'deleted file mode 100644\n'
        : '';
    const binaryMarker = /cannot display:[^\n]*binary/i.test(body)
      ? `\nBinary files a/${filePath} and b/${filePath} differ\n`
      : '';
    return `diff --git a/${filePath} b/${filePath}\n${modeMarker}${body}${binaryMarker}`;
  }).join('\n');
}

export class SvnService extends GitService {
  public readonly kind: 'git' | 'svn' = 'svn';
  private static passwordFromStdinSupport?: Promise<boolean>;
  private static authSubcommandSupport?: Promise<boolean>;
  private static readonly authCredentials = new Map<string, SvnCredentials>();
  private static readonly authPromptTasks = new Map<string, Promise<SvnCredentials | undefined>>();
  private static readonly authKeyByRootPath = new Map<string, string>();
  private static readonly authKeyTasks = new Map<string, Promise<string | undefined>>();
  private static readonly authFailureTimes = new Map<string, number>();
  private readonly revisionContentCache = new Map<string, Promise<string | undefined>>();
  private readonly commitMetaCache = new Map<string, Promise<{ meta: { hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] }; fullMessage: string }>>();
  private readonly commitFilesCache = new Map<string, Promise<Array<{ path: string; status: string; added?: number; removed?: number }>>>();
  private readonly blameCache = new Map<string, Promise<BlameLine[]>>();
  private readonly revisionContentSizes = new Map<string, number>();
  private revisionContentTotalBytes = 0;
  private statusGeneration = 0;
  private lastStatusSnapshot?: { status: RepoStatus; timestamp: number };
  private statusInFlight?: { generation: number; task: Promise<RepoStatus> };
  private logHistoryEntries: SvnLogEntry[] = [];
  private logHistoryHeadRevision?: string;
  private logHistoryGeneration = 0;
  private headLogInFlight: { limit: number; promise: Promise<SvnLogEntry[]> } | null = null;
  private activeSearches = new Map<string, {
    key: string;
    matchedEntries: SvnLogEntry[];
    nextCursorRev: number | undefined;
    reachedEnd: boolean;
    lastError?: string;
    abortController: AbortController;
    generation: number;
  }>();
  private prefetchAbortController?: AbortController;
  private infoCache?: { info: SvnInfo; metadataMtimeMs?: number };
  private incomingStateCache?: SvnIncomingState;
  private incomingStateTask?: Promise<SvnIncomingState>;
  private incomingStateTaskUrl?: string;
  private incomingStateGeneration = 0;
  private authenticationStatusCache?: { expiresAt: number; status: SvnAuthenticationStatus };
  private repositoryUrlCache?: { url: string; metadataMtimeMs?: number };
  private localRevisionFloor?: number;
  private localRevisionFloorTask?: Promise<number | undefined>;
  private localRevisionGeneration = 0;
  private localRevisionMetadataMtimeMs?: number;
  private pendingRevert?: PendingSvnRevert;
  private pendingMerge?: PendingSvnMerge;
  private lastIncomingStateFailureTime = 0;
  private remoteBranchesCache?: { branches: string[]; hasTrunk: boolean; timestamp: number };
  private remoteBranchesTask?: Promise<BranchInfo[]>;
  private remoteBranchesGeneration = 0;
  private remoteTagsCache?: { tags: Array<{ name: string; hash: string; date: string }>; timestamp: number };
  private remoteTagsTask?: Promise<Array<{ name: string; hash: string; date: string }>>;
  private remoteTagsGeneration = 0;

  constructor(
    repoId: string,
    rootPath: string,
    suppressStatusUpdates?: SuppressStatusUpdates,
    refreshStatus?: RefreshStatus,
    publishMissingRemote?: import('../remote/types').PublishMissingRemote,
    logger?: import('../utils/Logger').VersionDockLogger,
  ) {
    super(repoId, rootPath, suppressStatusUpdates, refreshStatus, publishMissingRemote, logger);
  }

  protected override runStatusSensitiveOperation<T>(operation: () => Promise<T>, kind: import('../git/GitService').StatusOperationKind, label?: string): Promise<T> {
    this.invalidateStatusCache();
    if (kind === 'commit' || kind === 'sync' || kind === 'checkout' || kind === 'merge' || kind === 'cherry-pick') {
      this.clearLogHistoryCache();
    }
    return super.runStatusSensitiveOperation(async () => {
      try {
        return await operation();
      } finally {
        this.invalidateStatusCache();
      }
    }, kind, label);
  }

  private async svn(args: string[], options: SvnCommandOptions = {}): Promise<string> {
    const cachedKey = await this.resolveWorkingCopyAuthKey();

    if (cachedKey) {
      const preferredCredentials = SvnService.authCredentials.get(cachedKey);
      if (preferredCredentials) {
        try {
          return await this.runWithCredentials(args, cachedKey, preferredCredentials, options);
        } catch (error: unknown) {
          if (!this.isAuthenticationError(error)) throw error;
        }
      }
    }

    try {
      const result = await execCli('svn', this.withGlobalArgs(args, ['--non-interactive']), {
        cwd: this.rootPath,
        timeout: options.timeout,
        signal: options.signal,
      });
      return result.stdout;
    } catch (error: unknown) {
      if (!this.isAuthenticationError(error)) throw error;

      const authKey = await this.getAuthKey(error, cachedKey);
      SvnService.authKeyByRootPath.set(this.rootPath, authKey);

      const sharedCredentials = SvnService.authCredentials.get(authKey);
      if (sharedCredentials) {
        try {
          return await this.runWithCredentials(args, authKey, sharedCredentials, options);
        } catch (retryError: unknown) {
          if (!this.isAuthenticationError(retryError)) throw retryError;
        }
      }

      const svnScmResult = await this.trySvnScmCredentials(args, authKey, options);
      if (svnScmResult !== undefined) return svnScmResult;

      if (this.isAuthPromptSuppressed(authKey)) throw error;
      const credentials = await this.promptForCredentials(authKey);
      if (!credentials) {
        this.rememberAuthFailure(authKey);
        throw error;
      }

      try {
        return await this.runWithCredentials(args, authKey, credentials, options);
      } catch (retryError: unknown) {
        if (this.isAuthenticationError(retryError)) this.rememberAuthFailure(authKey);
        throw retryError;
      }
    }
  }

  private async runWithCredentials(args: string[], authKey: string, credentials: SvnCredentials, options: SvnCommandOptions = {}): Promise<string> {
    SvnService.authCredentials.set(authKey, credentials);
    const supportsPasswordFromStdin = await this.supportsPasswordFromStdin();
    const commandArgs = this.withAuthArgs(args, credentials, credentials.remember !== false, supportsPasswordFromStdin);
    try {
      const result = await execCli('svn', commandArgs, {
        cwd: this.rootPath,
        timeout: options.timeout,
        stdin: supportsPasswordFromStdin ? `${credentials.password}\n` : undefined,
        signal: options.signal,
      });
      SvnService.authFailureTimes.delete(authKey);
      this.authenticationStatusCache = undefined;
      return result.stdout;
    } catch (error: unknown) {
      if (this.isAuthenticationError(error)) SvnService.authCredentials.delete(authKey);
      throw supportsPasswordFromStdin ? error : this.redactLegacyPassword(error, credentials.password);
    }
  }

  private withAuthArgs(args: string[], credentials: SvnCredentials, remember: boolean, passwordFromStdin: boolean): string[] {
    const authArgs = [
      '--username', credentials.username,
      ...(passwordFromStdin ? ['--password-from-stdin'] : ['--password', credentials.password]),
      '--non-interactive',
      ...(remember ? SVN_AUTH_CACHE_ARGS : ['--no-auth-cache']),
    ];
    return this.withGlobalArgs(args, authArgs);
  }

  private withGlobalArgs(args: string[], globalArgs: string[]): string[] {
    const uniqueGlobalArgs = globalArgs.filter((arg, index) => arg !== '--non-interactive'
      || (!args.includes('--non-interactive') && globalArgs.indexOf(arg) === index));
    // SVN global options are valid before the subcommand. Keeping them there
    // avoids mistaking a legitimate positional value of "--" (for example a
    // commit message) for the path separator.
    return [...uniqueGlobalArgs, ...args];
  }

  private supportsPasswordFromStdin(): Promise<boolean> {
    if (SvnService.passwordFromStdinSupport) return SvnService.passwordFromStdinSupport;
    const task = execCli('svn', ['--version', '--quiet'], { cwd: this.rootPath, timeout: 15_000 })
      .then(result => {
        const match = result.stdout.match(/(\d+)\.(\d+)/);
        if (!match) return false;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        return major > 1 || (major === 1 && minor >= 10);
      })
      .catch(() => false);
    SvnService.passwordFromStdinSupport = task;
    return task;
  }

  private supportsAuthSubcommand(): Promise<boolean> {
    if (SvnService.authSubcommandSupport) return SvnService.authSubcommandSupport;
    const task = execCli('svn', ['--version', '--quiet'], { cwd: this.rootPath, timeout: 15_000 })
      .then(result => {
        const match = result.stdout.match(/(\d+)\.(\d+)/);
        if (!match) return false;
        const major = Number(match[1]);
        const minor = Number(match[2]);
        return major > 1 || (major === 1 && minor >= 9);
      })
      .catch(() => false);
    SvnService.authSubcommandSupport = task;
    return task;
  }

  private redactLegacyPassword(error: unknown, password: string): unknown {
    if (!(error instanceof CliError)) return error;
    const args = error.args.map((arg, index, all) => all[index - 1] === '--password' ? '<redacted>' : arg);
    const redact = (value: string): string => password ? value.split(password).join('<redacted>') : value;
    return new CliError(
      redact(error.message),
      error.command,
      args,
      redact(error.stdout),
      redact(error.stderr),
      error.code,
    );
  }

  private errorText(error: unknown): string {
    if (error instanceof CliError) return [error.message, error.stderr, error.stdout].filter(Boolean).join('\n');
    return String(error);
  }

  private isAuthenticationError(error: unknown): boolean {
    const text = this.errorText(error).toLowerCase();
    if (this.isAuthorizationDenied(error)) return false;
    return text.includes('e170001')
      || text.includes('e215004')
      || text.includes("can't get username or password")
      || text.includes('authentication failed')
      || text.includes('authorization failed')
      || text.includes('could not authenticate');
  }

  private isAuthorizationDenied(error: unknown): boolean {
    const text = this.errorText(error).toLowerCase();
    return text.includes('authorization failed')
      || text.includes('not authorized')
      || text.includes('e220001');
  }

  private async resolveWorkingCopyAuthKey(): Promise<string | undefined> {
    const cached = SvnService.authKeyByRootPath.get(this.rootPath);
    if (cached) return cached;
    const authKey = await this.getAuthKeyFromWorkingCopy();
    if (authKey) SvnService.authKeyByRootPath.set(this.rootPath, authKey);
    return authKey;
  }

  private async trySvnScmCredentials(args: string[], authKey: string, options: SvnCommandOptions): Promise<string | undefined> {
    const credentials = await this.getSvnScmCredentials();
    for (const credential of credentials) {
      try {
        return await this.runWithCredentials(args, authKey, credential, options);
      } catch (error: unknown) {
        if (!this.isAuthenticationError(error)) throw error;
      }
    }
    return undefined;
  }

  private async getSvnScmCredentials(): Promise<SvnCredentials[]> {
    const repository = await this.getSvnScmRepository();
    if (!repository) return [];

    const credentials: SvnCredentials[] = [];
    const addCredential = (username?: string, password?: string): void => {
      if (!username || !password) return;
      if (credentials.some(item => item.username === username && item.password === password)) return;
      credentials.push({ username, password });
    };

    addCredential(repository.username, repository.password);
    if (typeof repository.loadStoredAuths === 'function') {
      const stored = await repository.loadStoredAuths().catch(() => []);
      stored.slice().reverse().forEach(item => addCredential(item.account, item.password));
    }

    return credentials;
  }

  async getAuthenticationStatus(force = false): Promise<SvnAuthenticationStatus> {
    if (!force && this.authenticationStatusCache && this.authenticationStatusCache.expiresAt > Date.now()) {
      return this.authenticationStatusCache.status;
    }

    const authKey = await this.resolveWorkingCopyAuthKey();
    const sessionCredentials = authKey ? SvnService.authCredentials.get(authKey) : undefined;
    if (sessionCredentials) {
      return this.cacheAuthenticationStatus({
        authKey,
        username: sessionCredentials.username,
        source: 'session',
        hasCachedCredentials: sessionCredentials.remember !== false,
      });
    }

    const svnScmRepository = await this.getSvnScmRepository();
    if (svnScmRepository?.username) {
      return this.cacheAuthenticationStatus({
        authKey,
        username: svnScmRepository.username,
        source: 'svn-scm',
        hasCachedCredentials: true,
      });
    }
    if (svnScmRepository?.loadStoredAuths) {
      const stored = await svnScmRepository.loadStoredAuths().catch(() => []);
      const account = stored.at(-1)?.account;
      if (account) {
        return this.cacheAuthenticationStatus({
          authKey,
          username: account,
          source: 'svn-scm',
          hasCachedCredentials: true,
        });
      }
    }

    const nativeEntry = await this.getNativeAuthenticationEntry(authKey);
    if (nativeEntry) {
      return this.cacheAuthenticationStatus({
        authKey,
        realm: nativeEntry.realm,
        username: nativeEntry.username,
        source: 'native-cache',
        hasCachedCredentials: true,
      });
    }

    return this.cacheAuthenticationStatus({
      authKey,
      source: 'unknown',
      hasCachedCredentials: false,
    });
  }

  async switchAuthentication(username: string, password: string, remember: boolean): Promise<SvnAuthenticationStatus> {
    const normalizedUsername = username.trim();
    if (!normalizedUsername) throw new Error(t('SVN username cannot be empty.'));
    if (!password) throw new Error(t('SVN password cannot be empty.'));

    const authKey = await this.resolveWorkingCopyAuthKey() ?? this.rootPath;
    const credentials: SvnCredentials = { username: normalizedUsername, password, remember };
    await this.runWithCredentials(['info', '--xml'], authKey, credentials);
    SvnService.authKeyByRootPath.set(this.rootPath, authKey);
    return this.getAuthenticationStatus(true);
  }

  async forgetSessionAuthentication(): Promise<void> {
    const authKey = await this.resolveWorkingCopyAuthKey();
    if (authKey) {
      SvnService.authCredentials.delete(authKey);
      SvnService.authFailureTimes.delete(authKey);
    }
    this.authenticationStatusCache = undefined;
  }

  async clearCachedAuthentication(): Promise<string> {
    if (!await this.supportsAuthSubcommand()) {
      throw new Error(t('Clearing native SVN credentials from VersionDock requires SVN 1.9 or newer.'));
    }
    const status = await this.getAuthenticationStatus(true);
    const pattern = status.realm ?? (status.authKey ? this.nativeAuthenticationPattern(status.authKey) : undefined);
    if (!pattern) throw new Error(t('Unable to determine the SVN authentication realm for this working copy.'));

    await this.forgetSessionAuthentication();
    const result = await execCli('svn', ['auth', '--remove', pattern], { cwd: this.rootPath });
    this.authenticationStatusCache = undefined;
    return result.stdout.trim();
  }

  async testAuthentication(): Promise<SvnRepositoryInfo> {
    return this.getRepositoryInfo();
  }

  async inspectRepositoryInfo(): Promise<SvnRepositoryInfo | undefined> {
    try {
      const result = await execCli('svn', ['info', '--xml', '--non-interactive'], {
        cwd: this.rootPath,
        timeout: 15_000,
      });
      return {
        url: textTag(result.stdout, 'url'),
        rootUrl: textTag(result.stdout, 'root'),
        relativeUrl: decodeSvnRelativeUrl(textTag(result.stdout, 'relative-url').replace(/^\^\/?/, '')),
      };
    } catch {
      return undefined;
    }
  }

  private cacheAuthenticationStatus(status: SvnAuthenticationStatus): SvnAuthenticationStatus {
    this.authenticationStatusCache = { expiresAt: Date.now() + 30_000, status };
    return status;
  }

  private async getNativeAuthenticationEntry(authKey?: string): Promise<{ realm?: string; username?: string } | undefined> {
    if (!await this.supportsAuthSubcommand()) return undefined;
    try {
      const args = authKey ? ['auth', this.nativeAuthenticationPattern(authKey)] : ['auth'];
      const result = await execCli('svn', args, { cwd: this.rootPath, timeout: 15_000 });
      const blocks = result.stdout.split(/\n-{8,}\s*\n/g);
      for (const block of blocks) {
        const realm = block.match(/^\s*Authentication realm:\s*(.+)$/mi)?.[1]?.trim();
        const username = block.match(/^\s*Username:\s*(.+)$/mi)?.[1]?.trim();
        if (!username) continue;
        return { realm, username };
      }
    } catch { /* native auth inspection is best-effort */ }
    return undefined;
  }

  private nativeAuthenticationPattern(authKey: string): string {
    if (authKey.startsWith('realm:')) return authKey.slice('realm:'.length);
    try {
      const url = new URL(authKey);
      return `*${url.protocol}//${url.host}*`;
    } catch {
      return `*${authKey}*`;
    }
  }

  private async getSvnScmRepository(): Promise<SvnScmRepositoryBridge | undefined> {
    try {
      const manager = await vscode.commands.executeCommand<SvnScmManagerBridge>('svn.getSourceControlManager', '');
      if (!manager) return undefined;
      await manager.isInitialized?.catch(() => undefined);

      let repository = manager.getRepository?.(vscode.Uri.file(this.rootPath)) ?? undefined;
      if (!repository && typeof manager.tryOpenRepository === 'function') {
        await manager.tryOpenRepository(this.rootPath).catch(() => undefined);
        repository = manager.getRepository?.(vscode.Uri.file(this.rootPath)) ?? undefined;
      }
      if (repository) return repository;

      return manager.repositories?.find(item => {
        const workspaceRoot = item.workspaceRoot ?? item.root;
        return workspaceRoot ? this.isSameOrChildPath(workspaceRoot, this.rootPath) : false;
      });
    } catch {
      return undefined;
    }
  }

  private isSameOrChildPath(parentPath: string, childPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }

  private async getAuthKey(error: unknown, fallback?: string): Promise<string> {
    const fromError = this.getAuthKeyFromText(this.errorText(error));
    if (fromError) return fromError;
    if (fallback) return fallback;
    const fromWorkingCopy = await this.getAuthKeyFromWorkingCopy();
    return fromWorkingCopy ?? this.rootPath;
  }

  private getAuthKeyFromText(text: string): string | undefined {
    const realm = text.match(/Authentication realm:\s*['"]?([^\r\n'"]+)/i)?.[1]?.trim();
    if (realm) return `realm:${realm}`;
    const urlText = text.match(/URL\s+'([^']+)'/i)?.[1]
      ?? text.match(/repository at URL\s+'([^']+)'/i)?.[1];
    return urlText ? this.normalizeAuthKey(urlText) : undefined;
  }

  private normalizeAuthKey(urlText: string): string {
    try {
      const url = new URL(urlText);
      // Credentials can differ between repositories/realms on the same host.
      // Retain the repository path so a login for one repository is never sent
      // optimistically to another repository hosted beside it.
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/$/, '');
    } catch {
      return urlText.replace(/\/$/, '');
    }
  }

  private async getAuthKeyFromWorkingCopy(): Promise<string | undefined> {
    const pending = SvnService.authKeyTasks.get(this.rootPath);
    if (pending) return pending;

    const task = execCli('svn', ['info', '--xml', '--non-interactive'], { cwd: this.rootPath, timeout: 15_000 })
      .then(result => {
        const urlText = textTag(result.stdout, 'root') || textTag(result.stdout, 'url');
        return urlText ? this.normalizeAuthKey(urlText) : undefined;
      })
      .catch(error => this.getAuthKeyFromText(this.errorText(error)))
      .finally(() => {
        SvnService.authKeyTasks.delete(this.rootPath);
      });

    SvnService.authKeyTasks.set(this.rootPath, task);
    return task;
  }

  private async promptForCredentials(authKey: string): Promise<SvnCredentials | undefined> {
    const pending = SvnService.authPromptTasks.get(authKey);
    if (pending) return pending;

    const task = (async () => {
      SvnService.authFailureTimes.delete(authKey);
      const repoName = path.basename(this.rootPath) || this.rootPath;
      const username = await vscode.window.showInputBox({
        title: t('SVN Authentication Required: {0}', repoName),
        prompt: t('Repository {0} ({1}) needs SVN username for {2}', repoName, this.rootPath, authKey),
        placeHolder: t('Username'),
        ignoreFocusOut: true,
      });
      if (username === undefined) return undefined;

      const password = await vscode.window.showInputBox({
        title: t('SVN Authentication Required: {0}', repoName),
        prompt: t('Repository {0} ({1}) needs SVN password for {2}', repoName, this.rootPath, authKey),
        placeHolder: t('Password'),
        password: true,
        ignoreFocusOut: true,
      });
      if (password === undefined) return undefined;

      return { username, password };
    })().finally(() => {
      SvnService.authPromptTasks.delete(authKey);
    });

    SvnService.authPromptTasks.set(authKey, task);
    return task;
  }

  private isAuthPromptSuppressed(authKey: string): boolean {
    const failedAt = SvnService.authFailureTimes.get(authKey);
    return failedAt !== undefined && Date.now() - failedAt < SVN_AUTH_REPROMPT_DELAY_MS;
  }

  private rememberAuthFailure(authKey: string): void {
    SvnService.authFailureTimes.set(authKey, Date.now());
  }

  private unsupported(feature: string): Error {
    return new Error(t('{0} is a Git-only operation and is not available for SVN working copies.', feature));
  }

  private async getInfo(): Promise<SvnInfo> {
    const metadataMtimeMs = this.getWorkingCopyMetadataMtime();
    if (this.infoCache && this.infoCache.metadataMtimeMs === metadataMtimeMs) {
      return this.infoCache.info;
    }
    const raw = await this.svn(['info', '--xml']);
    const info: SvnInfo = {
      url: textTag(raw, 'url'),
      rootUrl: textTag(raw, 'root'),
      relativeUrl: decodeSvnRelativeUrl(textTag(raw, 'relative-url').replace(/^\^\/?/, '')),
      revision: attr(raw.match(/<entry\b[^>]*>/)?.[0] ?? '', 'revision'),
    };
    this.infoCache = { info, metadataMtimeMs };
    return info;
  }

  private clearIncomingStateCache(): void {
    this.incomingStateGeneration++;
    this.incomingStateCache = undefined;
    this.incomingStateTask = undefined;
    this.incomingStateTaskUrl = undefined;
    this.invalidateStatusCache();
  }

  private async getRemoteHeadRevision(): Promise<number | undefined> {
    const raw = await this.svn(['info', '--xml', '-r', 'HEAD'], { timeout: 15_000 });
    return parseInfoRevision(raw);
  }

  private parseRemoteStatus(raw: string): SvnRemoteStatus {
    const entries: SvnRemoteStatusEntry[] = [];
    const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(raw)) !== null) {
      const reposTag = match[2].match(/<repos-status\b([^>]*)\/?\s*>/);
      if (!reposTag) continue;
      const reposItem = attr(reposTag[1], 'item') ?? 'none';
      const reposProps = attr(reposTag[1], 'props') ?? 'none';
      if ((reposItem === 'none' || reposItem === 'normal') && (reposProps === 'none' || reposProps === 'normal')) continue;
      const wcTag = match[2].match(/<wc-status\b([^>]*)\/?\s*>/);
      const rawPath = attr(match[1], 'path') ?? '';
      const normalizedPath = path.isAbsolute(rawPath)
        ? normalizeRelPath(path.relative(this.rootPath, rawPath))
        : normalizeRelPath(rawPath);
      if (!normalizedPath || normalizedPath.startsWith('../')) continue;
      entries.push({
        path: normalizedPath,
        baseRevision: parseRevisionNumber(wcTag ? attr(wcTag[1], 'revision') : undefined),
      });
    }
    const againstTag = raw.match(/<against\b([^>]*)\/?\s*>/);
    return {
      remoteRevision: againstTag ? parseRevisionNumber(attr(againstTag[1], 'revision')) : undefined,
      entries,
    };
  }

  private parseChangedPathsByRevision(raw: string, info: SvnInfo): Map<string, string[]> {
    const pathsByRevision = new Map<string, string[]>();
    const entryRegex = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g;
    let entryMatch: RegExpExecArray | null;
    while ((entryMatch = entryRegex.exec(raw)) !== null) {
      const revision = attr(entryMatch[1], 'revision');
      if (!revision) continue;
      const paths: string[] = [];
      const pathRegex = /<path\b[^>]*>([\s\S]*?)<\/path>/g;
      let pathMatch: RegExpExecArray | null;
      while ((pathMatch = pathRegex.exec(entryMatch[2])) !== null) {
        const workingPath = this.svnPathToWorkingPath(decodeXml(pathMatch[1]), info);
        if (workingPath !== undefined) paths.push(workingPath || '.');
      }
      pathsByRevision.set(revision, paths);
    }
    return pathsByRevision;
  }

  private svnPathsOverlap(left: string, right: string): boolean {
    if (left === '.' || right === '.') return true;
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
  }

  private getEffectiveLocalRevision(info: SvnInfo): number | undefined {
    const infoRevision = parseRevisionNumber(info.revision);
    return this.localRevisionFloor === undefined
      ? infoRevision
      : Math.max(infoRevision ?? 0, this.localRevisionFloor);
  }

  private async resolveEffectiveLocalRevision(info: SvnInfo): Promise<number | undefined> {
    const metadataMtimeMs = this.getWorkingCopyMetadataMtime();
    if (this.localRevisionFloor !== undefined && this.localRevisionMetadataMtimeMs !== metadataMtimeMs) {
      this.localRevisionGeneration++;
      this.localRevisionFloor = undefined;
      this.localRevisionFloorTask = undefined;
      this.clearIncomingStateCache();
    }
    if (this.localRevisionFloor === undefined) {
      if (!this.localRevisionFloorTask) {
        const generation = this.localRevisionGeneration;
        this.localRevisionFloorTask = execCli('svnversion', ['.'], { cwd: this.rootPath, timeout: 15_000 })
          .then(result => {
            const range = result.stdout.trim().match(/^(\d+)(?::(\d+))?/);
            const revision = range ? Number(range[2] ?? range[1]) : undefined;
            if (revision !== undefined && Number.isSafeInteger(revision) && this.localRevisionGeneration === generation) {
              this.localRevisionFloor = Math.max(this.localRevisionFloor ?? 0, revision);
              this.localRevisionMetadataMtimeMs = metadataMtimeMs;
            }
            return this.localRevisionFloor;
          })
          .catch(() => undefined)
          .finally(() => {
            if (this.localRevisionGeneration === generation) this.localRevisionFloorTask = undefined;
          });
      }
      await this.localRevisionFloorTask;
    }
    return this.getEffectiveLocalRevision(info);
  }

  private async getIncomingState(info: SvnInfo, options: { force?: boolean } = {}): Promise<SvnIncomingState> {
    const localRevision = await this.resolveEffectiveLocalRevision(info);
    const cached = this.incomingStateCache;
    if (
      !options.force
      && cached
      && cached.url === info.url
      && cached.localRevision === localRevision
      && Date.now() - cached.checkedAt < SVN_INCOMING_STATE_CACHE_TTL_MS
    ) {
      return cached;
    }
    if (!options.force && Date.now() - this.lastIncomingStateFailureTime < SVN_INCOMING_STATE_FAILURE_RETRY_MS) {
      return cached ?? {
        url: info.url,
        localRevision,
        remoteRevision: undefined,
        behind: 0,
        incomingRevisions: new Set<string>(),
        checkedAt: Date.now(),
      };
    }
    if (this.incomingStateTask && this.incomingStateTaskUrl === info.url) return this.incomingStateTask;
    if (this.incomingStateTask) {
      this.incomingStateGeneration++;
      this.incomingStateTask = undefined;
      this.incomingStateTaskUrl = undefined;
    }

    const generation = this.incomingStateGeneration;
    const task = (async (): Promise<SvnIncomingState> => {
      const remoteStatusRaw = await this.svn(['status', '-u', '--xml'], { timeout: 20_000 });
      const remoteStatus = this.parseRemoteStatus(remoteStatusRaw);
      const remoteRevision = remoteStatus.remoteRevision ?? await this.getRemoteHeadRevision();
      const incomingRevisions = new Set<string>();
      let behind = 0;

      if (remoteStatus.entries.length > 0) {
        try {
          const knownBaseRevisions = remoteStatus.entries
            .map(entry => entry.baseRevision)
            .filter((revision): revision is number => revision !== undefined);
          const rootRevision = parseRevisionNumber(info.revision);
          const needsFallbackBase = remoteStatus.entries.some(entry => entry.baseRevision === undefined);
          const fallbackBase = Math.min(
            ...knownBaseRevisions,
            ...(!needsFallbackBase || rootRevision === undefined ? [] : [rootRevision]),
          );
          if (Number.isFinite(fallbackBase)) {
            const raw = await this.svn(['log', '--xml', '-v', '-r', `${fallbackBase + 1}:HEAD`], { timeout: 20_000 });
            for (const [revisionText, changedPaths] of this.parseChangedPathsByRevision(raw, info)) {
              const revision = parseRevisionNumber(revisionText);
              if (revision === undefined) continue;
              const affectsOutdatedPath = remoteStatus.entries.some(entry => {
                const baseRevision = entry.baseRevision ?? fallbackBase;
                return revision > baseRevision
                  && changedPaths.some(changedPath => this.svnPathsOverlap(changedPath, entry.path));
              });
              if (affectsOutdatedPath) incomingRevisions.add(revisionText);
            }
          }
          behind = incomingRevisions.size;
          if (behind === 0) behind = 1;
        } catch {
          behind = 1;
        }
      }

      const state: SvnIncomingState = {
        url: info.url,
        localRevision,
        remoteRevision,
        behind,
        incomingRevisions,
        checkedAt: Date.now(),
      };
      if (this.incomingStateGeneration === generation) {
        this.incomingStateCache = state;
        this.lastIncomingStateFailureTime = 0;
      }
      return state;
    })();

    this.incomingStateTask = task;
    this.incomingStateTaskUrl = info.url;
    try {
      return await task;
    } catch (error) {
      this.lastIncomingStateFailureTime = Date.now();
      throw error;
    } finally {
      if (this.incomingStateTask === task) {
        this.incomingStateTask = undefined;
        this.incomingStateTaskUrl = undefined;
      }
    }
  }

  private normalizeSvnTarget(filePath: string): string {
    const resolved = resolvePathWithinRepo(this.rootPath, filePath, { allowAbsolute: true, allowRoot: true });
    return resolved.relativePath || '.';
  }

  private workingCopyTarget(filePath: string): string {
    return escapePegRevision(this.normalizeSvnTarget(filePath));
  }

  private workingCopyDiffTarget(filePath: string): string {
    // Unlike revision/URL forms of `svn diff`, the WC-vs-BASE form does not
    // parse peg revisions. Appending the usual empty `@` escape would make the
    // suffix a literal filename and break paths that contain `@`.
    return this.normalizeSvnTarget(filePath);
  }

  private prepareWorkingFileWrite(absolutePath: string): void {
    this.assertSafeWorkingFsPath(absolutePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    try {
      if (fs.lstatSync(absolutePath).isSymbolicLink()) fs.unlinkSync(absolutePath);
    } catch { /* target does not exist */ }
  }

  private async copyExportedNodeToWorkingCopy(exportedPath: string, absolutePath: string): Promise<void> {
    this.assertSafeWorkingFsPath(absolutePath);
    await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
    const exportedStat = await fs.promises.lstat(exportedPath);
    let currentStat: fs.Stats | undefined;
    try { currentStat = await fs.promises.lstat(absolutePath); } catch { /* target does not exist */ }

    if (exportedStat.isSymbolicLink()) {
      if (currentStat) await fs.promises.rm(absolutePath, { recursive: true, force: true });
      await fs.promises.symlink(await fs.promises.readlink(exportedPath), absolutePath);
      return;
    }

    if (exportedStat.isDirectory()) {
      if (currentStat && (!currentStat.isDirectory() || currentStat.isSymbolicLink())) {
        await fs.promises.rm(absolutePath, { recursive: true, force: true });
      }
      await fs.promises.cp(exportedPath, absolutePath, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });
      await fs.promises.chmod(absolutePath, exportedStat.mode & 0o777);
      return;
    }

    if (currentStat?.isDirectory() || currentStat?.isSymbolicLink()) {
      await fs.promises.rm(absolutePath, { recursive: true, force: true });
    }
    await fs.promises.copyFile(exportedPath, absolutePath);
    await fs.promises.chmod(absolutePath, exportedStat.mode & 0o777);
  }

  private readWorkingFile(absolutePath: string): { content: string; isBinary: boolean } | undefined {
    this.assertSafeWorkingFsPath(absolutePath);
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) return undefined;
      const buffer = stat.isSymbolicLink()
        ? fs.readlinkSync(absolutePath, { encoding: 'buffer' })
        : stat.size > SVN_MAX_INLINE_DIFF_FILE_BYTES
          ? undefined
          : fs.readFileSync(absolutePath);
      if (!buffer) return { content: '', isBinary: true };
      const decoded = buffer.toString('utf8');
      const content = stat.isSymbolicLink() ? `link ${decoded}` : decoded;
      const isBinary = buffer.includes(0) || !Buffer.from(decoded, 'utf8').equals(buffer);
      return { content: isBinary ? '' : content, isBinary };
    } catch {
      return undefined;
    }
  }

  private assertSafeWorkingFsPath(absolutePath: string): void {
    const resolved = resolvePathWithinRepo(this.rootPath, absolutePath, { allowAbsolute: true, allowRoot: true });
    const segments = resolved.relativePath.split('/').filter(Boolean);
    let cursor = path.resolve(this.rootPath);
    for (const segment of segments.slice(0, -1)) {
      cursor = path.join(cursor, segment);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(cursor); } catch { break; }
      if (stat.isSymbolicLink()) throw new Error(t('Path is outside the repository: {0}', absolutePath));
    }
  }

  private normalizeRefName(value: string, namespace: 'branches' | 'tags'): string {
    const name = value.startsWith(`${namespace}/`) ? value.slice(namespace.length + 1) : value;
    if (!name || name.includes('\0') || /[\r\n]/.test(name)) {
      throw new Error(t('Invalid SVN {0} name: {1}', namespace === 'branches' ? t('branch') : t('tag'), value));
    }
    // This adapter models the conventional one-directory-per-branch/tag SVN
    // layout. Accepting nested names such as feature/foo is ambiguous with a
    // subdirectory inside branch "feature" and makes list/switch/delete target
    // different repository paths, so reject it at the boundary.
    if (name.includes('/') || name === '.' || name === '..' || name.includes('\\')) {
      throw new Error(t('Invalid SVN {0} name: {1}', namespace === 'branches' ? t('branch') : t('tag'), value));
    }
    return name;
  }

  private encodeRepositoryPath(value: string): string {
    return value.split('/').map(segment => encodeURIComponent(segment)).join('/');
  }

  private repositoryRefTarget(value: string, defaultNamespace: 'branches' | 'tags' = 'branches'): string {
    if (/^\^\//.test(value)) {
      if (value.endsWith('@')) return value;
      return decodeSvnRelativeUrl(value).includes('@') ? `${value}@` : value;
    }
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      return escapePegRevision(value);
    }
    if (value === 'trunk') return '^/trunk@';
    if (value.startsWith('branches/')) {
      return `^/branches/${this.encodeRepositoryPath(this.normalizeRefName(value, 'branches'))}@`;
    }
    if (value.startsWith('tags/')) {
      return `^/tags/${this.encodeRepositoryPath(this.normalizeRefName(value, 'tags'))}@`;
    }
    const name = this.normalizeRefName(value, defaultNamespace);
    return `^/${defaultNamespace}/${this.encodeRepositoryPath(name)}@`;
  }

  private repositoryFileTarget(repositoryUrl: string, relPath: string, pegRevision: string): string {
    const encodedPath = this.encodeRepositoryPath(relPath);
    const url = encodedPath ? `${repositoryUrl.replace(/\/$/, '')}/${encodedPath}` : repositoryUrl;
    return `${url}@${pegRevision}`;
  }

  private repositoryFileTargets(repositoryUrl: string, relPath: string, operativeRevision: string): string[] {
    // A stable peg is required to follow copy history. For a file inherited
    // from trunk, branch/file@rN does not exist before the branch copy, while
    // branch/file@HEAD correctly traces ancestry to trunk@rN. The operative
    // revision remains a fallback for paths that were later deleted.
    const numericRevision = parseRevisionNumber(operativeRevision);
    return Array.from(new Set([
      this.repositoryFileTarget(repositoryUrl, relPath, 'HEAD'),
      this.repositoryFileTarget(repositoryUrl, relPath, operativeRevision),
      ...(numericRevision !== undefined && numericRevision > 0
        ? [this.repositoryFileTarget(repositoryUrl, relPath, String(numericRevision - 1))]
        : []),
    ]));
  }

  private repositoryUrlToWorkingPath(targetUrl: string, info: SvnInfo): string | undefined {
    try {
      const target = new URL(targetUrl);
      const root = new URL(info.url);
      if (target.protocol !== root.protocol || target.host !== root.host) return undefined;
      const decodeSegments = (pathname: string): string[] => pathname
        .split('/')
        .filter(Boolean)
        .map(segment => {
          try { return decodeURIComponent(segment); } catch { return segment; }
        });
      const targetSegments = decodeSegments(target.pathname);
      const rootSegments = decodeSegments(root.pathname);
      if (rootSegments.some((segment, index) => targetSegments[index] !== segment)) return undefined;
      return targetSegments.slice(rootSegments.length).join('/');
    } catch {
      const root = info.url.replace(/\/$/, '');
      if (targetUrl === root) return '';
      return targetUrl.startsWith(`${root}/`)
        ? decodeSvnRelativeUrl(targetUrl.slice(root.length + 1))
        : undefined;
    }
  }

  private async getRepositoryUrl(): Promise<string> {
    const metadataMtimeMs = this.getWorkingCopyMetadataMtime();
    if (this.repositoryUrlCache && this.repositoryUrlCache.metadataMtimeMs === metadataMtimeMs) {
      return this.repositoryUrlCache.url;
    }
    const info = await this.getInfo();
    this.repositoryUrlCache = { url: info.url, metadataMtimeMs };
    return info.url;
  }

  private getWorkingCopyMetadataMtime(): number | undefined {
    try { return fs.statSync(path.join(this.rootPath, '.svn', 'wc.db')).mtimeMs; } catch { return undefined; }
  }

  private parseListEntries(raw: string): SvnListEntry[] {
    const entries: SvnListEntry[] = [];
    const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(raw)) !== null) {
      const name = textTag(match[2], 'name', false);
      if (!name) continue;
      const commitTag = match[2].match(/<commit\b([^>]*)>([\s\S]*?)<\/commit>/);
      entries.push({
        name,
        kind: attr(match[1], 'kind'),
        revision: commitTag ? attr(commitTag[1], 'revision') : undefined,
        date: commitTag ? textTag(commitTag[2], 'date') : '',
      });
    }
    return entries;
  }

  private async writeTargets(paths: string[]): Promise<string> {
    const filePath = path.join(os.tmpdir(), `versiondock-svn-targets-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await fs.promises.writeFile(filePath, paths.join('\n'), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return filePath;
  }

  private async runWithTargets(args: string[], paths: string[]): Promise<string> {
    const targets = Array.from(new Set(paths.map(filePath => this.workingCopyTarget(filePath))));
    if (targets.length === 0) throw new Error(t('No SVN paths selected.'));
    if (targets.some(target => /[\r\n]/.test(target) || target !== target.trim())) {
      return this.svn([...args, '--', ...targets]);
    }
    const targetFile = await this.writeTargets(targets);
    try {
      return await this.svn([...args, '--targets', targetFile]);
    } finally {
      await fs.promises.unlink(targetFile).catch(() => undefined);
    }
  }

  private async changedPaths(): Promise<string[]> {
    const files = await this.parseSvnStatus();
    const paths = new Set<string>();
    files.forEach(file => paths.add(file.path));
    return Array.from(paths);
  }

  private isConflictArtifact(filePath: string, conflictPaths: string[]): boolean {
    return conflictPaths.some(conflictPath => {
      const normalizedConflictPath = conflictPath === '.' ? '' : conflictPath.replace(/\/+$/, '');
      const directoryPropertyArtifact = normalizedConflictPath
        ? normalizedConflictPath + '/dir_conflicts.prej'
        : 'dir_conflicts.prej';
      if (filePath === directoryPropertyArtifact) return true;
      return new RegExp(
        '^' + escapeRegExp(conflictPath) + '(?:\\.mine|\\.working|\\.prej|\\.r\\d+|\\.merge-(?:left|right)\\.r\\d+)$',
      ).test(filePath);
    });
  }

  private parseSvnIniGlobalIgnores(content: string): string[] | null {
    const lines = content.split(/\r?\n/);
    let isCollecting = false;
    let found = false;
    const values: string[] = [];

    for (const line of lines) {
      const isIndented = /^[ \t]+/.test(line);
      const trimmed = line.trim();

      if (!trimmed) {
        isCollecting = false;
        continue;
      }

      // 处于续行收集状态时，只要该行有前导缩进，即作为值的延续（保留模式内的 # 或 ; 字符）
      if (isCollecting && isIndented) {
        values.push(...trimmed.split(/\s+/).filter(Boolean));
        continue;
      }

      // Section 标签行
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        isCollecting = false;
        continue;
      }

      // 非缩进的整行注释行：SVN 注释仅在行首以 # 或 ; 开头
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
        isCollecting = false;
        continue;
      }

      // 匹配 global-ignores 键
      const match = line.match(/^[ \t]*global-ignores[ \t]*=[ \t]*(.*)$/i);
      if (match) {
        found = true;
        isCollecting = true;
        const lineVal = match[1].trim();
        if (lineVal) {
          values.push(...lineVal.split(/\s+/).filter(Boolean));
        }
        continue;
      }

      // 遇到其他未缩进配置项，结束当前收集
      isCollecting = false;
    }

    return found ? values : null;
  }

  private getClientGlobalIgnores(): string[] {
    const defaultIgnores = [
      '*.o',
      '*.lo',
      '*.la',
      '*.al',
      '.libs',
      '*.so',
      '*.so.[0-9]*',
      '*.a',
      '*.pyc',
      '*.pyo',
      '__pycache__',
      '*.rej',
      '*~',
      '#*#',
      '.#*',
      '.*.swp',
      '.DS_Store',
      '[Tt]humbs.db',
    ];
    try {
      const homeDir = os.homedir();
      const configPaths = [
        path.join(homeDir, '.subversion', 'config'),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'Subversion', 'config')] : []),
      ];
      for (const configPath of configPaths) {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          const parsed = this.parseSvnIniGlobalIgnores(content);
          // 若配置文件显式配置了 global-ignores（即使是空值），遵循 SVN 语义直接返回，禁用内置默认规则
          if (parsed !== null) return parsed;
        }
      }
    } catch {
      // 忽略读取系统配置异常，回退默认规则
    }
    return defaultIgnores;
  }

  private async getInheritedGlobalIgnores(): Promise<Array<{ dirRelPath: string; patterns: string[] }>> {
    const raw = await this.svn(['propget', 'svn:global-ignores', '--show-inherited-props', '--xml', '-R', '--', '.']).catch(() => '');
    const results: Array<{ dirRelPath: string; patterns: string[] }> = [];
    const targetRegex = /<target\b([^>]*)>([\s\S]*?)<\/target>/g;
    let match: RegExpExecArray | null;
    while ((match = targetRegex.exec(raw)) !== null) {
      const propRegex = /<(?:property|inherited_property)\b([^>]*)>([\s\S]*?)<\/(?:property|inherited_property)>/g;
      let propMatch: RegExpExecArray | null;
      while ((propMatch = propRegex.exec(match[2])) !== null) {
        if (attr(propMatch[1], 'name') !== 'svn:global-ignores') continue;
        const patterns = splitIgnoreLines(decodeXml(propMatch[2]));
        if (patterns.length === 0) continue;

        const isInheritedTag = propMatch[0].startsWith('<inherited_property');
        const rawPath = attr(match[1], 'path') ?? '';
        let safeDir = '';
        if (!isInheritedTag && rawPath && !rawPath.includes('://')) {
          let normalizedDir = rawPath;
          if (path.isAbsolute(rawPath)) {
            normalizedDir = path.relative(this.rootPath, rawPath);
          }
          const rel = normalizeRelPath(normalizedDir);
          safeDir = rel === '.' ? '' : rel;
        }
        // 若为 inherited_property 或 target 为父级 URL/外部路径，其作用域覆盖当前检出根（即 dirRelPath: ''）
        results.push({ dirRelPath: safeDir, patterns });
      }
    }
    return results;
  }

  private isIgnoredBySvnRules(
    relPath: string,
    entryName: string,
    clientGlobalIgnores: string[],
    inheritedIgnores: Array<{ dirRelPath: string; patterns: string[] }>,
  ): boolean {
    if (entryName === '.svn') return true;

    for (const pattern of clientGlobalIgnores) {
      if (matchSvnGlob(pattern, entryName)) return true;
    }

    for (const inherited of inheritedIgnores) {
      const prefix = inherited.dirRelPath ? `${inherited.dirRelPath}/` : '';
      if (!inherited.dirRelPath || relPath.startsWith(prefix) || relPath === inherited.dirRelPath) {
        for (const pattern of inherited.patterns) {
          if (matchSvnGlob(pattern, entryName)) return true;
        }
      }
    }

    return false;
  }

  private async collectUnversionedDirFiles(
    dirRelPath: string,
    clientGlobalIgnores: string[],
    inheritedIgnores: Array<{ dirRelPath: string; patterns: string[] }>,
    maxEntries = 500,
    maxDepth = 8,
  ): Promise<{ files: string[]; truncated: boolean; truncationReason?: 'entry-limit' | 'depth-limit' }> {
    const results: string[] = [];
    let count = 0;
    let visitedEntries = 0;
    let truncated = false;
    let truncationReason: 'entry-limit' | 'depth-limit' | undefined;

    const walk = async (currentRel: string, depth: number) => {
      if (depth > maxDepth) {
        truncated = true;
        truncationReason = truncationReason ?? 'depth-limit';
        return;
      }
      if (count >= maxEntries || visitedEntries >= maxEntries) {
        truncated = true;
        truncationReason = truncationReason ?? 'entry-limit';
        return;
      }
      const currentAbs = path.join(this.rootPath, currentRel);
      let entries: fs.Dirent[] = [];
      try {
        entries = await fs.promises.readdir(currentAbs, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (count >= maxEntries || visitedEntries >= maxEntries) {
          truncated = true;
          truncationReason = truncationReason ?? 'entry-limit';
          break;
        }
        const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;
        if (this.isIgnoredBySvnRules(childRel, entry.name, clientGlobalIgnores, inheritedIgnores)) {
          continue;
        }
        visitedEntries++;
        // 符号链接绝不递归进入；嵌套 VCS 目录（.git/.hg，含大小写变体）作为可见但不递归的危险目录节点收集，绝不递归展开其内部 objects
        const lowerName = entry.name.toLowerCase();
        const isNestedVcs = lowerName === '.git' || lowerName === '.hg';
        if (entry.isDirectory() && !entry.isSymbolicLink() && !isNestedVcs) {
          await walk(childRel, depth + 1);
        } else {
          results.push(childRel);
          count++;
        }
      }
    };

    await walk(dirRelPath, 1);
    return { files: results, truncated, truncationReason };
  }

  private async parseSvnStatus(): Promise<SvnStatusEntry[]> {
    const [raw, inheritedIgnores] = await Promise.all([
      this.svn(['status', '--xml']),
      this.getInheritedGlobalIgnores().catch(() => []),
    ]);
    const clientGlobalIgnores = this.getClientGlobalIgnores();

    const rawEntries: Array<{
      filePath: string;
      absolutePath: string;
      status: GitFileStatus;
      item: string;
      props?: string;
      copied: boolean;
      treeConflicted: boolean;
    }> = [];

    const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(raw)) !== null) {
      const rawPath = attr(match[1], 'path') ?? '';
      const normalizedPath = path.isAbsolute(rawPath)
        ? normalizeRelPath(path.relative(this.rootPath, rawPath))
        : normalizeRelPath(rawPath);
      const filePath = normalizedPath === '' ? '.' : normalizedPath;
      if (!filePath) continue;
      const wcTag = match[2].match(/<wc-status\b([^>]*)\/?>/);
      if (!wcTag) continue;
      const item = attr(wcTag[1], 'item') ?? 'normal';
      const props = attr(wcTag[1], 'props');
      const copied = attr(wcTag[1], 'copied') === 'true';
      const treeConflicted = attr(wcTag[1], 'tree-conflicted') === 'true';
      const status = treeConflicted ? 'conflicted' : copied && item === 'added' ? 'copied' : svnItemToStatus(item, props);
      if (!status) continue;

      const absolutePath = filePath === '.' ? this.rootPath : path.join(this.rootPath, filePath);
      rawEntries.push({
        filePath,
        absolutePath,
        status,
        item,
        props,
        copied,
        treeConflicted,
      });
    }

    const files: SvnStatusEntry[] = [];

    for (const entry of rawEntries) {
      // SVN 原生 status 对未受控目录不会递归输出内部文件。
      // 若未受控条目是本地目录，异步探测内部文件（遵循 SVN 忽略规则并设置数量与深度上限）并展开为 untracked 文件条目。
      if (entry.item === 'unversioned' && entry.filePath !== '.') {
        let isRealDirectory = false;
        try {
          const lstat = await fs.promises.lstat(entry.absolutePath);
          // 符号链接（无论指向文件还是外部目录）绝不递归展开，作为单个独立条目保留，防止扫描仓库外导致 E195015
          if (!lstat.isSymbolicLink() && lstat.isDirectory()) {
            isRealDirectory = true;
          }
        } catch {
          isRealDirectory = false;
        }
        if (isRealDirectory) {
          const { files: childFiles, truncated, truncationReason } = await this.collectUnversionedDirFiles(
            entry.filePath,
            clientGlobalIgnores,
            inheritedIgnores,
          );
          if (childFiles.length > 0) {
            for (const childRel of childFiles) {
              files.push({
                repoId: this.repoId,
                path: childRel,
                absolutePath: path.join(this.rootPath, childRel),
                status: 'untracked',
                staged: false,
                unstaged: true,
                svnItem: 'unversioned',
                svnProps: entry.props,
                svnCopied: false,
                treeConflicted: entry.treeConflicted,
              });
            }
          }

          if (truncated) {
            // 发生截断时，既保留已扫描出的前 maxEntries 个子文件供用户选择性添加，
            // 又保留标记 isTruncated: true 的父目录节点以供受控全量添加入口
            files.push({
              repoId: this.repoId,
              path: entry.filePath,
              absolutePath: entry.absolutePath,
              status: entry.status,
              staged: false,
              unstaged: true,
              svnItem: entry.item,
              svnProps: entry.props,
              svnCopied: entry.copied,
              treeConflicted: entry.treeConflicted,
              isTruncated: true,
              truncationReason,
            });
          }

          if (childFiles.length > 0 || truncated) {
            continue;
          }
        }
      }

      files.push({
        repoId: this.repoId,
        path: entry.filePath,
        absolutePath: entry.absolutePath,
        status: entry.status,
        staged: false,
        unstaged: true,
        svnItem: entry.item,
        svnProps: entry.props,
        svnCopied: entry.copied,
        treeConflicted: entry.treeConflicted,
      });
    }

    const conflictPaths = files.filter(file => file.status === 'conflicted').map(file => file.path);
    const nonConflictFiles = files.filter(
      file => file.status !== 'untracked' || !this.isConflictArtifact(file.path, conflictPaths)
    );

    // 构建所有非冲突条目的祖先目录前缀集合，用于在 O(N) 时间内快速判断某目录是否已有子孙文件/子条目
    const ancestorDirs = new Set<string>();
    for (const f of nonConflictFiles) {
      let p = f.path;
      let slashIdx = p.lastIndexOf('/');
      while (slashIdx > 0) {
        p = p.slice(0, slashIdx);
        if (ancestorDirs.has(p)) break;
        ancestorDirs.add(p);
        slashIdx = p.lastIndexOf('/');
      }
    }

    const resultFiles = nonConflictFiles.filter(file => {
      if (file.path === '.') return true;

      // 必须完整保留所有真实的受控目录状态变更（属性修改、树冲突、已添加、已删除、已修改等），
      // 严禁将真实版本化目录从结果中移除，以保证属性修改/树冲突可操作，避免提交时引发 E200009。
      const isRealVersionedEntry =
        file.treeConflicted ||
        file.status === 'conflicted' ||
        (file.svnProps && file.svnProps !== 'none') ||
        file.svnItem === 'added' ||
        file.svnItem === 'modified' ||
        file.svnItem === 'deleted' ||
        file.status !== 'untracked';

      if (isRealVersionedEntry) {
        return true;
      }

      // 如果是被截断的未受控父目录，即使它有展开的子条目，也必须保留该截断父目录节点自身，
      // 供用户直观感知截断状态并提供受控递归添加入口
      if (file.isTruncated) {
        return true;
      }

      // 仅针对完全展开的未受控目录条目：如果列表中已经包含了其展开的全部子孙条目，则移除该未受控目录条目自身，
      // 避免树形组件中出现同名叶子节点；纯空未受控目录予以保留。
      if (ancestorDirs.has(file.path)) {
        return false;
      }

      return true;
    });

    return resultFiles.sort((left, right) => left.path.localeCompare(right.path));
  }

  private normalizeIgnoreTarget(entryPath: string): { directoryPath: string; entry: string; fullPath: string } {
    const relPath = this.normalizeRepoPath(entryPath).replace(/\/+$/, '');
    if (!relPath || relPath === '.') {
      throw new Error(t('SVN ignore target cannot be empty.'));
    }
    const entry = path.posix.basename(relPath);
    if (/[\r\n]/.test(entry)) {
      throw new Error(t('SVN ignore entries cannot contain line breaks.'));
    }
    const parent = path.posix.dirname(relPath);
    const directoryPath = parent === '.' ? '' : parent;
    return {
      directoryPath,
      entry,
      fullPath: directoryPath ? `${directoryPath}/${entry}` : entry,
    };
  }

  private async ensureSvnIgnoreParent(directoryPath: string, fullPath: string): Promise<void> {
    const target = directoryPath || '.';
    const absolutePath = path.join(this.rootPath, target);
    if (fs.existsSync(absolutePath) && !fs.statSync(absolutePath).isDirectory()) {
      throw new Error(t('SVN ignore parent "{0}" is not a directory.', target));
    }
    try {
      await this.svn(['info', '--xml', '--', this.workingCopyTarget(target)]);
    } catch {
      throw new Error(t('SVN ignore can only be set on a versioned parent directory. Ignore "{0}" or add its parent directory first.', fullPath));
    }
  }

  private async getSvnIgnoreLines(directoryPath: string): Promise<string[]> {
    const target = this.workingCopyTarget(directoryPath || '.');
    const raw = await this.svn(['propget', 'svn:ignore', '--', target]).catch(() => '');
    return splitIgnoreLines(raw);
  }

  private async setSvnIgnoreLines(directoryPath: string, lines: string[]): Promise<void> {
    const target = this.workingCopyTarget(directoryPath || '.');
    const normalized = Array.from(new Set(lines.filter(line => line.length > 0)));
    if (normalized.length === 0) {
      await this.svn(['propdel', 'svn:ignore', '--', target]);
      return;
    }
    const propertyFile = path.join(os.tmpdir(), `versiondock-svn-ignore-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    await fs.promises.writeFile(propertyFile, `${normalized.join('\n')}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await this.svn(['propset', 'svn:ignore', '-F', propertyFile, '--', target]);
    } finally {
      await fs.promises.unlink(propertyFile).catch(() => undefined);
    }
  }

  async addIgnoreEntry(entryPath: string): Promise<SvnIgnoreUpdateResult> {
    const target = this.normalizeIgnoreTarget(entryPath);
    await this.ensureSvnIgnoreParent(target.directoryPath, target.fullPath);

    const existing = await this.getSvnIgnoreLines(target.directoryPath);
    if (existing.includes(target.entry)) {
      return { ...target, alreadyExists: true };
    }

    await this.setSvnIgnoreLines(target.directoryPath, [...existing, target.entry]);
    return { ...target, alreadyExists: false };
  }

  async listIgnoreEntries(): Promise<SvnIgnoreEntry[]> {
    const raw = await this.svn(['propget', 'svn:ignore', '--xml', '-R', '--', '.']).catch(() => '');
    const entries: SvnIgnoreEntry[] = [];
    const targetRegex = /<target\b([^>]*)>([\s\S]*?)<\/target>/g;
    let match: RegExpExecArray | null;
    while ((match = targetRegex.exec(raw)) !== null) {
      const propertyMatch = match[2].match(/<property\b([^>]*)>([\s\S]*?)<\/property>/);
      if (!propertyMatch || attr(propertyMatch[1], 'name') !== 'svn:ignore') continue;
      const rawPath = attr(match[1], 'path') ?? '';
      let normalizedDirectoryPath = rawPath;
      if (path.isAbsolute(rawPath)) {
        try {
          const realRoot = fs.realpathSync.native(this.rootPath);
          const realTarget = fs.realpathSync.native(rawPath);
          normalizedDirectoryPath = path.relative(realRoot, realTarget);
        } catch {
          normalizedDirectoryPath = path.relative(this.rootPath, rawPath);
        }
      }
      const safeDirectoryPath = this.normalizeSvnTarget(normalizedDirectoryPath || '.');
      const directoryPath = safeDirectoryPath === '.' ? '' : safeDirectoryPath.replace(/\/+$/, '');
      for (const entry of splitIgnoreLines(decodeXml(propertyMatch[2]))) {
        entries.push({
          directoryPath,
          entry,
          fullPath: directoryPath ? `${directoryPath}/${entry}` : entry,
        });
      }
    }
    return entries.sort((left, right) => left.fullPath.localeCompare(right.fullPath));
  }

  async removeIgnoreEntries(entries: SvnIgnoreEntry[]): Promise<void> {
    const byDirectory = new Map<string, Set<string>>();
    for (const item of entries) {
      const normalizedDirectory = this.normalizeSvnTarget(item.directoryPath || '.');
      const directoryPath = normalizedDirectory === '.' ? '' : normalizedDirectory.replace(/\/+$/, '');
      const group = byDirectory.get(directoryPath) ?? new Set<string>();
      group.add(item.entry);
      byDirectory.set(directoryPath, group);
    }

    for (const [directoryPath, removals] of byDirectory) {
      const existing = await this.getSvnIgnoreLines(directoryPath);
      const remaining = existing.filter(line => !removals.has(line));
      await this.setSvnIgnoreLines(directoryPath, remaining);
    }
  }

  private displayRef(info: SvnInfo): { name: string; detachedTag?: string } {
    const rel = info.relativeUrl.replace(/^\/+/, '');
    if (!rel) return { name: path.basename(info.url) || 'SVN' };
    if (rel === 'trunk' || rel.startsWith('trunk/')) return { name: 'trunk' };
    const branch = rel.match(/^branches\/([^/]+)/);
    if (branch) return { name: branch[1] };
    const tag = rel.match(/^tags\/([^/]+)/);
    if (tag) return { name: `tags/${tag[1]}`, detachedTag: tag[1] };
    return { name: rel };
  }

  private svnPathToWorkingPath(svnPath: string, info: SvnInfo): string | undefined {
    const relRoot = `/${info.relativeUrl.replace(/^\/+/, '')}`.replace(/\/$/, '');
    const normalized = svnPath.startsWith('/') ? svnPath : `/${svnPath}`;
    if (relRoot !== '/' && normalized.startsWith(`${relRoot}/`)) {
      return normalizeRelPath(normalized.slice(relRoot.length + 1));
    }
    if (relRoot !== '/' && normalized === relRoot) return '';
    if (relRoot !== '/') return undefined;
    return normalizeRelPath(normalized.replace(/^\/+/, ''));
  }

  private matchesRefFilter(info: SvnInfo, filterBranch?: string): boolean {
    const filter = filterBranch?.replace(/^origin\//, '').replace(/^\/+/, '');
    if (!filter) return true;
    const ref = this.displayRef(info);
    const relative = info.relativeUrl.replace(/^\/+/, '');
    const strippedFilter = filter.replace(/^branches\//, '').replace(/^tags\//, '');
    return ref.name === filter
      || ref.name === strippedFilter
      || ref.detachedTag === filter
      || ref.detachedTag === strippedFilter
      || relative === filter
      || relative === strippedFilter
      || info.url.endsWith(`/${filter}`)
      || info.url.endsWith(`/${strippedFilter}`);
  }

  async isGitRepo(): Promise<boolean> {
    return true;
  }

  async getCurrentBranch(options?: { probeIncoming?: boolean }): Promise<BranchInfo> {
    const info = await this.getInfo();
    const ref = this.displayRef(info);
    let incoming = this.incomingStateCache;
    const localRevision = incoming?.localRevision ?? this.getEffectiveLocalRevision(info);

    if (options?.probeIncoming) {
      incoming = await this.getIncomingState(info).catch(() => incoming);
    } else if (
      !incoming
      || incoming.url !== info.url
      || incoming.localRevision !== localRevision
      || Date.now() - incoming.checkedAt >= SVN_INCOMING_STATE_CACHE_TTL_MS
    ) {
      void this.getIncomingState(info).then(freshIncoming => {
        if (freshIncoming.behind !== (incoming?.behind ?? 0)) {
          void this.refreshStatus?.();
        }
      }).catch(() => {});
    }

    const behind = incoming?.behind ?? 0;
    const effectiveRevision = incoming?.localRevision ?? localRevision;
    return {
      repoId: this.repoId,
      name: ref.name,
      fullName: info.url,
      isHead: true,
      isRemote: false,
      upstream: info.rootUrl,
      aheadBehind: behind > 0 ? { ahead: 0, behind } : undefined,
      detachedTag: ref.detachedTag,
      lastCommitHash: effectiveRevision !== undefined ? `r${effectiveRevision}` : undefined,
    };
  }

  getCachedBranch(): BranchInfo | undefined {
    if (!this.infoCache) return undefined;
    const info = this.infoCache.info;
    const ref = this.displayRef(info);
    const localRevision = this.incomingStateCache?.localRevision ?? this.getEffectiveLocalRevision(info);
    return {
      repoId: this.repoId,
      name: ref.name,
      fullName: info.url,
      isHead: true,
      isRemote: false,
      upstream: info.rootUrl,
      detachedTag: ref.detachedTag,
      lastCommitHash: localRevision !== undefined ? `r${localRevision}` : undefined,
    };
  }

  override async captureUpdateSnapshot(branchName?: string): Promise<VcsUpdateSnapshot | undefined> {
    const info = await this.getInfo();
    const current = this.displayRef(info);
    if (branchName && branchName !== current.name) return undefined;

    const incoming = await this.getIncomingState(info, { force: true }).catch(() => undefined);
    const beforeRevision = incoming?.localRevision ?? await this.resolveEffectiveLocalRevision(info);
    return {
      kind: 'svn',
      repoId: this.repoId,
      branchName: current.name,
      workingCopyUrl: info.url,
      beforeRevision,
      incomingHashes: Array.from(incoming?.incomingRevisions ?? [])
        .map(revision => `r${revision}`),
    } satisfies SvnUpdateSnapshot;
  }

  override async getUpdateCommitHashes(snapshot: VcsUpdateSnapshot): Promise<string[]> {
    if (snapshot.kind !== 'svn' || snapshot.repoId !== this.repoId) return [];

    const info = await this.getInfo();
    if (info.url !== snapshot.workingCopyUrl) return [];
    const afterRevision = await this.resolveEffectiveLocalRevision(info);
    if (afterRevision === undefined) return [];

    const revisions = new Set<number>();
    for (const hash of snapshot.incomingHashes) {
      const revision = parseRevisionNumber(hash);
      if (revision !== undefined && revision <= afterRevision) revisions.add(revision);
    }

    if (revisions.size === 0 && snapshot.beforeRevision !== undefined && afterRevision > snapshot.beforeRevision) {
      const raw = await this.svn([
        'log',
        '--xml',
        '-r',
        `${snapshot.beforeRevision + 1}:${afterRevision}`,
      ]);
      for (const entry of this.parseLogEntries(raw)) {
        const revision = parseRevisionNumber(entry.revision);
        if (revision !== undefined) revisions.add(revision);
      }
    }

    return Array.from(revisions)
      .sort((left, right) => right - left)
      .map(revision => `r${revision}`);
  }

  async getBranches(options?: { force?: boolean }): Promise<BranchInfo[]> {
    const staleBranchesCache = this.remoteBranchesCache;
    if (options?.force) {
      this.remoteBranchesGeneration++;
      this.remoteBranchesCache = undefined;
      this.remoteBranchesTask = undefined;
    }
    if (this.remoteBranchesTask) return this.remoteBranchesTask;
    const taskGen = this.remoteBranchesGeneration;
    const task = (async (): Promise<BranchInfo[]> => {
      const current = await this.getCurrentBranch();
      const branches: BranchInfo[] = [current];
      const addBranch = (name: string) => {
        if (branches.some(branch => branch.name === name && !branch.isRemote)) return;
        branches.push({
          repoId: this.repoId,
          name,
          fullName: name === 'trunk' ? '^/trunk' : this.repositoryRefTarget(name, 'branches'),
          isHead: current.name === name,
          isRemote: false,
        });
      };
      if (
        this.remoteBranchesCache
        && Date.now() - this.remoteBranchesCache.timestamp < SVN_REMOTE_BRANCHES_CACHE_TTL_MS
      ) {
        if (this.remoteBranchesCache.hasTrunk) addBranch('trunk');
        this.remoteBranchesCache.branches.forEach(name => addBranch(name));
        return branches;
      }

      let hasTrunk = false;
      const discoveredBranches: string[] = [];
      try {
        const trunkPromise = this.svn(['ls', '--xml', '^/trunk'], { timeout: 8000 })
          .then(() => true)
          .catch(error => {
            if (this.isPathNotFoundError(error)) return false;
            throw error;
          });
        const branchesPromise = this.svn(['ls', '--xml', '^/branches'], { timeout: 8000 })
          .catch(error => {
            if (this.isPathNotFoundError(error)) return '';
            throw error;
          });
        const [trunk, rawBranches] = await Promise.all([trunkPromise, branchesPromise]);
        if (trunk) {
          hasTrunk = true;
          addBranch('trunk');
        }
        this.parseListEntries(rawBranches)
          .filter(entry => entry.kind === 'dir')
          .forEach(entry => {
            discoveredBranches.push(entry.name);
            addBranch(entry.name);
          });
        if (this.remoteBranchesGeneration === taskGen) {
          this.remoteBranchesCache = {
            hasTrunk,
            branches: discoveredBranches,
            timestamp: Date.now(),
          };
        }
      } catch (error) {
        this.logger?.error('SvnService', 'Failed to query remote branches', error);
        // Retain previous cache if available, but set 3-second cooldown so next query can retry promptly
        if (this.remoteBranchesGeneration === taskGen) {
          const fallbackCache = this.remoteBranchesCache || staleBranchesCache;
          if (fallbackCache) {
            this.remoteBranchesCache = {
              ...fallbackCache,
              timestamp: Date.now() - (SVN_REMOTE_BRANCHES_CACHE_TTL_MS - 3000),
            };
            if (fallbackCache.hasTrunk) addBranch('trunk');
            fallbackCache.branches.forEach(name => addBranch(name));
          } else {
            this.remoteBranchesCache = {
              hasTrunk: false,
              branches: [],
              timestamp: Date.now() - (SVN_REMOTE_BRANCHES_CACHE_TTL_MS - 3000),
            };
          }
        }
      }
      return branches;
    })().finally(() => {
      if (this.remoteBranchesTask === task) {
        this.remoteBranchesTask = undefined;
      }
    });

    this.remoteBranchesTask = task;
    return await task;
  }

  async getTags(options?: { force?: boolean }): Promise<Array<{ name: string; hash: string; date: string }>> {
    const staleTagsCache = this.remoteTagsCache;
    if (options?.force) {
      this.remoteTagsGeneration++;
      this.remoteTagsCache = undefined;
      this.remoteTagsTask = undefined;
    }
    if (
      this.remoteTagsCache
      && Date.now() - this.remoteTagsCache.timestamp < SVN_REMOTE_TAGS_CACHE_TTL_MS
    ) {
      return this.remoteTagsCache.tags;
    }
    if (this.remoteTagsTask) return this.remoteTagsTask;
    const taskGen = this.remoteTagsGeneration;

    const task = (async (): Promise<Array<{ name: string; hash: string; date: string }>> => {
      try {
        const rawTags = await this.svn(['ls', '--xml', '^/tags'], { timeout: 8000 })
          .catch(error => {
            if (this.isPathNotFoundError(error)) return '';
            throw error;
          });
        const tags = this.parseListEntries(rawTags)
          .filter(entry => entry.kind === 'dir')
          .map(entry => ({
            name: entry.name,
            hash: entry.revision ? `r${entry.revision}` : entry.name,
            date: entry.date,
          }));
        if (this.remoteTagsGeneration === taskGen) {
          this.remoteTagsCache = { tags, timestamp: Date.now() };
        }
        return tags;
      } catch (error) {
        this.logger?.error('SvnService', 'Failed to query remote tags', error);
        if (this.remoteTagsGeneration === taskGen) {
          const fallbackCache = this.remoteTagsCache || staleTagsCache;
          if (fallbackCache) {
            this.remoteTagsCache = {
              ...fallbackCache,
              timestamp: Date.now() - (SVN_REMOTE_TAGS_CACHE_TTL_MS - 3000),
            };
          } else {
            this.remoteTagsCache = { tags: [], timestamp: Date.now() - (SVN_REMOTE_TAGS_CACHE_TTL_MS - 3000) };
          }
        }
        return this.remoteTagsCache?.tags ?? [];
      }
    })().finally(() => {
      if (this.remoteTagsTask === task) {
        this.remoteTagsTask = undefined;
      }
    });

    this.remoteTagsTask = task;
    return await task;
  }

  public invalidateStatusCache(): void {
    this.statusGeneration++;
    this.lastStatusSnapshot = undefined;
    this.statusInFlight = undefined;
  }

  public clearLogHistoryCache(): void {
    this.logHistoryGeneration++;
    this.logHistoryEntries = [];
    this.logHistoryHeadRevision = undefined;
    this.headLogInFlight = null;
    for (const session of this.activeSearches.values()) {
      session.abortController.abort();
    }
    this.activeSearches.clear();
  }

  public clearBranchesCache(): void {
    this.remoteBranchesGeneration++;
    this.remoteBranchesCache = undefined;
    this.remoteBranchesTask = undefined;
  }

  public clearTagsCache(): void {
    this.remoteTagsGeneration++;
    this.remoteTagsCache = undefined;
    this.remoteTagsTask = undefined;
  }

  async getStatusFresh(): Promise<RepoStatus> {
    if (this.statusInFlight && this.statusInFlight.generation === this.statusGeneration) {
      return this.statusInFlight.task;
    }

    const generation = this.statusGeneration;
    const task = (async (): Promise<RepoStatus> => {
      const [branch, files, operationState] = await Promise.all([
        this.getCurrentBranch(),
        this.parseSvnStatus(),
        this.getMergeRebaseState(),
      ]);
      const conflictCount = files.filter(file => file.status === 'conflicted').length;
      const status: RepoStatus = {
        repoId: this.repoId,
        branch,
        stagedFiles: [],
        unstagedFiles: files,
        isDetachedHead: !!branch.detachedTag,
        conflictCount,
        operationState,
      };

      if (this.statusGeneration !== generation) {
        return this.getStatusFresh();
      }

      this.lastStatusSnapshot = { status, timestamp: Date.now() };
      return status;
    })().finally(() => {
      if (this.statusInFlight?.task === task) {
        this.statusInFlight = undefined;
      }
    });

    this.statusInFlight = { generation, task };
    return await task;
  }

  async getStatus(): Promise<RepoStatus> {
    if (
      this.lastStatusSnapshot
      && Date.now() - this.lastStatusSnapshot.timestamp < SVN_STATUS_CACHE_TTL_MS
    ) {
      return this.lastStatusSnapshot.status;
    }
    if (this.statusInFlight && this.statusInFlight.generation === this.statusGeneration) {
      return this.statusInFlight.task;
    }
    return this.getStatusFresh();
  }

  private async ensureHeadLogEntries(limit: number, opts?: { force?: boolean }): Promise<SvnLogEntry[]> {
    if (!opts?.force && this.logHistoryEntries.length >= limit) {
      return this.logHistoryEntries.slice(0, limit);
    }
    if (!opts?.force && this.headLogInFlight && this.headLogInFlight.limit >= limit) {
      const entries = await this.headLogInFlight.promise;
      return entries.slice(0, limit);
    }

    const generation = this.logHistoryGeneration;
    const fetchLimit = limit;
    const task = (async (): Promise<SvnLogEntry[]> => {
      const raw = await this.svn(['log', '--xml', '-r', 'HEAD:1', '--limit', String(fetchLimit)], { timeout: 15_000 });
      const freshEntries = this.parseLogEntries(raw);
      const info = await this.getInfo().catch((): SvnInfo => ({
        url: '',
        relativeUrl: '',
        rootUrl: '',
        revision: undefined,
      }));
      this.populateCommitMetaCacheFromLogEntries(freshEntries);
      this.populateCommitFilesCacheFromLogEntries(freshEntries, info);

      if (this.logHistoryGeneration !== generation) {
        return freshEntries;
      }

      const remoteHead = freshEntries[0]?.revision;
      if (remoteHead && this.logHistoryHeadRevision === remoteHead && this.logHistoryEntries.length >= fetchLimit && !opts?.force) {
        return this.logHistoryEntries.slice(0, fetchLimit);
      }
      this.logHistoryEntries = freshEntries;
      this.logHistoryHeadRevision = remoteHead ?? info.revision;
      return freshEntries;
    })();

    this.headLogInFlight = { limit: fetchLimit, promise: task };
    try {
      return await task;
    } finally {
      if (this.headLogInFlight?.promise === task) {
        this.headLogInFlight = null;
      }
    }
  }

  async getGraphLog(limit?: number): Promise<GraphCommitNode[]> {
    if (limit !== undefined && limit <= 0) return [];
    const info = await this.getInfo();
    const localRevision = await this.resolveEffectiveLocalRevision(info);
    const safeLimit = limit === undefined ? SVN_GRAPH_LOG_SAFE_LIMIT : Math.min(limit, SVN_GRAPH_LOG_SAFE_LIMIT);

    let entries: SvnLogEntry[];
    if (this.logHistoryEntries.length >= safeLimit && (!this.logHistoryHeadRevision || this.logHistoryHeadRevision === info.revision)) {
      entries = this.logHistoryEntries.slice(0, safeLimit);
    } else {
      try {
        entries = await this.ensureHeadLogEntries(safeLimit);
      } catch (error: unknown) {
        this.logger?.error('SvnService', 'Failed to load graph log entries', error);
        entries = this.logHistoryEntries.slice(0, safeLimit);
      }
    }

    const headRevision = entries[0]?.revision ?? this.logHistoryHeadRevision ?? info.revision;
    return entries.map(entry => ({
      hash: `r${entry.revision}`,
      repoId: this.repoId,
      committerDate: entry.date,
      parents: [],
      refs: [
        ...(entry.revision === headRevision ? ['HEAD'] : []),
        ...(localRevision !== undefined && entry.revision === String(localRevision) ? ['BASE'] : []),
      ],
    }));
  }

  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange; force?: boolean; consumer?: string }): Promise<CommitNode[]> {
    const consumerKey = opts?.consumer || 'default';
    const info = await this.getInfo();
    if (!this.matchesRefFilter(info, opts?.filterBranch)) return [];
    const filterText = opts?.filterText?.trim() ?? '';
    const revisionSearch = filterText ? parseRevisionNumber(filterText) : undefined;
    const incoming = this.incomingStateCache;
    if (!incoming) {
      void this.getIncomingState(info).catch(() => {});
    }
    const localRevision = incoming?.localRevision ?? this.getEffectiveLocalRevision(info);
    const selectionRevisions = opts?.filterPath && opts.lineRange
      ? await this.getSelectionHistoryRevisions(opts.filterPath, opts.lineRange)
      : undefined;
    if (selectionRevisions && selectionRevisions.size === 0) return [];
    if (revisionSearch !== undefined && selectionRevisions && !selectionRevisions.has(String(revisionSearch))) return [];

    const hasPostFetchFilters = !!(
      filterText
      || opts?.filterAuthor?.trim()
      || opts?.filterDateFrom
      || opts?.filterDateTo
    );

    let entries: SvnLogEntry[] = [];
    let headRevision: string | undefined = info.revision;

    // Fast path: Standard linear pagination without ad-hoc path or query filters.
    // Uses cached linear history and cursor-based queries (-r (oldestRev-1):1 --limit N).
    const isStandardLinearLog = !selectionRevisions && revisionSearch === undefined && !hasPostFetchFilters && !opts?.filterPath;
    const needTotal = skip + limit;

    const existingSearch = this.activeSearches.get(consumerKey);
    if (!hasPostFetchFilters && existingSearch) {
      existingSearch.abortController.abort();
      this.activeSearches.delete(consumerKey);
    }

    if (isStandardLinearLog) {
      if (!opts?.force && this.logHistoryEntries.length >= needTotal) {
        entries = this.logHistoryEntries.slice(skip, needTotal);
      } else if (this.logHistoryEntries.length === 0 || opts?.force) {
        try {
          const freshEntries = await this.ensureHeadLogEntries(needTotal, opts);
          entries = freshEntries.slice(skip, needTotal);
        } catch (error: unknown) {
          this.logger?.error('SvnService', 'Failed to fetch fresh HEAD log', error);
          entries = this.logHistoryEntries.slice(skip, needTotal);
        }
      } else {
        const needCount = needTotal - this.logHistoryEntries.length;
        const fetchLimit = needCount;
        const lastEntry = this.logHistoryEntries[this.logHistoryEntries.length - 1];
        const oldestRevNumber = lastEntry ? parseRevisionNumber(lastEntry.revision) : undefined;

        if (oldestRevNumber !== undefined && oldestRevNumber <= 1) {
          entries = this.logHistoryEntries.slice(skip, needTotal);
        } else {
          const fetchRange = oldestRevNumber !== undefined && oldestRevNumber > 1
            ? `${oldestRevNumber - 1}:1`
            : 'HEAD:1';

          const generation = this.logHistoryGeneration;
          try {
            const raw = await this.svn(['log', '--xml', '-r', fetchRange, '--limit', String(fetchLimit)], { timeout: 15_000 });
            const newEntries = this.parseLogEntries(raw);
            this.populateCommitMetaCacheFromLogEntries(newEntries);
            this.populateCommitFilesCacheFromLogEntries(newEntries, info);

            if (this.logHistoryGeneration === generation) {
              const existingRevs = new Set(this.logHistoryEntries.map(e => e.revision));
              for (const e of newEntries) {
                if (!existingRevs.has(e.revision)) {
                  this.logHistoryEntries.push(e);
                  existingRevs.add(e.revision);
                }
              }
            }
          } catch (error: unknown) {
            this.logger?.error('SvnService', 'Failed to fetch linear log page', error);
          }
          entries = this.logHistoryEntries.slice(skip, needTotal);
        }
      }
      headRevision = this.logHistoryEntries[0]?.revision ?? info.revision;
    } else if (hasPostFetchFilters && !selectionRevisions && revisionSearch === undefined) {
      const searchKey = `${opts?.filterPath ?? ''}::${filterText}::${opts?.filterAuthor?.trim() ?? ''}::${opts?.filterDateFrom ?? ''}::${opts?.filterDateTo ?? ''}`;
      let active = this.activeSearches.get(consumerKey);
      if (opts?.force || !active || active.key !== searchKey) {
        active?.abortController.abort();
        active = {
          key: searchKey,
          matchedEntries: [],
          nextCursorRev: undefined,
          reachedEnd: false,
          abortController: new AbortController(),
          generation: (active?.generation ?? 0) + 1,
        };
        this.activeSearches.set(consumerKey, active);
      }

      const targetCount = skip + limit;
      const CHUNK_SIZE = 300;
      const MAX_BATCH_SCANNED = 3000;
      let batchScanned = 0;
      const currentAbort = active.abortController;
      const currentGen = active.generation;

      while (active.matchedEntries.length < targetCount && !active.reachedEnd && batchScanned < MAX_BATCH_SCANNED) {
        if (currentAbort.signal.aborted || active.generation !== currentGen) {
          return [];
        }
        const fetchRange = active.nextCursorRev !== undefined ? `${active.nextCursorRev}:1` : 'HEAD:1';
        const chunkArgs = ['log', '--xml', '-r', fetchRange, '--limit', String(CHUNK_SIZE)];
        if (opts?.filterPath) chunkArgs.push('--', this.workingCopyTarget(opts.filterPath));

        let rawChunk = '';
        try {
          rawChunk = await this.svn(chunkArgs, { timeout: 15_000, signal: currentAbort.signal });
          active.lastError = undefined;
        } catch (error: unknown) {
          if (currentAbort.signal.aborted || active.generation !== currentGen) {
            return [];
          }
          const errMsg = error instanceof Error ? error.message : String(error);
          this.logger?.error('SvnService', 'Search chunk scan failed', error);
          active.lastError = errMsg;
          break;
        }

        if (currentAbort.signal.aborted || active.generation !== currentGen) {
          return [];
        }

        const chunkEntries = this.parseLogEntries(rawChunk);
        if (chunkEntries.length === 0) {
          active.reachedEnd = true;
          break;
        }
        batchScanned += chunkEntries.length;

        this.populateCommitMetaCacheFromLogEntries(chunkEntries);
        this.populateCommitFilesCacheFromLogEntries(chunkEntries, info);

        for (const entry of chunkEntries) {
          const matchText = !filterText || entry.message.toLowerCase().includes(filterText.toLowerCase());
          const matchAuthor = !opts?.filterAuthor || entry.author.toLowerCase().includes(opts.filterAuthor.toLowerCase());
          const matchDateFrom = !opts?.filterDateFrom || new Date(entry.date) >= new Date(opts.filterDateFrom);
          const matchDateTo = !opts?.filterDateTo || new Date(entry.date) <= new Date(opts.filterDateTo);
          if (matchText && matchAuthor && matchDateFrom && matchDateTo) {
            active.matchedEntries.push(entry);
          }
        }

        const lastRev = parseRevisionNumber(chunkEntries[chunkEntries.length - 1]?.revision);
        if (lastRev === undefined || lastRev <= 1 || chunkEntries.length < CHUNK_SIZE) {
          active.reachedEnd = true;
          break;
        }
        active.nextCursorRev = lastRev - 1;
      }

      entries = active.matchedEntries.slice(skip, skip + limit);
    } else {
      // Explicit revision number search or path-line blame history query
      const numericSelectionRevisions = selectionRevisions
        ? Array.from(selectionRevisions)
          .map(parseRevisionNumber)
          .filter((revision): revision is number => revision !== undefined)
          .sort((a, b) => b - a)
        : [];
      const args = ['log', '--xml'];
      if (selectionRevisions) {
        if (numericSelectionRevisions.length === 0) return [];
        args.push('-r', `${numericSelectionRevisions[0]}:${numericSelectionRevisions[numericSelectionRevisions.length - 1]}`);
      } else if (revisionSearch !== undefined) {
        args.push('-r', String(revisionSearch));
      } else {
        args.push('-r', 'HEAD:1');
        args.push('--limit', String(Math.max(limit + skip, SVN_FILTER_SEARCH_SCAN_LIMIT)));
      }
      if (opts?.filterPath) args.push('--', this.workingCopyTarget(opts.filterPath));
      let raw: string;
      try {
        raw = await this.svn(args, { timeout: 15_000 });
      } catch (error: unknown) {
        if (revisionSearch !== undefined && this.errorText(error).toLowerCase().includes('e160006')) return [];
        throw error;
      }
      const allEntries = this.parseLogEntries(raw);
      this.populateCommitMetaCacheFromLogEntries(allEntries);
      this.populateCommitFilesCacheFromLogEntries(allEntries, info);
      headRevision = selectionRevisions ? undefined : allEntries[0]?.revision ?? info.revision;
      entries = allEntries
        .filter(entry => !selectionRevisions || selectionRevisions.has(entry.revision))
        .filter(entry => revisionSearch === undefined || entry.revision === String(revisionSearch))
        .filter(entry => revisionSearch !== undefined || !filterText || entry.message.toLowerCase().includes(filterText.toLowerCase()))
        .filter(entry => !opts?.filterAuthor || entry.author.toLowerCase().includes(opts.filterAuthor.toLowerCase()))
        .filter(entry => !opts?.filterDateFrom || new Date(entry.date) >= new Date(opts.filterDateFrom))
        .filter(entry => !opts?.filterDateTo || new Date(entry.date) <= new Date(opts.filterDateTo))
        .slice(skip, skip + limit);
    }

    let explicitHasMore: boolean | undefined = undefined;
    const currentSearch = this.activeSearches.get(consumerKey);
    if (hasPostFetchFilters && !selectionRevisions && revisionSearch === undefined && currentSearch) {
      if (currentSearch.lastError) {
        explicitHasMore = currentSearch.matchedEntries.length > skip + entries.length;
      } else {
        explicitHasMore =
          currentSearch.matchedEntries.length > skip + entries.length
          || !currentSearch.reachedEnd;
      }
    }

    const commitNodes: CommitLogList = entries.map(entry => ({
      hash: `r${entry.revision}`,
      shortHash: `r${entry.revision}`,
      repoId: this.repoId,
      message: entry.message.split('\n')[0] || t('SVN revision {0}', entry.revision),
      authorName: entry.author || t('Unknown'),
      authorEmail: '',
      authorDate: entry.date,
      committerDate: entry.date,
      parents: [],
      refs: [
        ...(entry.revision === headRevision ? ['HEAD'] : []),
        ...(localRevision !== undefined && entry.revision === String(localRevision) ? ['BASE'] : []),
      ],
      unpushed: false,
      incoming: incoming?.incomingRevisions.has(entry.revision)
        ?? (localRevision !== undefined && (parseRevisionNumber(entry.revision) ?? 0) > localRevision),
    }));

    if (explicitHasMore !== undefined) {
      commitNodes.hasMore = explicitHasMore;
    }
    if (currentSearch?.lastError) {
      commitNodes.repoErrors = [{ repoId: this.repoId, error: currentSearch.lastError }];
    }
    return commitNodes;
  }

  private async getSelectionHistoryRevisions(filePath: string, lineRange: LineRange): Promise<Set<string>> {
    const startLine = Math.max(0, lineRange.start - 1);
    const endLine = Math.max(startLine, lineRange.end - 1);
    const relPath = this.normalizeRepoPath(filePath);
    const raw = await this.svn(['blame', '--xml', '--', this.workingCopyTarget(relPath)]).catch(() => '');
    const blame = this.parseBlameEntries(raw);
    const revisions = new Set<string>();
    for (const line of blame) {
      if (line.lineNumber < startLine || line.lineNumber > endLine || line.isUncommitted) continue;
      if (line.revision) revisions.add(line.revision);
    }
    return revisions;
  }

  async getCompareLog(): Promise<CommitNode[]> {
    return [];
  }

  private parseLogEntries(raw: string): SvnLogEntry[] {
    const entries: SvnLogEntry[] = [];
    const entryRegex = /<logentry\b([^>]*)>([\s\S]*?)<\/logentry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(raw)) !== null) {
      const revision = attr(match[1], 'revision') ?? '';
      const body = match[2];
      const paths: SvnLogPath[] = [];
      const pathsBlock = body.match(/<paths\b[^>]*>([\s\S]*?)<\/paths>/)?.[1];
      if (pathsBlock) {
        const pathRegex = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
        let pathMatch: RegExpExecArray | null;
        while ((pathMatch = pathRegex.exec(pathsBlock)) !== null) {
          const action = attr(pathMatch[1], 'action') ?? 'M';
          const kind = attr(pathMatch[1], 'kind');
          const p = decodeXml(pathMatch[2]).trim();
          paths.push({ path: p, action, kind });
        }
      }
      entries.push({
        revision,
        author: textTag(body, 'author'),
        date: textTag(body, 'date'),
        message: textTag(body, 'msg'),
        paths: paths.length > 0 ? paths : undefined,
      });
    }
    return entries;
  }

  private populateCommitFilesCacheFromLogEntries(entries: SvnLogEntry[], info: SvnInfo): void {
    for (const entry of entries) {
      if (!entry.revision || !entry.paths) continue;
      const revision = entry.revision;
      if (this.commitFilesCache.has(revision)) continue;

      const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
      for (const logPath of entry.paths) {
        if (logPath.kind === 'dir') continue;
        const fullUrl = `${info.rootUrl.replace(/\/$/, '')}/${logPath.path.replace(/^\//, '')}`;
        const workingPath = this.repositoryUrlToWorkingPath(fullUrl, info);
        if (workingPath === undefined) continue;
        const pathValue = workingPath || '.';
        const action = logPath.action.toUpperCase();
        const status = action === 'A' ? 'A' : action === 'D' ? 'D' : 'M';
        files.push({ path: pathValue, status });
      }
      if (files.length > 0) {
        this.commitFilesCache.set(revision, Promise.resolve(files));
        if (this.commitFilesCache.size > SVN_COMMIT_FILES_CACHE_LIMIT) {
          const oldestKey = this.commitFilesCache.keys().next().value;
          if (oldestKey) this.commitFilesCache.delete(oldestKey);
        }
      }
    }
  }

  private populateCommitMetaCacheFromLogEntries(entries: SvnLogEntry[]): void {
    for (const entry of entries) {
      if (!entry.revision) continue;
      const revision = entry.revision;
      if (this.commitMetaCache.has(revision)) continue;
      const revisionHash = `r${revision}`;
      const fullMessage = entry.message ?? '';
      const meta = {
        hash: revisionHash,
        shortHash: revisionHash,
        message: fullMessage.split('\n')[0] ?? t('SVN revision {0}', revision),
        authorName: entry.author || t('Unknown'),
        authorEmail: '',
        authorDate: entry.date ?? '',
        committerDate: entry.date ?? '',
        parents: [],
      };
      this.commitMetaCache.set(revision, Promise.resolve({ meta, fullMessage }));
      if (this.commitMetaCache.size > SVN_COMMIT_META_CACHE_LIMIT) {
        const oldestKey = this.commitMetaCache.keys().next().value;
        if (oldestKey) this.commitMetaCache.delete(oldestKey);
      }
    }
  }

  private parseBlameEntries(raw: string): Array<{ lineNumber: number; revision?: string; author: string; date: string; isUncommitted: boolean }> {
    const entries: Array<{ lineNumber: number; revision?: string; author: string; date: string; isUncommitted: boolean }> = [];
    const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(raw)) !== null) {
      const lineNumber = Number(attr(match[1], 'line-number'));
      if (!Number.isFinite(lineNumber)) continue;
      const commitMatch = match[2].match(/<commit\b([^>]*)>([\s\S]*?)<\/commit>/);
      if (!commitMatch) {
        entries.push({
          lineNumber: Math.max(0, lineNumber - 1),
          author: '',
          date: '',
          isUncommitted: true,
        });
        continue;
      }
      const revision = attr(commitMatch[1], 'revision') ?? '';
      if (!revision) continue;
      entries.push({
        lineNumber: Math.max(0, lineNumber - 1),
        revision,
        author: textTag(commitMatch[2], 'author'),
        date: textTag(commitMatch[2], 'date'),
        isUncommitted: false,
      });
    }
    return entries;
  }

  private async getBlameSummaries(relPath: string, revisions: string[]): Promise<Map<string, string>> {
    const numericRevisions = Array.from(new Set(revisions))
      .map(parseRevisionNumber)
      .filter((revision): revision is number => revision !== undefined);
    if (numericRevisions.length === 0) return new Map();

    const from = Math.min(...numericRevisions);
    const to = Math.max(...numericRevisions);
    const raw = await this.svn(['log', '--xml', '-r', `${to}:${from}`, '--', this.workingCopyTarget(relPath)], { timeout: 8000 }).catch(() => '');
    const summaries = new Map<string, string>();
    for (const entry of this.parseLogEntries(raw)) {
      summaries.set(entry.revision, entry.message.split('\n')[0] || t('SVN revision {0}', entry.revision));
    }
    return summaries;
  }

  private async loadBlame(relPath: string): Promise<BlameLine[]> {
    const raw = await this.svn(['blame', '--xml', '--', this.workingCopyTarget(relPath)], { timeout: 10_000 }).catch(() => '');
    const entries = this.parseBlameEntries(raw);
    if (entries.length === 0) return [];

    const revisions = entries.map(entry => entry.revision).filter((revision): revision is string => !!revision);
    const summaries = await this.getBlameSummaries(relPath, revisions);
    return entries.map(entry => ({
      lineNumber: entry.lineNumber,
      hash: entry.isUncommitted ? '0000000000000000000000000000000000000000' : `r${entry.revision}`,
      author: entry.isUncommitted ? t('Not committed') : (entry.author || t('Unknown')),
      date: entry.isUncommitted ? new Date() : parseSvnDate(entry.date),
      summary: entry.isUncommitted ? t('Not committed') : summaries.get(entry.revision!) ?? t('SVN revision {0}', entry.revision!),
      isUncommitted: entry.isUncommitted,
    }));
  }

  async getBlame(filePath: string): Promise<BlameLine[]> {
    const relPath = this.normalizeRepoPath(filePath);
    const cached = this.blameCache.get(relPath);
    if (cached) return cached;

    const task = this.loadBlame(relPath).catch(() => {
      if (this.blameCache.get(relPath) === task) this.blameCache.delete(relPath);
      return [];
    });
    this.blameCache.set(relPath, task);
    if (this.blameCache.size > SVN_BLAME_CACHE_LIMIT) {
      const oldestKey = this.blameCache.keys().next().value;
      if (oldestKey) this.blameCache.delete(oldestKey);
    }
    return task;
  }

  invalidateBlame(filePath: string): void {
    this.blameCache.delete(this.normalizeRepoPath(filePath));
  }

  async getCommitFiles(hash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    const revision = requireRevision(hash);
    const cached = this.commitFilesCache.get(revision);
    if (cached) return await cached;
    const task: Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> = (async (): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> => {
      const info = await this.getInfo();

      // Fast path: Try single revision `svn log --xml -v -r <revision>`
      // which takes ~500ms vs ~1800ms for full tree diff --summarize.
      try {
        const rawLog = await this.svn(['log', '--xml', '-v', '-r', revision]);
        const entries = this.parseLogEntries(rawLog);
        if (entries.length > 0 && entries[0].paths && entries[0].paths.length > 0) {
          const fastFiles: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
          for (const logPath of entries[0].paths) {
            if (logPath.kind === 'dir') continue;
            const fullUrl = `${info.rootUrl.replace(/\/$/, '')}/${logPath.path.replace(/^\//, '')}`;
            const workingPath = this.repositoryUrlToWorkingPath(fullUrl, info);
            if (workingPath === undefined) continue;
            const pathValue = workingPath || '.';
            const action = logPath.action.toUpperCase();
            const status = action === 'A' ? 'A' : action === 'D' ? 'D' : 'M';
            fastFiles.push({ path: pathValue, status });
          }
          if (fastFiles.length > 0) return fastFiles;
        }
      } catch {
        // Fallback to diff --summarize on error or unmapped paths
      }

      // Fallback path: Summarizing against the current URL with a stable peg maps inherited
      // trunk history back into the checked-out branch namespace. `svn log -v`
      // reports the original `/trunk/...` paths and cannot be prefix-stripped
      // against `/branches/<name>`.
      const raw = await this.svn(['diff', '--summarize', '--xml', '-c', revision, `${info.url}@HEAD`]);
      const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
      const pathRegex = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
      let match: RegExpExecArray | null;
      while ((match = pathRegex.exec(raw)) !== null) {
        const item = attr(match[1], 'item') ?? 'modified';
        if (attr(match[1], 'kind') === 'dir') continue;
        const decodedPath = decodeXml(match[2]).trim();
        const workingPath = this.repositoryUrlToWorkingPath(decodedPath, info);
        if (workingPath === undefined) continue;
        const pathValue = workingPath || '.';
        files.push({ path: pathValue, status: svnSummaryItemToStatus(item) });
      }
      return files;
    })().catch((error: unknown) => {
      if (this.commitFilesCache.get(revision) === task) this.commitFilesCache.delete(revision);
      throw error;
    });
    this.commitFilesCache.set(revision, task);
    if (this.commitFilesCache.size > SVN_COMMIT_FILES_CACHE_LIMIT) {
      const oldestKey = this.commitFilesCache.keys().next().value;
      if (oldestKey) this.commitFilesCache.delete(oldestKey);
    }
    return await task;
  }

  override async getCommitFilesForLogDetail(hash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>> {
    return this.getCommitFiles(hash);
  }

  async getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null> {
    const revision = requireRevision(hash);
    const relPath = this.normalizeRepoPath(filePath);
    const repositoryUrl = await this.getRepositoryUrl();
    let raw = '';
    for (const target of this.repositoryFileTargets(repositoryUrl, relPath, revision)) {
      try {
        raw = await this.svn(['diff', '-c', revision, target]);
        break;
      } catch (error: unknown) {
        if (!this.isPathNotFoundError(error)) throw error;
      }
    }
    return this.parseSingleDiff(repoId, relPath, raw, revision, relPath);
  }

  private isPathNotFoundError(error: unknown): boolean {
    const text = this.errorText(error).toLowerCase();
    return text.includes('160013')
      || text.includes('155010')
      || text.includes('e200009')
      || text.includes('path not found')
      || text.includes('file not found')
      || text.includes('item not found')
      || text.includes("doesn't exist")
      || text.includes("don't exist")
      || text.includes('does not exist');
  }

  private evictRevisionContentKey(key: string): void {
    const size = this.revisionContentSizes.get(key);
    if (size !== undefined) {
      this.revisionContentTotalBytes = Math.max(0, this.revisionContentTotalBytes - size);
      this.revisionContentSizes.delete(key);
    }
  }

  private async fetchRevisionContentRaw(
    revision: string,
    relPath: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const repositoryUrl = await this.getRepositoryUrl();
    try {
      const info = await this.getInfo();
      if (info.revision === revision) {
        const absPath = path.join(this.rootPath, relPath);
        if (fs.existsSync(absPath)) {
          const rawStatus = await this.svn(['status', '--xml', absPath], { signal }).catch(() => '');
          if (!rawStatus || !rawStatus.includes('<entry')) {
            return fs.readFileSync(absPath, 'utf8');
          }
        }
      }
    } catch {
      // fallback to standard svn cat
    }

    for (const target of this.repositoryFileTargets(repositoryUrl, relPath, revision)) {
      try {
        return await this.svn(['cat', '-r', revision, target], { signal });
      } catch (error: unknown) {
        if (!this.isPathNotFoundError(error)) throw error;
      }
    }
    return undefined;
  }

  private cacheResolvedRevisionContent(key: string, content: string | undefined): void {
    if (content === undefined) return;
    const byteSize = Buffer.byteLength(content, 'utf8');
    if (byteSize > SVN_MAX_CACHEABLE_FILE_BYTES) {
      this.revisionContentCache.delete(key);
      this.evictRevisionContentKey(key);
      return;
    }
    this.evictRevisionContentKey(key);
    this.revisionContentSizes.set(key, byteSize);
    this.revisionContentTotalBytes += byteSize;
    this.revisionContentCache.set(key, Promise.resolve(content));

    while (
      (this.revisionContentTotalBytes > SVN_REVISION_CONTENT_MAX_TOTAL_BYTES || this.revisionContentCache.size > SVN_REVISION_CONTENT_CACHE_LIMIT)
      && this.revisionContentCache.size > 0
    ) {
      const oldestKey = this.revisionContentCache.keys().next().value;
      if (!oldestKey) break;
      this.revisionContentCache.delete(oldestKey);
      this.evictRevisionContentKey(oldestKey);
    }
  }

  async getRevisionContentOrUndefined(
    revision: string,
    relPath: string,
    options?: { signal?: AbortSignal },
  ): Promise<string | undefined> {
    const repositoryUrl = await this.getRepositoryUrl();
    const key = scopedKey(repositoryUrl, revision, relPath);
    const cached = this.revisionContentCache.get(key);
    if (cached) {
      try {
        return await cached;
      } catch (error: unknown) {
        if (options?.signal?.aborted) throw error;
        // Evict aborted/failed cached promise and retry fresh
        this.revisionContentCache.delete(key);
        this.evictRevisionContentKey(key);
      }
    }

    const task = this.fetchRevisionContentRaw(revision, relPath, options?.signal)
      .then(content => {
        this.cacheResolvedRevisionContent(key, content);
        return content;
      })
      .catch((error: unknown) => {
        if (this.revisionContentCache.get(key) === task) {
          this.revisionContentCache.delete(key);
          this.evictRevisionContentKey(key);
        }
        throw error;
      });

    this.revisionContentCache.set(key, task);
    return await task;
  }

  async prefetchRevisionFiles(
    hash: string,
    filePaths: Array<string | { path: string; status?: string }>,
    options?: { maxFiles?: number },
  ): Promise<void> {
    const revision = parseRevisionNumber(hash);
    if (revision === undefined) return;

    // Abort previous in-flight prefetch if any
    this.prefetchAbortController?.abort();
    const abortController = new AbortController();
    this.prefetchAbortController = abortController;

    const repositoryUrl = await this.getRepositoryUrl();
    const maxFiles = options?.maxFiles ?? 6;
    const targets = filePaths.slice(0, maxFiles);
    const previousRevision = String(Math.max(0, revision - 1));
    const currentRevisionStr = String(revision);

    const workerCount = Math.min(2, targets.length);
    let nextIndex = 0;
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < targets.length) {
        if (abortController.signal.aborted) return;
        const currentIndex = nextIndex++;
        if (currentIndex >= targets.length) return;

        const target = targets[currentIndex];
        const rawPath = typeof target === 'string' ? target : target.path;
        const rawStatus = typeof target === 'string' ? '' : (target.status ?? '').toUpperCase();
        const targetRelPath = this.normalizeRepoPath(rawPath);

        const isAdded = rawStatus === 'A' || rawStatus === 'ADDED';
        const isDeleted = rawStatus === 'D' || rawStatus === 'DELETED';
        const revsToFetch = isAdded
          ? [currentRevisionStr]
          : isDeleted
            ? [previousRevision]
            : [previousRevision, currentRevisionStr];

        for (const rev of revsToFetch) {
          if (abortController.signal.aborted) return;
          const key = scopedKey(repositoryUrl, rev, targetRelPath);
          if (this.revisionContentCache.has(key)) continue;

          try {
            const content = await this.fetchRevisionContentRaw(rev, targetRelPath, abortController.signal);
            if (!abortController.signal.aborted && content !== undefined) {
              this.cacheResolvedRevisionContent(key, content);
            }
          } catch {
            // Ignore background prefetch error / abort
          }
        }
      }
    });
    await Promise.all(workers);
  }

  private async getRevisionContent(revision: string, relPath: string, options?: { signal?: AbortSignal }): Promise<string> {
    return await this.getRevisionContentOrUndefined(revision, relPath, options) ?? '';
  }

  async getRevisionFileContents(
    hash: string,
    filePath: string,
    status?: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ originalContent: string; modifiedContent: string; isBinary?: boolean }> {
    const revision = requireRevision(hash);
    const previousRevision = String(Math.max(0, Number(revision) - 1));
    const relPath = this.normalizeRepoPath(filePath);
    const normalizedStatus = (status ?? '').toUpperCase();
    const isAdded = normalizedStatus === 'A' || normalizedStatus === 'ADDED';
    const isDeleted = normalizedStatus === 'D' || normalizedStatus === 'DELETED';
    const [originalContent, modifiedContent] = await Promise.all([
      isAdded ? Promise.resolve('') : this.getRevisionContent(previousRevision, relPath, options),
      isDeleted ? Promise.resolve('') : this.getRevisionContent(revision, relPath, options),
    ]);
    const isBinary = isLikelyBinaryContent(originalContent) || isLikelyBinaryContent(modifiedContent);
    return isBinary
      ? { originalContent: '', modifiedContent: '', isBinary: true }
      : { originalContent, modifiedContent };
  }

  async getRevisionRangeFileContents(
    fromHash: string | undefined,
    toHash: string,
    filePath: string,
  ): Promise<{ originalContent: string; modifiedContent: string; isBinary?: boolean }> {
    const fromRevision = parseRevisionNumber(fromHash);
    const toRevision = parseRevisionNumber(toHash);
    const relPath = this.normalizeRepoPath(filePath);
    const [originalContent, modifiedContent] = await Promise.all([
      fromRevision === undefined ? Promise.resolve('') : this.getRevisionContent(String(fromRevision), relPath),
      toRevision === undefined ? Promise.resolve('') : this.getRevisionContent(String(toRevision), relPath),
    ]);
    const isBinary = isLikelyBinaryContent(originalContent) || isLikelyBinaryContent(modifiedContent);
    return isBinary
      ? { originalContent: '', modifiedContent: '', isBinary: true }
      : { originalContent, modifiedContent };
  }

  async getUnstagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    const relPath = this.normalizeRepoPath(filePath);
    const raw = await this.svn(['diff', '--', this.workingCopyDiffTarget(relPath)]).catch(() => '');
    if (!raw.trim()) {
      const absPath = path.join(this.rootPath, relPath);
      const workingFile = this.readWorkingFile(absPath);
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
    return this.parseSingleDiff(repoId, relPath, raw);
  }

  async getStagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    return this.getUnstagedDiff(repoId, filePath);
  }

  private async parseSingleDiff(repoId: string, filePath: string, raw: string, revision?: string, forcedFilePath?: string): Promise<FileDiff | null> {
    const diffs = parseDiff(buildSyntheticGitDiff(raw, forcedFilePath), repoId);
    if (diffs.length === 0) return null;
    const diff = diffs.find(item => item.newPath === filePath || item.oldPath === filePath) ?? diffs[0];
    if (diff.isBinary) return diff;
    const contentPath = this.normalizeRepoPath(diff.newPath || filePath);
    const absPath = path.join(this.rootPath, contentPath);
    if (revision) {
      const contents = await this.getRevisionFileContents(
        revision,
        filePath,
        diff.isNew ? 'A' : diff.isDeleted ? 'D' : undefined,
      );
      diff.originalContent = contents.originalContent;
      diff.modifiedContent = contents.modifiedContent;
    } else {
      const [originalContent, workingFile] = await Promise.all([
        this.svn(['cat', '--', this.workingCopyTarget(filePath)]).catch(() => ''),
        Promise.resolve(this.readWorkingFile(absPath)),
      ]);
      if (isLikelyBinaryContent(originalContent) || workingFile?.isBinary) {
        diff.isBinary = true;
        diff.hunks = [];
        diff.originalContent = '';
        diff.modifiedContent = '';
        return diff;
      }
      diff.originalContent = originalContent;
      diff.modifiedContent = workingFile?.content ?? '';
    }
    return diff;
  }

  /**
   * 递归检查目录及其子树中是否包含未被 SVN 忽略的嵌套 VCS 元数据（.git 或 .hg）。
   * 优先识别文件型与目录型 .git/.hg，未忽略时立即阻断；
   * 对被 SVN ignore 规则忽略的父目录直接跳过整棵子树，不误报且避免无效扫描；
   * 采用异步非阻塞遍历，遇到符号链接不跟随，文件系统异常安全跳过。
   * @returns 发现的第一个未忽略的嵌套 VCS 相对路径，如 'payload/nested/.git'；若未发现则返回 null。
   */
  private async findUnignoredNestedVcsInDir(
    targetRelDir: string,
    clientGlobalIgnores: string[],
    inheritedIgnores: Array<{ dirRelPath: string; patterns: string[] }>,
  ): Promise<string | null> {
    const absDir = targetRelDir ? path.join(this.rootPath, targetRelDir) : this.rootPath;
    try {
      const stat = await fs.promises.lstat(absDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        return null;
      }
    } catch {
      return null;
    }

    const queue: string[] = [targetRelDir];
    while (queue.length > 0) {
      const currentRel = queue.shift()!;
      const currentAbs = currentRel ? path.join(this.rootPath, currentRel) : this.rootPath;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(currentAbs, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const childRel = currentRel ? `${currentRel}/${entry.name}` : entry.name;

        const lowerName = entry.name.toLowerCase();
        // 优先按名称识别 .git 或 .hg（包含大小写变体、目录型与常见于 submodule/worktree 的文件型 .git）
        if (lowerName === '.git' || lowerName === '.hg') {
          const isIgnored = this.isIgnoredBySvnRules(childRel, entry.name, clientGlobalIgnores, inheritedIgnores);
          if (!isIgnored) {
            return childRel;
          }
          // 若已被 SVN 规则忽略，则无需进入或处理该条目
          continue;
        }

        // 普通条目：只有真实目录且非符号链接才需要继续递归
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          continue;
        }

        // 若子目录本身被 SVN ignore 规则忽略（如 ignored、node_modules），
        // 原生 SVN 会自动跳过整个目录树，因此直接跳过不入队，避免误报与无谓遍历
        if (this.isIgnoredBySvnRules(childRel, entry.name, clientGlobalIgnores, inheritedIgnores)) {
          continue;
        }

        queue.push(childRel);
      }
    }

    return null;
  }

  async stageFiles(paths: string[], options?: { allowTruncated?: boolean }): Promise<void> {
    const statuses = await this.parseSvnStatus();
    const requested = new Set(paths.map(filePath => this.normalizeSvnTarget(filePath)));
    const truncatedSet = new Set(statuses.filter(f => f.isTruncated).map(f => f.path));

    if (!options?.allowTruncated) {
      if (paths.length === 1 && truncatedSet.has(this.normalizeSvnTarget(paths[0]))) {
        throw new Error(
          t('Cannot recursively add truncated directory "{0}" because its contents exceed display limits. Please add files selectively or configure svn:ignore.', paths[0])
        );
      }
    }

    const unversioned = statuses
      .filter(file => file.svnItem === 'unversioned' && requested.has(file.path) && (options?.allowTruncated || !file.isTruncated))
      .map(file => file.path);
    const missing = statuses
      .filter(file => file.svnItem === 'missing' && requested.has(file.path))
      .map(file => file.path);

    const vcsPath = unversioned.find(p => isNestedVcsPath(p));
    if (vcsPath) {
      throw new Error(
        t('Adding nested repository metadata "{0}" to SVN is blocked to prevent exposing repository history or credentials. Please add it to svn:ignore.', vcsPath)
      );
    }

    const [inheritedIgnores] = await Promise.all([
      this.getInheritedGlobalIgnores().catch(() => []),
    ]);
    const clientGlobalIgnores = this.getClientGlobalIgnores();

    for (const targetPath of unversioned) {
      const nestedVcs = await this.findUnignoredNestedVcsInDir(targetPath, clientGlobalIgnores, inheritedIgnores);
      if (nestedVcs) {
        throw new Error(
          t('Directory "{0}" contains nested repository metadata "{1}". Please add it to svn:ignore or add files selectively.', targetPath, nestedVcs)
        );
      }
    }

    const prunedUnversioned = pruneRedundantChildPaths(unversioned);
    if (prunedUnversioned.length > 0) await this.runWithTargets(['add', '--parents'], prunedUnversioned);
    if (missing.length > 0) await this.runWithTargets(['delete', '--force'], missing);
  }

  async stageAll(): Promise<void> {
    const files = await this.parseSvnStatus();
    const schedulable = files
      .filter(file => (file.svnItem === 'unversioned' || file.svnItem === 'missing') && !isNestedVcsPath(file.path) && !file.isTruncated)
      .map(file => file.path);
    if (schedulable.length > 0) await this.stageFiles(schedulable);
  }

  async unstageFiles(): Promise<void> {
    return;
  }

  async unstageAll(): Promise<void> {
    return;
  }

  async discardFile(filePath: string): Promise<void> {
    const relPath = this.normalizeSvnTarget(filePath);
    const status = (await this.parseSvnStatus()).find(file => file.path === relPath);
    if (status?.isTruncated) {
      throw new Error(
        t('Cannot discard truncated directory "{0}" because its contents exceed display limits. Please delete files individually or manage the directory directly on disk.', relPath)
      );
    }
    if (status?.svnItem === 'unversioned') {
      const absPath = path.join(this.rootPath, relPath);
      this.assertSafeWorkingFsPath(absPath);
      if (fs.existsSync(absPath)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true });
        } catch {
          const stat = fs.lstatSync(absPath);
          if (stat.isDirectory()) fs.rmSync(absPath, { recursive: true, force: true });
          else fs.unlinkSync(absPath);
        }
      }
      return;
    }
    const removeAfterRevert = status?.svnItem === 'added';
    const absPath = relPath === '.' ? this.rootPath : path.join(this.rootPath, relPath);
    this.assertSafeWorkingFsPath(absPath);
    await this.svn(['revert', '--depth', 'infinity', '--', this.workingCopyTarget(relPath)]);
    if (removeAfterRevert && fs.existsSync(absPath)) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true });
      } catch {
        const stat = fs.lstatSync(absPath);
        if (stat.isDirectory()) fs.rmSync(absPath, { recursive: true, force: true });
        else fs.unlinkSync(absPath);
      }
    }
    this.blameCache.delete(relPath);
  }

  async commit(message: string, amend: boolean): Promise<string> {
    if (amend) throw this.unsupported(t('Amend'));
    const paths = await this.changedPaths();
    if (paths.length === 0) throw new Error(t('No SVN changes to commit.'));
    return this.commitPaths(message, paths);
  }

  async commitPaths(message: string, paths: string[]): Promise<string> {
    return this.runStatusSensitiveOperation(async () => {
      const uniquePaths = Array.from(new Set(paths.map(filePath => this.normalizeSvnTarget(filePath))));
      if (uniquePaths.length === 0) throw new Error(t('No SVN files selected to commit.'));
      const statuses = await this.parseSvnStatus();
      const truncatedPaths = new Set(statuses.filter(file => file.isTruncated).map(file => file.path));
      const truncatedSelected = uniquePaths.filter(p => truncatedPaths.has(p));
      if (truncatedSelected.length > 0) {
        throw new Error(
          t('Cannot commit truncated directory "{0}" directly because its contents exceed display limits. Please use "Add entire truncated directory" first to confirm recursive inclusion.', truncatedSelected[0])
        );
      }
      const selected = new Set(uniquePaths);
      const pathsToAdd = statuses.filter(file => file.svnItem === 'unversioned' && selected.has(file.path)).map(file => file.path);
      const pathsToDelete = statuses.filter(file => file.svnItem === 'missing' && selected.has(file.path)).map(file => file.path);

      const vcsPath = pathsToAdd.find(p => isNestedVcsPath(p));
      if (vcsPath) {
        throw new Error(
          t('Adding nested repository metadata "{0}" to SVN is blocked to prevent exposing repository history or credentials. Please add it to svn:ignore.', vcsPath)
        );
      }

      const [inheritedIgnores] = await Promise.all([
        this.getInheritedGlobalIgnores().catch(() => []),
      ]);
      const clientGlobalIgnores = this.getClientGlobalIgnores();

      for (const targetPath of pathsToAdd) {
        const nestedVcs = await this.findUnignoredNestedVcsInDir(targetPath, clientGlobalIgnores, inheritedIgnores);
        if (nestedVcs) {
          throw new Error(
            t('Directory "{0}" contains nested repository metadata "{1}". Please add it to svn:ignore or add files selectively.', targetPath, nestedVcs)
          );
        }
      }

      const prunedPathsToAdd = pruneRedundantChildPaths(pathsToAdd);
      if (prunedPathsToAdd.length > 0) await this.runWithTargets(['add', '--parents'], prunedPathsToAdd);
      if (pathsToDelete.length > 0) await this.runWithTargets(['delete', '--force'], pathsToDelete);
      let commitTargets = uniquePaths;
      const commitArgs = ['commit', '-m', message, '--depth', 'empty'];
      // SVN directory commit targets recurse by default and can silently include
      // unchecked child changes. Keep every target depth-empty. A newly selected
      // unversioned directory is the one exception: it had no visible child status
      // rows before `svn add`, so explicitly include the descendants it just added.
      const newlyAddedDirectories = prunedPathsToAdd.filter(filePath => {
        if (filePath === '.') return false;
        const absolutePath = path.join(this.rootPath, filePath);
        try { return fs.lstatSync(absolutePath).isDirectory(); } catch { return false; }
      });
      if (newlyAddedDirectories.length > 0) {
        const refreshedStatuses = await this.parseSvnStatus();
        commitTargets = Array.from(new Set([
          ...uniquePaths,
          ...refreshedStatuses
            .filter(status => newlyAddedDirectories.some(directory => status.path.startsWith(`${directory}/`)))
            .map(status => status.path),
        ]));
      }

      // 若有新加入版本控制的文件（例如嵌套在新目录下的文件），
      // SVN commit --depth empty 要求其祖先新增目录也必须作为 commit target 提交，否则报 E200009 错误。
      if (pathsToAdd.length > 0) {
        const rawStatusAfterAdd = await this.svn(['status', '--xml']).catch(() => '');
        const addedPaths = new Set<string>();
        const entryRegex = /<entry\b([^>]*)>([\s\S]*?)<\/entry>/g;
        let entryMatch: RegExpExecArray | null;
        while ((entryMatch = entryRegex.exec(rawStatusAfterAdd)) !== null) {
          const rawPath = attr(entryMatch[1], 'path') ?? '';
          const normalizedPath = path.isAbsolute(rawPath)
            ? normalizeRelPath(path.relative(this.rootPath, rawPath))
            : normalizeRelPath(rawPath);
          const wcTag = entryMatch[2].match(/<wc-status\b([^>]*)\/?>/);
          if (wcTag && attr(wcTag[1], 'item') === 'added') {
            addedPaths.add(normalizedPath === '' ? '.' : normalizedPath);
          }
        }

        const ancestorDirectoriesToInclude: string[] = [];
        for (const targetPath of commitTargets) {
          const parts = targetPath.split('/');
          for (let i = 1; i < parts.length; i++) {
            const ancestor = parts.slice(0, i).join('/');
            if (ancestor && addedPaths.has(ancestor) && !commitTargets.includes(ancestor)) {
              ancestorDirectoriesToInclude.push(ancestor);
            }
          }
        }

        if (ancestorDirectoriesToInclude.length > 0) {
          commitTargets = Array.from(new Set([...ancestorDirectoriesToInclude, ...commitTargets]));
        }
      }
      const output = await this.runWithTargets(commitArgs, commitTargets);
      const outputNumbers = Array.from(output.matchAll(/\d+/g), match => Number(match[0]));
      const committedRevision = outputNumbers.at(-1);
      if (committedRevision !== undefined && Number.isSafeInteger(committedRevision)) {
        this.localRevisionFloor = Math.max(this.localRevisionFloor ?? 0, committedRevision);
        this.localRevisionMetadataMtimeMs = this.getWorkingCopyMetadataMtime();
      }
      this.clearIncomingStateCache();
      this.clearLogHistoryCache();
      this.blameCache.clear();
      if (this.pendingMerge) {
        const remainingStatuses = await this.parseSvnStatus().catch(() => []);
        const remainingPaths = new Set(remainingStatuses.map(file => file.path));
        this.pendingMerge.paths = this.pendingMerge.paths.filter(filePath => remainingPaths.has(filePath));
        this.pendingMerge.addedPaths = this.pendingMerge.addedPaths.filter(filePath => remainingPaths.has(filePath));
        if (this.pendingMerge.paths.length === 0) this.pendingMerge = undefined;
      }
      return output;
    }, 'commit', message);
  }

  async pull(): Promise<string> {
    return this.runStatusSensitiveOperation(async () => {
      await this.assertPullAllowed();
      const output = await this.svn(['update']);
      this.localRevisionGeneration++;
      this.localRevisionFloor = undefined;
      this.localRevisionFloorTask = undefined;
      this.clearIncomingStateCache();
      this.clearLogHistoryCache();
      this.blameCache.clear();
      return output;
    }, 'sync', 'svn update');
  }

  async pullRebase(): Promise<string> {
    return this.pull();
  }

  async pullBranch(branchName: string): Promise<string> {
    const current = await this.getCurrentBranch();
    if (branchName && current.name !== branchName) {
      throw new Error(t('SVN Update can only update the currently switched working-copy branch.'));
    }
    return this.pull();
  }

  async fetchAll(): Promise<void> {
    const info = await this.getInfo();
    await this.getIncomingState(info, { force: true });
  }

  async push(): Promise<void> {
    throw new Error(t('SVN commits are sent to the server during commit; Push is not used.'));
  }

  async getUnpushedCount(): Promise<number> {
    return 0;
  }

  async getRemotes(): Promise<string[]> {
    const info = await this.getInfo();
    return info.rootUrl ? [info.rootUrl] : [];
  }

  async getRemotesWithUrls(): Promise<{ name: string; fetchUrl: string; pushUrl: string }[]> {
    const info = await this.getInfo();
    return info.rootUrl ? [{ name: 'svn', fetchUrl: info.rootUrl, pushUrl: info.rootUrl }] : [];
  }

  async getRepositoryInfo(): Promise<SvnRepositoryInfo> {
    const info = await this.getInfo();
    return {
      url: info.url,
      rootUrl: info.rootUrl,
      relativeUrl: info.relativeUrl,
    };
  }

  async relocateRepository(newRootUrl: string): Promise<void> {
    const targetUrl = newRootUrl.trim();
    if (!targetUrl) throw new Error(t('SVN repository URL cannot be empty.'));
    const info = await this.getInfo();
    if (!info.rootUrl) throw new Error(t('Current SVN repository root URL is unavailable.'));
    if (info.rootUrl === targetUrl) throw new Error(t('New SVN repository URL is the same as the current URL.'));
    await this.svn(['switch', '--relocate', info.rootUrl, targetUrl]);
    this.clearIncomingStateCache();
    this.clearLogHistoryCache();
    this.blameCache.clear();
    this.repositoryUrlCache = undefined;
    SvnService.authKeyByRootPath.delete(this.rootPath);
    this.authenticationStatusCache = undefined;
  }

  async checkout(branchName: string, createNew?: boolean, from?: string): Promise<void> {
    await this.assertCheckoutAllowed();
    if (createNew) {
      await this.createBranch(branchName, from);
      await this.checkout(branchName);
      return;
    }

    const revision = branchName.match(/^r?(\d+)$/i)?.[1];
    if (revision) {
      await this.svn(['update', '-r', revision]);
      this.localRevisionGeneration++;
      this.localRevisionFloor = Number(revision);
      this.localRevisionFloorTask = undefined;
      this.clearIncomingStateCache();
      this.clearLogHistoryCache();
      this.blameCache.clear();
      return;
    }
    const target = this.repositoryRefTarget(branchName, branchName.startsWith('tags/') ? 'tags' : 'branches');
    await this.svn(['switch', target]);
    this.localRevisionGeneration++;
    this.localRevisionFloor = undefined;
    this.localRevisionFloorTask = undefined;
    this.clearIncomingStateCache();
    this.clearLogHistoryCache();
    this.blameCache.clear();
    this.repositoryUrlCache = undefined;
  }

  async checkoutForce(branchName: string): Promise<void> {
    await this.assertCheckoutAllowed();
    const statuses = await this.parseSvnStatus();
    const addedPaths = statuses.filter(file => file.svnItem === 'added').map(file => file.path);
    await this.svn(['revert', '--depth', 'infinity', '--', '.']);
    for (const addedPath of addedPaths.sort((left, right) => right.length - left.length)) {
      const absolutePath = path.join(this.rootPath, addedPath);
      this.assertSafeWorkingFsPath(absolutePath);
      if (!fs.existsSync(absolutePath)) continue;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true });
      else fs.unlinkSync(absolutePath);
    }
    await this.checkout(branchName);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    const name = this.normalizeRefName(branchName, 'branches');
    const source = from
      ? this.repositoryRefTarget(from, 'branches')
      : escapePegRevision((await this.getInfo()).url);
    await this.svn(['copy', source, this.repositoryRefTarget(name, 'branches'), '-m', `Create branch ${name}`]);
    this.remoteBranchesCache = undefined;
    this.clearIncomingStateCache();
  }

  async createBranchFromCommit(name: string, hash: string): Promise<void> {
    const revision = requireRevision(hash);
    const branchName = this.normalizeRefName(name, 'branches');
    const info = await this.getInfo();
    await this.svn([
      'copy', '-r', revision,
      `${info.url}@HEAD`,
      this.repositoryRefTarget(branchName, 'branches'),
      '-m', `Create branch ${branchName}`,
    ]);
    this.remoteBranchesCache = undefined;
    this.clearIncomingStateCache();
  }

  async deleteBranch(branchName: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    const name = this.normalizeRefName(branchName, 'branches');
    await this.svn(['delete', this.repositoryRefTarget(name, 'branches'), '-m', `Delete branch ${name}`]);
    this.remoteBranchesCache = undefined;
    this.clearIncomingStateCache();
  }

  async renameBranch(oldName: string, newName: string): Promise<void> {
    const source = this.normalizeRefName(oldName, 'branches');
    const target = this.normalizeRefName(newName, 'branches');
    await this.svn([
      'move',
      this.repositoryRefTarget(source, 'branches'),
      this.repositoryRefTarget(target, 'branches'),
      '-m', `Rename branch ${source} to ${target}`,
    ]);
    this.remoteBranchesCache = undefined;
    this.clearIncomingStateCache();
  }

  async createTag(name: string, hash: string): Promise<void> {
    const revision = requireRevision(hash);
    const tagName = this.normalizeRefName(name, 'tags');
    const info = await this.getInfo();
    await this.svn([
      'copy', '-r', revision,
      `${info.url}@HEAD`,
      this.repositoryRefTarget(tagName, 'tags'),
      '-m', `Create tag ${tagName}`,
    ]);
    this.remoteTagsCache = undefined;
    this.clearIncomingStateCache();
  }

  async deleteTag(name: string): Promise<void> {
    const tagName = this.normalizeRefName(name, 'tags');
    await this.svn(['delete', this.repositoryRefTarget(tagName, 'tags'), '-m', `Delete tag ${tagName}`]);
    this.remoteTagsCache = undefined;
    this.clearIncomingStateCache();
  }

  async checkoutTag(name: string): Promise<void> {
    await this.checkout(`tags/${name}`);
  }

  async pushTag(): Promise<void> {
    throw new Error(t('SVN tags are created on the server immediately; Push Tag is not used.'));
  }

  async deleteTagRemote(name: string): Promise<void> {
    await this.deleteTag(name);
  }

  private rememberPendingMerge(statuses: SvnStatusEntry[]): void {
    this.pendingMerge = statuses.length === 0 ? undefined : {
      paths: statuses.map(file => file.path),
      addedPaths: statuses.filter(file => file.svnItem === 'added').map(file => file.path),
    };
  }

  private async mergeSource(target: string): Promise<void> {
    if (await this.hasUncommittedChanges()) {
      throw new Error(t('SVN merge requires a clean working copy so it can be aborted without losing local changes.'));
    }
    try {
      await this.svn(['merge', target]);
    } catch (error: unknown) {
      this.rememberPendingMerge(await this.parseSvnStatus().catch(() => []));
      throw error;
    }
    this.rememberPendingMerge(await this.parseSvnStatus());
    this.blameCache.clear();
  }

  async merge(from: string): Promise<void> {
    await this.assertBranchOperationAllowed();
    const target = this.repositoryRefTarget(from, from.startsWith('tags/') ? 'tags' : 'branches');
    await this.mergeSource(target);
  }

  async mergeTag(name: string): Promise<void> {
    await this.mergeSource(this.repositoryRefTarget(name, 'tags'));
  }

  async getTagsForCommit(): Promise<string[]> {
    return [];
  }

  async getBranchesContaining(): Promise<{ local: string[]; remote: string[]; tags: string[] }> {
    return { local: [], remote: [], tags: [] };
  }

  private async getCommitMetaAndMessage(hash: string): Promise<{
    meta: { hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] };
    fullMessage: string;
  }> {
    const revision = requireRevision(hash);
    const cached = this.commitMetaCache.get(revision);
    if (cached) return await cached;
    const task = (async () => {
      const raw = await this.svn(['log', '--xml', '-r', revision]);
      const entry = this.parseLogEntries(raw)[0];
      const revisionHash = `r${revision}`;
      const fullMessage = entry?.message ?? '';
      const meta = {
        hash: revisionHash,
        shortHash: revisionHash,
        message: fullMessage.split('\n')[0] ?? t('SVN revision {0}', revision),
        authorName: entry?.author || t('Unknown'),
        authorEmail: '',
        authorDate: entry?.date ?? '',
        committerDate: entry?.date ?? '',
        parents: [],
      };
      return { meta, fullMessage };
    })().catch(error => {
      if (this.commitMetaCache.get(revision) === task) this.commitMetaCache.delete(revision);
      throw error;
    });
    this.commitMetaCache.set(revision, task);
    if (this.commitMetaCache.size > SVN_COMMIT_META_CACHE_LIMIT) {
      const oldestKey = this.commitMetaCache.keys().next().value;
      if (oldestKey) this.commitMetaCache.delete(oldestKey);
    }
    return await task;
  }

  async getFullCommitMessage(hash: string): Promise<string> {
    const data = await this.getCommitMetaAndMessage(hash);
    return data.fullMessage;
  }

  override async getLastCommitMessage(): Promise<string> {
    const history = await this.getRecentCommitMessages(1);
    return history[0]?.message ?? '';
  }

  override async getRecentCommitMessages(limit: number): Promise<CommitMessageHistoryEntry[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    let raw = await this.svn(['log', '--xml', '-r', 'HEAD:1', '--limit', String(safeLimit)], { timeout: 10_000 }).catch(() => '');
    if (!raw.trim()) {
      raw = await this.svn(['log', '--xml', '--limit', String(safeLimit)], { timeout: 10_000 }).catch(() => '');
    }
    const entries = this.parseLogEntries(raw);
    this.populateCommitMetaCacheFromLogEntries(entries);
    return entries.flatMap(entry => {
      const message = entry.message.trim();
      if (!message) return [];
      const timestamp = Date.parse(entry.date);
      return [{ message, timestamp: Number.isFinite(timestamp) ? timestamp : 0 }];
    });
  }

  async getCommitMeta(hash: string): Promise<{ hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] }> {
    const data = await this.getCommitMetaAndMessage(hash);
    return data.meta;
  }

  async createPatch(hash: string): Promise<string> {
    return this.svn(['diff', '-c', requireRevision(hash)]);
  }

  async cherryPick(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async cherryPickMulti(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async cherryPickContinue(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async cherryPickSkip(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async cherryPickAbort(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  private async exportRevisionToWorkingCopy(revision: string, filePath: string): Promise<boolean> {
    const relPath = this.normalizeRepoPath(filePath);
    const repositoryUrl = await this.getRepositoryUrl();
    const status = (await this.parseSvnStatus()).find(file => file.path === relPath);
    if (status?.svnItem === 'deleted') {
      await this.svn(['revert', '--depth', 'infinity', '--', this.workingCopyTarget(relPath)]);
    }
    const absolutePath = path.join(this.rootPath, relPath);
    const temporaryPath = path.join(os.tmpdir(), `versiondock-svn-export-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      let exported = false;
      for (const source of this.repositoryFileTargets(repositoryUrl, relPath, revision)) {
        try {
          await this.svn(['export', '--force', '-r', revision, source, temporaryPath]);
          exported = true;
          break;
        } catch (error: unknown) {
          await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
          if (!this.isPathNotFoundError(error)) throw error;
        }
      }
      if (!exported) return false;
      await this.copyExportedNodeToWorkingCopy(temporaryPath, absolutePath);
      this.blameCache.delete(relPath);
      return true;
    } finally {
      await fs.promises.rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async checkoutFileFromCommit(hash: string, filePath: string): Promise<void> {
    const revision = requireRevision(hash);
    if (!await this.exportRevisionToWorkingCopy(revision, filePath)) {
      throw new Error(t('SVN path "{0}" does not exist at revision r{1}.', filePath, revision));
    }
  }

  async revertFileToParent(hash: string, filePath: string): Promise<void> {
    const revision = requireRevision(hash);
    const previousRevision = String(Math.max(0, Number(revision) - 1));
    const relPath = this.normalizeRepoPath(filePath);
    if (!await this.exportRevisionToWorkingCopy(previousRevision, relPath)) {
      const absolutePath = path.join(this.rootPath, relPath);
      this.assertSafeWorkingFsPath(absolutePath);
      if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath, { recursive: true, force: true });
      this.blameCache.delete(relPath);
      return;
    }
  }

  async hasFileAtRef(ref: string, filePath: string): Promise<boolean> {
    const match = ref.match(/^r?(\d+)(~1)?$/i);
    if (!match) return false;
    const revision = Math.max(0, Number(match[1]) - (match[2] ? 1 : 0));
    return (await this.getRevisionContentOrUndefined(String(revision), this.normalizeRepoPath(filePath)).catch(() => undefined)) !== undefined;
  }

  async revertCommit(hash: string): Promise<void> {
    if (await this.hasUncommittedChanges()) {
      throw new Error(t('SVN commit revert requires a clean working copy. Commit or roll back local changes first.'));
    }
    const revision = requireRevision(hash);
    // SVN merge refuses mixed-revision working copies, which are normal after
    // a partial commit. Bring the clean working copy to one BASE first.
    await this.pull();
    const info = await this.getInfo();
    await this.svn(['merge', '-c', `-${revision}`, `${info.url}@HEAD`]);
    const statuses = await this.parseSvnStatus();
    if (statuses.length === 0) throw new Error(t('SVN revision r{0} has no changes applicable to this working copy.', revision));
    this.pendingRevert = {
      message: `Revert r${revision}`,
      paths: statuses.map(file => file.path),
      addedPaths: statuses.filter(file => file.svnItem === 'added').map(file => file.path),
    };
    if (statuses.some(file => file.status === 'conflicted')) {
      throw new Error(t('SVN revert has CONFLICTS. Resolve them, then continue or abort the revert.'));
    }
    await this.revertContinue();
  }

  async revertCommits(hashes: string[]): Promise<void> {
    for (const hash of hashes) await this.revertCommit(hash);
  }

  async revertContinue(): Promise<void> {
    const pending = this.pendingRevert;
    if (!pending) throw new Error(t('No SVN commit revert is pending.'));
    const statuses = await this.parseSvnStatus();
    if (statuses.some(file => file.status === 'conflicted')) {
      throw new Error(t('SVN revert still has CONFLICTS. Resolve all files before continuing.'));
    }
    const changed = new Set(statuses.map(file => file.path));
    const paths = pending.paths.filter(filePath => changed.has(filePath));
    if (paths.length === 0) {
      this.pendingRevert = undefined;
      throw new Error(t('No SVN changes remain to commit for the pending revert.'));
    }
    await this.commitPaths(pending.message, paths);
    this.pendingRevert = undefined;
  }

  async revertAbort(): Promise<void> {
    const pending = this.pendingRevert;
    if (!pending) throw new Error(t('No SVN commit revert is pending.'));
    await this.runWithTargets(['revert', '--depth', 'infinity'], pending.paths);
    for (const addedPath of pending.addedPaths.sort((left, right) => right.length - left.length)) {
      const absolutePath = path.join(this.rootPath, addedPath);
      this.assertSafeWorkingFsPath(absolutePath);
      if (!fs.existsSync(absolutePath)) continue;
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true });
      else fs.unlinkSync(absolutePath);
    }
    this.pendingRevert = undefined;
    this.blameCache.clear();
  }

  async resetTo(): Promise<void> {
    throw this.unsupported(t('Reset'));
  }

  async dropCommit(): Promise<void> {
    throw this.unsupported(t('Drop Commit'));
  }

  async dropCommits(): Promise<void> {
    throw this.unsupported(t('Drop Commits'));
  }

  async undoCommit(): Promise<void> {
    throw this.unsupported(t('Undo Commit'));
  }

  async editCommitMessage(): Promise<void> {
    throw this.unsupported(t('Edit Commit Message'));
  }

  async rebase(): Promise<void> {
    throw this.unsupported(t('Rebase'));
  }

  async abortRebase(): Promise<void> {
    throw this.unsupported(t('Rebase'));
  }

  async squashCommits(): Promise<void> {
    throw this.unsupported(t('Squash'));
  }

  async canSquashCommitRange(_hashes: string[]): Promise<{ ok: boolean; hashes: string[]; oldestHash?: string; reason?: string }> {
    return { ok: false, hashes: [], reason: this.unsupported(t('Squash')).message };
  }

  async rewordCommit(): Promise<void> {
    throw this.unsupported(t('Edit Commit Message'));
  }

  async pullFromRemote(): Promise<void> {
    throw new Error(t('SVN Update uses the working copy URL and does not accept a Git remote/branch pair.'));
  }

  async acceptOurs(filePath: string): Promise<void> {
    try {
      await this.svn(['resolve', '--accept', 'mine-full', '--', this.workingCopyTarget(filePath)]);
    } catch (error: unknown) {
      if (!this.errorText(error).toLowerCase().includes('w195024')) throw error;
      await this.acceptTreeConflictSide(filePath, 'ours');
    }
    this.blameCache.delete(this.normalizeSvnTarget(filePath));
  }

  async acceptTheirs(filePath: string): Promise<void> {
    try {
      await this.svn(['resolve', '--accept', 'theirs-full', '--', this.workingCopyTarget(filePath)]);
    } catch (error: unknown) {
      if (!this.errorText(error).toLowerCase().includes('w195024')) throw error;
      await this.acceptTreeConflictSide(filePath, 'theirs');
    }
    this.blameCache.delete(this.normalizeSvnTarget(filePath));
  }

  private async acceptTreeConflictSide(filePath: string, side: 'ours' | 'theirs'): Promise<void> {
    const relPath = this.normalizeSvnTarget(filePath);
    const target = this.workingCopyTarget(relPath);
    const absolutePath = path.join(this.rootPath, relPath);
    const rawInfo = await this.svn(['info', '--xml', '--', target]).catch(() => '');
    const treeTag = rawInfo.match(/<tree-conflict\b([^>]*)>/);
    const operation = treeTag ? attr(treeTag[1], 'operation') : undefined;
    const kind = treeTag ? attr(treeTag[1], 'kind') : undefined;

    if (side === 'ours') {
      // `working` is the only SVN-native tree-conflict choice and preserves the
      // complete local node kind, properties, symlink state and directory tree.
      await this.svn(['resolve', '--accept', 'working', '--', target]);
      return;
    }

    if (operation === 'update' || operation === 'switch') {
      // For update/switch conflicts the WC BASE is already the incoming side.
      // Remove the obstructing local node first so revert restores that side
      // exactly, including directories, binary files, symlinks and properties.
      this.assertSafeWorkingFsPath(absolutePath);
      try {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true });
        else fs.unlinkSync(absolutePath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await this.svn(['revert', '--depth', 'infinity', '--', target]);
      return;
    }

    if (operation === 'merge' && kind !== 'dir') {
      // A merge keeps the target BASE, so revert would select ours. For regular
      // text files, materialize the incoming content and mark that working state
      // resolved. Non-text/special files are rejected by getFileVersions before
      // any mutation instead of being UTF-8 corrupted.
      const versions = await this.getFileVersions(relPath);
      this.prepareWorkingFileWrite(absolutePath);
      fs.writeFileSync(absolutePath, versions.theirs, 'utf8');
      await this.svn(['resolve', '--accept', 'working', '--', target]);
      return;
    }

    throw new Error(t('SVN directory merge conflicts must be resolved manually to preserve the complete tree and properties.'));
  }

  async resolveWorking(filePath: string): Promise<void> {
    await this.svn(['resolve', '--accept', 'working', '--', this.workingCopyTarget(filePath)]);
    this.blameCache.delete(this.normalizeSvnTarget(filePath));
  }

  private readPropertyConflictValues(rawInfo: string, conflictPath: string): ConflictPropertyValue[] {
    const propertyFile = textTag(rawInfo, 'prop-file', false).trim();
    const normalizedPath = conflictPath === '.' ? '' : conflictPath.replace(/^\.\//, '');
    const artifactPath = normalizedPath
      ? path.join(this.rootPath, normalizedPath, '..', path.basename(normalizedPath) + '.prej')
      : path.join(this.rootPath, 'dir_conflicts.prej');
    const directoryArtifactPath = normalizedPath
      ? path.join(this.rootPath, normalizedPath, 'dir_conflicts.prej')
      : path.join(this.rootPath, 'dir_conflicts.prej');
    const candidates = Array.from(new Set([
      propertyFile ? path.resolve(propertyFile) : '',
      artifactPath,
      directoryArtifactPath,
    ].filter(Boolean)));
    for (const candidate of candidates) {
      try {
        this.assertSafeWorkingFsPath(candidate);
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
        const values = parsePropertyConflictContent(fs.readFileSync(candidate, 'utf8'));
        if (values.length > 0) return values;
      } catch {
        // SVN info may point at a revision artifact instead of the generated .prej file.
      }
    }
    return [];
  }

  async getConflictFileStatuses(): Promise<Map<string, ConflictFileStatus>> {
    const statuses = new Map<string, ConflictFileStatus>();
    const files = await this.parseSvnStatus();
    const conflicts = files.filter(file => file.status === 'conflicted');
    for (let offset = 0; offset < conflicts.length; offset += 8) {
      await Promise.all(conflicts.slice(offset, offset + 8).map(async file => {
        const currentStatus = file.svnItem === 'added'
          ? 'added'
          : file.svnItem === 'deleted' || file.svnItem === 'missing'
            ? 'deleted'
            : 'modified';
        const rawInfo = await this.svn(['info', '--xml', '--', this.workingCopyTarget(file.path)]).catch(() => '');
        const entryKind = attr(rawInfo.match(/<entry\b([^>]*)>/)?.[1] ?? '', 'kind');
        const treeConflict = rawInfo.match(/<tree-conflict\b([^>]*)>/);
        const conflictTypes = new Set<ConflictType>();
        const conflictRegex = /<conflict\b([^>]*)>/g;
        let conflictMatch: RegExpExecArray | null;
        while ((conflictMatch = conflictRegex.exec(rawInfo)) !== null) {
          const type = attr(conflictMatch[1], 'type');
          if (type === 'text' || type === 'property' || type === 'tree') conflictTypes.add(type);
        }
        if (file.svnProps === 'conflicted') conflictTypes.add('property');
        if (treeConflict || file.treeConflicted) conflictTypes.add('tree');
        if (conflictTypes.size === 0) conflictTypes.add('unknown');
        const orderedConflictTypes = (['text', 'property', 'tree', 'unknown'] as ConflictType[])
          .filter(type => conflictTypes.has(type));
        const primaryConflictType = orderedConflictTypes[0];
        const nodeKind = entryKind === 'dir' || attr(treeConflict?.[1] ?? '', 'kind') === 'dir'
          ? 'directory'
          : 'file';
        const kinds = new Map<string, string>();
        const versionRegex = /<version\b([^>]*)\/>/g;
        let match: RegExpExecArray | null;
        while ((match = versionRegex.exec(rawInfo)) !== null) {
          const side = attr(match[1], 'side');
          const kind = attr(match[1], 'kind');
          if (side && kind) kinds.set(side, kind);
        }
        const leftKind = kinds.get('source-left');
        const rightKind = kinds.get('source-right');
        const incomingStatus = rightKind === 'none'
          ? 'deleted'
          : leftKind === 'none' && !!rightKind
            ? 'added'
            : 'modified';
        statuses.set(file.path, {
          currentStatus,
          incomingStatus,
          nodeKind,
          conflictType: primaryConflictType,
          conflictTypes: orderedConflictTypes,
          propertyConflicts: conflictTypes.has('property') ? this.readPropertyConflictValues(rawInfo, file.path) : [],
        });
      }));
    }
    return statuses;
  }

  async getFileVersions(filePath: string): Promise<{ base: string; ours: string; theirs: string; language: string }> {
    const relPath = this.normalizeSvnTarget(filePath);
    const absPath = path.join(this.rootPath, relPath);
    this.assertSafeWorkingFsPath(absPath);
    const dir = path.dirname(absPath);
    const baseName = path.basename(absPath);
    const target = this.workingCopyTarget(relPath);
    const rawInfo = await this.svn(['info', '--xml', '--', target]).catch(() => '');
    const entryKind = attr(rawInfo.match(/<entry\b([^>]*)>/)?.[1] ?? '', 'kind')
      ?? attr(rawInfo.match(/<tree-conflict\b([^>]*)>/)?.[1] ?? '', 'kind');
    if (entryKind === 'dir') {
      throw new Error(t('SVN directory conflicts cannot be edited as text. Choose a conflict side or resolve the directory manually.'));
    }

    const [mimeType, specialProperty] = await Promise.all([
      this.svn(['propget', 'svn:mime-type', '--', target]).catch(() => ''),
      this.svn(['propget', 'svn:special', '--', target]).catch(() => ''),
    ]);
    const normalizedMimeType = mimeType.trim().toLowerCase();
    const binaryMimeType = !!normalizedMimeType
      && !normalizedMimeType.startsWith('text/')
      && normalizedMimeType !== 'image/x-xbitmap'
      && normalizedMimeType !== 'image/x-xpixmap';
    const workingFile = this.readWorkingFile(absPath);
    let workingIsSymlink = false;
    try { workingIsSymlink = fs.lstatSync(absPath).isSymbolicLink(); } catch { /* target may be deleted */ }
    if (binaryMimeType || !!specialProperty.trim() || workingIsSymlink || workingFile?.isBinary) {
      throw new Error(t('Binary file — no diff available'));
    }

    const readArtifact = (tagName: string): { content?: string; isBinary: boolean } => {
      const artifactPath = textTag(rawInfo, tagName, false);
      if (!artifactPath) return { isBinary: false };
      try {
        const decoded = decodeUtf8Buffer(fs.readFileSync(artifactPath));
        return { content: decoded.content, isBinary: decoded.isBinary };
      } catch {
        return { isBinary: false };
      }
    };
    const sourceKind = (side: 'source-left' | 'source-right'): string | undefined => {
      const versionRegex = /<version\b([^>]*)\/>/g;
      let match: RegExpExecArray | null;
      while ((match = versionRegex.exec(rawInfo)) !== null) {
        if (attr(match[1], 'side') === side) return attr(match[1], 'kind');
      }
      return undefined;
    };
    const sourceContent = async (side: 'source-left' | 'source-right'): Promise<{ content?: string; isBinary: boolean }> => {
      const versionRegex = /<version\b([^>]*)\/>/g;
      let match: RegExpExecArray | null;
      while ((match = versionRegex.exec(rawInfo)) !== null) {
        if (attr(match[1], 'side') !== side) continue;
        const reposUrl = attr(match[1], 'repos-url');
        const pathInRepos = attr(match[1], 'path-in-repos');
        const revision = attr(match[1], 'revision');
        if (!reposUrl || pathInRepos === undefined || !revision) return { isBinary: false };
        if (attr(match[1], 'kind') === 'none') return { content: '', isBinary: false };
        const target = `${reposUrl.replace(/\/$/, '')}/${this.encodeRepositoryPath(pathInRepos)}@${revision}`;
        const content = await this.svn(['cat', '-r', revision, target]).catch(() => undefined);
        return { content, isBinary: content !== undefined && isLikelyBinaryContent(content) };
      }
      return { isBinary: false };
    };

    const oursArtifact = readArtifact('prev-wc-file');
    const baseArtifact = readArtifact('prev-base-file');
    const theirsArtifact = readArtifact('cur-base-file');
    const leftSource = baseArtifact.content === undefined ? await sourceContent('source-left') : { isBinary: false };
    const rightSource = theirsArtifact.content === undefined ? await sourceContent('source-right') : { isBinary: false };
    if (oursArtifact.isBinary || baseArtifact.isBinary || theirsArtifact.isBinary || leftSource.isBinary || rightSource.isBinary) {
      throw new Error(t('Binary file — no diff available'));
    }

    let ours = oursArtifact.content ?? workingFile?.content ?? '';
    let base = baseArtifact.content ?? leftSource.content ?? '';
    let theirs = theirsArtifact.content ?? rightSource.content ?? '';

    let sideFiles: string[] = [];
    try {
      sideFiles = fs.readdirSync(dir)
        .filter(name => new RegExp(`^${escapeRegExp(baseName)}(?:\\.r|\\.merge-(?:left|right)\\.r)\\d+$`).test(name))
        .sort((left, right) => Number(left.match(/\.r(\d+)$/)?.[1] ?? 0) - Number(right.match(/\.r(\d+)$/)?.[1] ?? 0));
    } catch {
      sideFiles = [];
    }

    if (!base && sourceKind('source-left') !== 'none' && sideFiles.length > 0) {
      try {
        const decoded = decodeUtf8Buffer(fs.readFileSync(path.join(dir, sideFiles[0])));
        if (decoded.isBinary) throw new Error(t('Binary file — no diff available'));
        base = decoded.content;
      } catch (error: unknown) {
        if (error instanceof Error && error.message === t('Binary file — no diff available')) throw error;
        base = '';
      }
    }
    if (!theirs && sourceKind('source-right') !== 'none' && sideFiles.length > 0) {
      try {
        const decoded = decodeUtf8Buffer(fs.readFileSync(path.join(dir, sideFiles[sideFiles.length - 1])));
        if (decoded.isBinary) throw new Error(t('Binary file — no diff available'));
        theirs = decoded.content;
      } catch (error: unknown) {
        if (error instanceof Error && error.message === t('Binary file — no diff available')) throw error;
        theirs = '';
      }
    }
    if (!base && sourceKind('source-left') !== 'none') {
      base = await this.svn(['cat', '--', this.workingCopyTarget(relPath)]).catch(() => '');
    }
    if (!theirs && sourceKind('source-right') !== 'none') theirs = base;
    if (!ours) ours = workingFile?.content ?? '';

    return { base, ours, theirs, language: detectLanguage(relPath) };
  }

  async saveMergedContent(filePath: string, content: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absolutePath = path.join(this.rootPath, relPath);
    // Re-validate on save, not only while loading the editor. This is the host
    // boundary that prevents a stale or forged webview message from rewriting
    // binary files or SVN symlinks through UTF-8 text.
    await this.getFileVersions(relPath);
    const status = (await this.parseSvnStatus()).find(file => file.path === relPath);
    if (status?.treeConflicted) {
      const target = this.workingCopyTarget(relPath);
      await this.svn(['revert', '--depth', 'infinity', '--', target]);
      const isVersioned = await this.svn(['info', '--xml', '--', target]).then(() => true).catch(() => false);
      this.prepareWorkingFileWrite(absolutePath);
      fs.writeFileSync(absolutePath, content, 'utf8');
      if (!isVersioned) await this.svn(['add', '--parents', '--', this.workingCopyTarget(relPath)]);
      this.blameCache.delete(relPath);
      return;
    }
    this.prepareWorkingFileWrite(absolutePath);
    fs.writeFileSync(absolutePath, content, 'utf8');
    await this.resolveWorking(relPath);
  }

  async deleteMergedFile(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absPath = path.join(this.rootPath, relPath);
    const status = (await this.parseSvnStatus()).find(file => file.path === relPath);
    if (status?.status === 'conflicted') {
      const target = this.workingCopyTarget(relPath);
      await this.svn(['revert', '--depth', 'infinity', '--', target]);
      const isVersioned = await this.svn(['info', '--xml', '--', target]).then(() => true).catch(() => false);
      if (isVersioned) await this.svn(['delete', '--force', '--', target]);
      if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
      this.blameCache.delete(relPath);
      return;
    }
    if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    await this.svn(['delete', '--force', '--', this.workingCopyTarget(relPath)]);
    this.blameCache.delete(relPath);
  }

  async getMergeRebaseState(): Promise<'merge' | 'rebase' | null> {
    // SVN does not persist a generic "merge in progress" marker. Only expose
    // Abort when this service recorded the complete path set for a merge/revert
    // that it started; treating arbitrary update conflicts as abortable would
    // make `svn revert` destroy the user's pre-update edits.
    if (this.pendingRevert) return 'merge';
    if (!this.pendingMerge) return null;
    const currentPaths = new Set((await this.parseSvnStatus()).map(file => file.path));
    this.pendingMerge.paths = this.pendingMerge.paths.filter(filePath => currentPaths.has(filePath));
    this.pendingMerge.addedPaths = this.pendingMerge.addedPaths.filter(filePath => currentPaths.has(filePath));
    if (this.pendingMerge.paths.length === 0) {
      this.pendingMerge = undefined;
      return null;
    }
    return 'merge';
  }

  private async removeRevertedAddedPaths(paths: string[]): Promise<void> {
    for (const addedPath of paths.slice().sort((left, right) => right.length - left.length)) {
      const absolutePath = path.join(this.rootPath, addedPath);
      this.assertSafeWorkingFsPath(absolutePath);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(absolutePath); } catch { continue; }
      if (stat.isDirectory()) fs.rmSync(absolutePath, { recursive: true, force: true });
      else fs.unlinkSync(absolutePath);
    }
  }

  async abortMerge(): Promise<void> {
    if (this.pendingRevert) {
      await this.revertAbort();
      return;
    }
    const pending = this.pendingMerge;
    if (!pending) throw new Error(t('No abortable SVN merge is pending.'));
    await this.runWithTargets(['revert', '--depth', 'infinity'], pending.paths);
    await this.removeRevertedAddedPaths(pending.addedPaths);
    this.pendingMerge = undefined;
    this.blameCache.clear();
  }

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    return [];
  }

  async stashCount(): Promise<number> {
    return 0;
  }

  async stashList(): Promise<StashEntry[]> {
    return [];
  }

  async stashShow(): Promise<string> {
    throw this.unsupported(t('Stash'));
  }

  async stashPush(): Promise<void> {
    throw this.unsupported(t('Stash'));
  }

  async stashApply(): Promise<void> {
    throw this.unsupported(t('Stash'));
  }

  async stashPop(): Promise<void> {
    throw this.unsupported(t('Stash'));
  }

  async stashDrop(): Promise<void> {
    throw this.unsupported(t('Stash'));
  }

  async getStashFileContent(): Promise<string> {
    return '';
  }

  async getWorktrees(): Promise<[]> {
    return [];
  }

  async createWorktree(): Promise<void> {
    throw this.unsupported(t('Worktrees'));
  }

  async deleteWorktree(): Promise<void> {
    throw this.unsupported(t('Worktrees'));
  }

  async pruneWorktrees(): Promise<void> {
    throw this.unsupported(t('Worktrees'));
  }

  async lockWorktree(): Promise<void> {
    throw this.unsupported(t('Worktrees'));
  }

  async unlockWorktree(): Promise<void> {
    throw this.unsupported(t('Worktrees'));
  }

  async cleanup(): Promise<string> {
    return this.svn(['cleanup']);
  }

  async lock(paths: string[], message?: string): Promise<string> {
    const args = ['lock'];
    if (message?.trim()) args.push('-m', message.trim());
    return this.runWithTargets(args, paths);
  }

  async unlock(paths: string[]): Promise<string> {
    return this.runWithTargets(['unlock'], paths);
  }

  async hasUncommittedChanges(): Promise<boolean> {
    return (await this.changedPaths()).length > 0;
  }
}
