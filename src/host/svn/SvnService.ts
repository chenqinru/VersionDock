import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitService, type CommitMessageHistoryEntry } from '../git/GitService';
import { detectLanguage, parseDiff } from '../git/DiffParser';
import type { BlameLine } from '../git/BlameService';
import type { BranchInfo, CommitNode, FileDiff, FileStatus, GitFileStatus, LineRange, RepoStatus } from '../types/git';
import type { StashEntry, UnpushedCommit } from '../types/messages';
import { CliError, execCli } from '../vcs/cli';
import { t } from '../utils/l10n';

const SVN_REVISION_CONTENT_CACHE_LIMIT = 200;
const SVN_BLAME_CACHE_LIMIT = 20;
const SVN_AUTH_REPROMPT_DELAY_MS = 30_000;
const SVN_INCOMING_STATE_CACHE_TTL_MS = 60_000;
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

interface SvnLogEntry {
  revision: string;
  author: string;
  date: string;
  message: string;
}

interface SvnIncomingState {
  localRevision?: number;
  remoteRevision?: number;
  behind: number;
  incomingRevisions: Set<string>;
  checkedAt: number;
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
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function attr(source: string, name: string): string | undefined {
  const match = source.match(new RegExp(`${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : undefined;
}

function textTag(source: string, name: string): string {
  const match = source.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`));
  return match ? decodeXml(match[1].trim()) : '';
}

function normalizeRelPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\/+/, '');
}

function splitIgnoreLines(value: string): string[] {
  return value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function svnItemToStatus(item: string, props?: string): GitFileStatus | null {
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

function svnActionToStatus(action: string): string {
  switch (action) {
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'M';
    case 'M':
    default:
      return 'M';
  }
}

function parseRevision(hash: string): string {
  return hash.replace(/^r/i, '').trim();
}

function parseRevisionNumber(value?: string): number | undefined {
  const revision = parseRevision(value ?? '');
  if (!revision) return undefined;
  const parsed = Number.parseInt(revision, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseSvnDate(value: string): Date {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function parseInfoRevision(raw: string): number | undefined {
  const entryRevision = attr(raw.match(/<entry\b[^>]*>/)?.[0] ?? '', 'revision');
  const commitRevision = attr(raw.match(/<commit\b[^>]*>/)?.[0] ?? '', 'revision');
  return parseRevisionNumber(entryRevision ?? commitRevision);
}

function buildSyntheticGitDiff(raw: string): string {
  if (!raw.trim()) return '';
  const chunks = raw.split(/^Index:\s+/m).filter(Boolean);
  if (chunks.length === 0) return raw;
  return chunks.map(chunk => {
    const nl = chunk.indexOf('\n');
    const filePath = normalizeRelPath((nl === -1 ? chunk : chunk.slice(0, nl)).trim());
    const body = nl === -1 ? '' : chunk.slice(nl + 1);
    return `diff --git a/${filePath} b/${filePath}\n${body}`;
  }).join('\n');
}

export class SvnService extends GitService {
  public readonly kind: 'git' | 'svn' = 'svn';
  private static readonly authCredentials = new Map<string, SvnCredentials>();
  private static readonly authPromptTasks = new Map<string, Promise<SvnCredentials | undefined>>();
  private static readonly authKeyByRootPath = new Map<string, string>();
  private static readonly authKeyTasks = new Map<string, Promise<string | undefined>>();
  private static readonly authFailureTimes = new Map<string, number>();
  private readonly revisionContentCache = new Map<string, Promise<string>>();
  private readonly blameCache = new Map<string, Promise<BlameLine[]>>();
  private incomingStateCache?: SvnIncomingState;
  private incomingStateTask?: Promise<SvnIncomingState>;
  private authenticationStatusCache?: { expiresAt: number; status: SvnAuthenticationStatus };

  constructor(repoId: string, rootPath: string) {
    super(repoId, rootPath);
  }

  private async svn(args: string[]): Promise<string> {
    const cachedKey = await this.resolveWorkingCopyAuthKey();

    if (cachedKey) {
      const preferredCredentials = SvnService.authCredentials.get(cachedKey);
      if (preferredCredentials) {
        try {
          return await this.runWithCredentials(args, cachedKey, preferredCredentials);
        } catch (error: unknown) {
          if (!this.isAuthenticationError(error)) throw error;
        }
      }
    }

    try {
      const result = await execCli('svn', args, { cwd: this.rootPath });
      return result.stdout;
    } catch (error: unknown) {
      if (!this.isAuthenticationError(error)) throw error;

      const authKey = await this.getAuthKey(error, cachedKey);
      SvnService.authKeyByRootPath.set(this.rootPath, authKey);

      const sharedCredentials = SvnService.authCredentials.get(authKey);
      if (sharedCredentials) {
        try {
          return await this.runWithCredentials(args, authKey, sharedCredentials);
        } catch (retryError: unknown) {
          if (!this.isAuthenticationError(retryError)) throw retryError;
        }
      }

      const svnScmResult = await this.trySvnScmCredentials(args, authKey);
      if (svnScmResult !== undefined) return svnScmResult;

      if (this.isAuthPromptSuppressed(authKey)) throw error;
      const credentials = await this.promptForCredentials(authKey);
      if (!credentials) {
        this.rememberAuthFailure(authKey);
        throw error;
      }

      try {
        return await this.runWithCredentials(args, authKey, credentials);
      } catch (retryError: unknown) {
        if (this.isAuthenticationError(retryError)) this.rememberAuthFailure(authKey);
        throw retryError;
      }
    }
  }

  private async runWithCredentials(args: string[], authKey: string, credentials: SvnCredentials): Promise<string> {
    SvnService.authCredentials.set(authKey, credentials);
    try {
      const result = await execCli('svn', this.withAuthArgs(args, credentials, credentials.remember !== false), {
        cwd: this.rootPath,
        stdin: `${credentials.password}\n`,
      });
      SvnService.authFailureTimes.delete(authKey);
      this.authenticationStatusCache = undefined;
      return result.stdout;
    } catch (error: unknown) {
      if (this.isAuthenticationError(error)) SvnService.authCredentials.delete(authKey);
      throw error;
    }
  }

  private withAuthArgs(args: string[], credentials: SvnCredentials, remember: boolean): string[] {
    const authArgs = [
      '--username', credentials.username,
      '--password-from-stdin',
      '--non-interactive',
      ...(remember ? SVN_AUTH_CACHE_ARGS : ['--no-auth-cache']),
    ];
    const pathSeparatorIndex = args.indexOf('--');
    if (pathSeparatorIndex === -1) return [...args, ...authArgs];
    return [
      ...args.slice(0, pathSeparatorIndex),
      ...authArgs,
      ...args.slice(pathSeparatorIndex),
    ];
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

  private async trySvnScmCredentials(args: string[], authKey: string): Promise<string | undefined> {
    const credentials = await this.getSvnScmCredentials();
    for (const credential of credentials) {
      try {
        return await this.runWithCredentials(args, authKey, credential);
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
    const status = await this.getAuthenticationStatus(true);
    const pattern = status.realm ?? (status.authKey ? `*${status.authKey}*` : undefined);
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
        relativeUrl: textTag(result.stdout, 'relative-url').replace(/^\^\/?/, ''),
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
    try {
      const args = authKey ? ['auth', `*${authKey}*`] : ['auth'];
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
    const fromWorkingCopy = fallback ?? await this.getAuthKeyFromWorkingCopy();
    return fromWorkingCopy ?? this.rootPath;
  }

  private getAuthKeyFromText(text: string): string | undefined {
    const urlText = text.match(/URL\s+'([^']+)'/i)?.[1]
      ?? text.match(/repository at URL\s+'([^']+)'/i)?.[1];
    return urlText ? this.normalizeAuthKey(urlText) : undefined;
  }

  private normalizeAuthKey(urlText: string): string {
    try {
      const url = new URL(urlText);
      return url.host ? `${url.protocol}//${url.host}` : urlText;
    } catch {
      return urlText;
    }
  }

  private async getAuthKeyFromWorkingCopy(): Promise<string | undefined> {
    const pending = SvnService.authKeyTasks.get(this.rootPath);
    if (pending) return pending;

    const task = execCli('svn', ['info', '--xml'], { cwd: this.rootPath, timeout: 15_000 })
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
    const raw = await this.svn(['info', '--xml']);
    return {
      url: textTag(raw, 'url'),
      rootUrl: textTag(raw, 'root'),
      relativeUrl: textTag(raw, 'relative-url').replace(/^\^\/?/, ''),
      revision: attr(raw.match(/<entry\b[^>]*>/)?.[0] ?? '', 'revision'),
    };
  }

  private clearIncomingStateCache(): void {
    this.incomingStateCache = undefined;
    this.incomingStateTask = undefined;
  }

  private async getRemoteHeadRevision(): Promise<number | undefined> {
    const raw = await this.svn(['info', '--xml', '-r', 'HEAD']);
    return parseInfoRevision(raw);
  }

  private async getIncomingState(info: SvnInfo, options: { force?: boolean } = {}): Promise<SvnIncomingState> {
    const localRevision = parseRevisionNumber(info.revision);
    const cached = this.incomingStateCache;
    if (
      !options.force
      && cached
      && cached.localRevision === localRevision
      && Date.now() - cached.checkedAt < SVN_INCOMING_STATE_CACHE_TTL_MS
    ) {
      return cached;
    }
    if (!options.force && this.incomingStateTask) return this.incomingStateTask;

    const task = (async (): Promise<SvnIncomingState> => {
      const remoteRevision = await this.getRemoteHeadRevision();
      const incomingRevisions = new Set<string>();
      let behind = 0;

      if (localRevision !== undefined && remoteRevision !== undefined && remoteRevision > localRevision) {
        try {
          const raw = await this.svn(['log', '--xml', '-r', `${localRevision + 1}:HEAD`]);
          for (const entry of this.parseLogEntries(raw)) {
            const revision = parseRevisionNumber(entry.revision);
            if (revision !== undefined && revision > localRevision) {
              incomingRevisions.add(entry.revision);
            }
          }
          behind = incomingRevisions.size;
        } catch {
          behind = 1;
        }
      }

      const state: SvnIncomingState = {
        localRevision,
        remoteRevision,
        behind,
        incomingRevisions,
        checkedAt: Date.now(),
      };
      this.incomingStateCache = state;
      return state;
    })();

    this.incomingStateTask = task;
    try {
      return await task;
    } finally {
      if (this.incomingStateTask === task) this.incomingStateTask = undefined;
    }
  }

  private async writeTargets(paths: string[]): Promise<string> {
    const filePath = path.join(os.tmpdir(), `versiondock-svn-targets-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(filePath, paths.map(normalizeRelPath).join('\n'), 'utf8');
    return filePath;
  }

  private async runWithTargets(args: string[], paths: string[]): Promise<string> {
    const targetFile = await this.writeTargets(paths);
    try {
      return await this.svn([...args, '--targets', targetFile]);
    } finally {
      fs.unlink(targetFile, () => {});
    }
  }

  private async changedPaths(): Promise<string[]> {
    const files = await this.parseSvnStatus();
    const paths = new Set<string>();
    files.forEach(file => paths.add(file.path));
    return Array.from(paths);
  }

  private async parseSvnStatus(): Promise<FileStatus[]> {
    const raw = await this.svn(['status', '--xml']);
    const files: FileStatus[] = [];
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
      const treeConflicted = attr(wcTag[1], 'tree-conflicted') === 'true';
      const status = treeConflicted ? 'conflicted' : svnItemToStatus(item, props);
      if (!status) continue;
      files.push({
        repoId: this.repoId,
        path: filePath,
        absolutePath: filePath === '.' ? this.rootPath : path.join(this.rootPath, filePath),
        status,
        staged: false,
        unstaged: true,
      });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
  }

  private normalizeIgnoreTarget(entryPath: string): { directoryPath: string; entry: string; fullPath: string } {
    const relPath = this.normalizeRepoPath(entryPath).replace(/\/+$/, '');
    if (!relPath || relPath === '.') {
      throw new Error(t('SVN ignore target cannot be empty.'));
    }
    const entry = path.posix.basename(relPath);
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
      await this.svn(['info', '--xml', '--', target]);
    } catch {
      throw new Error(t('SVN ignore can only be set on a versioned parent directory. Ignore "{0}" or add its parent directory first.', fullPath));
    }
  }

  private async getSvnIgnoreLines(directoryPath: string): Promise<string[]> {
    const target = directoryPath || '.';
    const raw = await this.svn(['propget', 'svn:ignore', '--', target]).catch(() => '');
    return splitIgnoreLines(raw);
  }

  private async setSvnIgnoreLines(directoryPath: string, lines: string[]): Promise<void> {
    const target = directoryPath || '.';
    const normalized = Array.from(new Set(lines.map(line => line.trim()).filter(Boolean)));
    if (normalized.length === 0) {
      await this.svn(['propdel', 'svn:ignore', '--', target]);
      return;
    }
    await this.svn(['propset', 'svn:ignore', `${normalized.join('\n')}\n`, '--', target]);
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
      const directoryPath = rawPath === '.' ? '' : normalizeRelPath(rawPath).replace(/\/+$/, '');
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
      const directoryPath = normalizeRelPath(item.directoryPath).replace(/\/+$/, '');
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

  private svnPathToWorkingPath(svnPath: string, info: SvnInfo): string {
    const relRoot = `/${info.relativeUrl.replace(/^\/+/, '')}`.replace(/\/$/, '');
    const normalized = svnPath.startsWith('/') ? svnPath : `/${svnPath}`;
    if (relRoot !== '/' && normalized.startsWith(`${relRoot}/`)) {
      return normalizeRelPath(normalized.slice(relRoot.length + 1));
    }
    if (relRoot !== '/' && normalized === relRoot) return '';
    return normalizeRelPath(normalized.replace(/^\/+/, ''));
  }

  private matchesRefFilter(info: SvnInfo, filterBranch?: string): boolean {
    const filter = filterBranch?.replace(/^origin\//, '').replace(/^\/+/, '').trim();
    if (!filter) return true;
    const ref = this.displayRef(info);
    const relative = info.relativeUrl.replace(/^\/+/, '');
    return ref.name === filter
      || ref.detachedTag === filter
      || relative === filter
      || info.url.endsWith(`/${filter}`);
  }

  async isGitRepo(): Promise<boolean> {
    return true;
  }

  async getCurrentBranch(): Promise<BranchInfo> {
    const info = await this.getInfo();
    const ref = this.displayRef(info);
    const incoming = await this.getIncomingState(info).catch(() => undefined);
    const behind = incoming?.behind ?? 0;
    return {
      repoId: this.repoId,
      name: ref.name,
      fullName: info.url,
      isHead: true,
      isRemote: false,
      upstream: info.rootUrl,
      aheadBehind: behind > 0 ? { ahead: 0, behind } : undefined,
      detachedTag: ref.detachedTag,
      lastCommitHash: info.revision ? `r${info.revision}` : undefined,
    };
  }

  async getBranches(): Promise<BranchInfo[]> {
    const current = await this.getCurrentBranch();
    const branches: BranchInfo[] = [current];
    const addBranch = (name: string) => {
      if (branches.some(branch => branch.name === name && !branch.isRemote)) return;
      branches.push({
        repoId: this.repoId,
        name,
        fullName: name === 'trunk' ? '^/trunk' : `^/branches/${name}`,
        isHead: current.name === name,
        isRemote: false,
      });
    };
    const trunk = await this.svn(['ls', '^/trunk']).then(() => true).catch(() => false);
    if (trunk) addBranch('trunk');
    const rawBranches = await this.svn(['ls', '^/branches']).catch(() => '');
    rawBranches.split('\n').map(line => line.trim().replace(/\/$/, '')).filter(Boolean).forEach(addBranch);
    return branches;
  }

  async getTags(): Promise<Array<{ name: string; hash: string; date: string }>> {
    const rawTags = await this.svn(['ls', '^/tags']).catch(() => '');
    return rawTags
      .split('\n')
      .map(line => line.trim().replace(/\/$/, ''))
      .filter(Boolean)
      .map(name => ({ name, hash: name, date: '' }));
  }

  async getStatusFresh(): Promise<RepoStatus> {
    const [branch, files] = await Promise.all([this.getCurrentBranch(), this.parseSvnStatus()]);
    const conflictCount = files.filter(file => file.status === 'conflicted').length;
    return {
      repoId: this.repoId,
      branch,
      stagedFiles: [],
      unstagedFiles: files,
      isDetachedHead: !!branch.detachedTag,
      conflictCount,
    };
  }

  async getStatus(): Promise<RepoStatus> {
    return this.getStatusFresh();
  }

  async getLog(limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange }): Promise<CommitNode[]> {
    const info = await this.getInfo();
    if (!this.matchesRefFilter(info, opts?.filterBranch)) return [];
    const incoming = await this.getIncomingState(info).catch(() => undefined);
    const localRevision = incoming?.localRevision ?? parseRevisionNumber(info.revision);
    const selectionRevisions = opts?.filterPath && opts.lineRange
      ? await this.getSelectionHistoryRevisions(opts.filterPath, opts.lineRange)
      : undefined;
    if (selectionRevisions && selectionRevisions.size === 0) return [];

    const numericSelectionRevisions = selectionRevisions
      ? Array.from(selectionRevisions)
        .map(parseRevisionNumber)
        .filter((revision): revision is number => revision !== undefined)
        .sort((a, b) => b - a)
      : [];
    const args = ['log', '--xml', '-v'];
    if (selectionRevisions) {
      for (const revision of numericSelectionRevisions) args.push('-r', String(revision));
    } else {
      args.push('-r', 'HEAD:1', '--limit', String(Math.max(limit + skip, limit)));
    }
    if (opts?.filterPath) args.push('--', normalizeRelPath(opts.filterPath));
    const raw = await this.svn(args);
    const allEntries = this.parseLogEntries(raw);
    const headRevision = incoming?.remoteRevision !== undefined
      ? String(incoming.remoteRevision)
      : selectionRevisions ? info.revision : allEntries[0]?.revision ?? info.revision;
    const entries = allEntries
      .filter(entry => !selectionRevisions || selectionRevisions.has(entry.revision))
      .filter(entry => !opts?.filterText || entry.message.toLowerCase().includes(opts.filterText.toLowerCase()))
      .filter(entry => !opts?.filterAuthor || entry.author.toLowerCase().includes(opts.filterAuthor.toLowerCase()))
      .filter(entry => !opts?.filterDateFrom || new Date(entry.date) >= new Date(opts.filterDateFrom))
      .filter(entry => !opts?.filterDateTo || new Date(entry.date) <= new Date(opts.filterDateTo))
      .slice(skip, skip + limit);

    return entries.map(entry => ({
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
        ...(entry.revision === info.revision ? ['BASE'] : []),
      ],
      unpushed: false,
      incoming: incoming?.incomingRevisions.has(entry.revision)
        ?? (localRevision !== undefined && (parseRevisionNumber(entry.revision) ?? 0) > localRevision),
    }));
  }

  private async getSelectionHistoryRevisions(filePath: string, lineRange: LineRange): Promise<Set<string>> {
    const startLine = Math.max(0, lineRange.start - 1);
    const endLine = Math.max(startLine, lineRange.end - 1);
    const relPath = this.normalizeRepoPath(filePath);
    const raw = await this.svn(['blame', '--xml', '--', relPath]).catch(() => '');
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
      entries.push({
        revision,
        author: textTag(match[2], 'author'),
        date: textTag(match[2], 'date'),
        message: textTag(match[2], 'msg'),
      });
    }
    return entries;
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
    const raw = await this.svn(['log', '--xml', '-r', `${to}:${from}`, '--', relPath]).catch(() => '');
    const summaries = new Map<string, string>();
    for (const entry of this.parseLogEntries(raw)) {
      summaries.set(entry.revision, entry.message.split('\n')[0] || t('SVN revision {0}', entry.revision));
    }
    return summaries;
  }

  private async loadBlame(relPath: string): Promise<BlameLine[]> {
    const raw = await this.svn(['blame', '--xml', '--', relPath]).catch(() => '');
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

    const task = this.loadBlame(relPath).catch(() => []);
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
    const revision = parseRevision(hash);
    const [info, raw] = await Promise.all([
      this.getInfo(),
      this.svn(['log', '--xml', '-v', '-r', revision]),
    ]);
    const files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
    const pathRegex = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(raw)) !== null) {
      const action = attr(match[1], 'action') ?? 'M';
      const decodedPath = decodeXml(match[2].trim());
      const workingPath = this.svnPathToWorkingPath(decodedPath, info);
      const pathValue = workingPath || '.';
      files.push({ path: pathValue, status: svnActionToStatus(action) });
    }
    return files;
  }

  async getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null> {
    const revision = parseRevision(hash);
    const relPath = this.normalizeRepoPath(filePath);
    const raw = await this.svn(['diff', '-c', revision, '--', relPath]).catch(() => '');
    return this.parseSingleDiff(repoId, relPath, raw, revision);
  }

  private getRevisionContent(revision: string, relPath: string): Promise<string> {
    const key = `${revision}:${relPath}`;
    const cached = this.revisionContentCache.get(key);
    if (cached) return cached;
    const task = this.svn(['cat', '-r', revision, '--', relPath]).catch(() => '');
    this.revisionContentCache.set(key, task);
    if (this.revisionContentCache.size > SVN_REVISION_CONTENT_CACHE_LIMIT) {
      const oldestKey = this.revisionContentCache.keys().next().value;
      if (oldestKey) this.revisionContentCache.delete(oldestKey);
    }
    return task;
  }

  async getRevisionFileContents(hash: string, filePath: string, status?: string): Promise<{ originalContent: string; modifiedContent: string }> {
    const revision = parseRevision(hash);
    const previousRevision = String(Math.max(0, Number(revision) - 1));
    const relPath = this.normalizeRepoPath(filePath);
    const normalizedStatus = (status ?? '').toUpperCase();
    const isAdded = normalizedStatus === 'A' || normalizedStatus === 'ADDED';
    const isDeleted = normalizedStatus === 'D' || normalizedStatus === 'DELETED';
    const [originalContent, modifiedContent] = await Promise.all([
      isAdded ? Promise.resolve('') : this.getRevisionContent(previousRevision, relPath),
      isDeleted ? Promise.resolve('') : this.getRevisionContent(revision, relPath),
    ]);
    return { originalContent, modifiedContent };
  }

  async getRevisionRangeFileContents(
    fromHash: string | undefined,
    toHash: string,
    filePath: string,
  ): Promise<{ originalContent: string; modifiedContent: string }> {
    const fromRevision = parseRevisionNumber(fromHash);
    const toRevision = parseRevisionNumber(toHash);
    const relPath = this.normalizeRepoPath(filePath);
    const [originalContent, modifiedContent] = await Promise.all([
      fromRevision === undefined ? Promise.resolve('') : this.getRevisionContent(String(fromRevision), relPath),
      toRevision === undefined ? Promise.resolve('') : this.getRevisionContent(String(toRevision), relPath),
    ]);
    return { originalContent, modifiedContent };
  }

  async getUnstagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    const relPath = this.normalizeRepoPath(filePath);
    const raw = await this.svn(['diff', '--', relPath]).catch(() => '');
    if (!raw.trim()) {
      const absPath = path.join(this.rootPath, relPath);
      if (!fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) return null;
      return {
        repoId,
        oldPath: relPath,
        newPath: relPath,
        isBinary: false,
        isNew: true,
        isDeleted: false,
        hunks: [],
        originalContent: '',
        modifiedContent: fs.readFileSync(absPath, 'utf8'),
        language: detectLanguage(relPath),
      };
    }
    return this.parseSingleDiff(repoId, relPath, raw);
  }

  async getStagedDiff(repoId: string, filePath: string): Promise<FileDiff | null> {
    return this.getUnstagedDiff(repoId, filePath);
  }

  private async parseSingleDiff(repoId: string, filePath: string, raw: string, revision?: string): Promise<FileDiff | null> {
    const diffs = parseDiff(buildSyntheticGitDiff(raw), repoId);
    if (diffs.length === 0) return null;
    const diff = diffs.find(item => item.newPath === filePath || item.oldPath === filePath) ?? diffs[0];
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
      diff.originalContent = await this.svn(['cat', '--', this.normalizeRepoPath(filePath)]).catch(() => '');
      diff.modifiedContent = fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory()
        ? fs.readFileSync(absPath, 'utf8')
        : '';
    }
    return diff;
  }

  async stageFiles(paths: string[]): Promise<void> {
    const statuses = await this.parseSvnStatus();
    const unversioned = new Set(statuses.filter(file => file.status === 'untracked').map(file => file.path));
    for (const filePath of paths) {
      const relPath = this.normalizeRepoPath(filePath);
      if (!unversioned.has(relPath)) continue;
      await this.svn(['add', '--parents', '--', relPath]);
    }
  }

  async stageAll(): Promise<void> {
    const files = await this.parseSvnStatus();
    const unversioned = files.filter(file => file.status === 'untracked').map(file => file.path);
    if (unversioned.length > 0) await this.stageFiles(unversioned);
  }

  async unstageFiles(): Promise<void> {
    return;
  }

  async unstageAll(): Promise<void> {
    return;
  }

  async discardFile(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const status = (await this.parseSvnStatus()).find(file => file.path === relPath);
    if (status?.status === 'untracked') {
      const absPath = path.join(this.rootPath, relPath);
      if (fs.existsSync(absPath)) {
        const stat = fs.statSync(absPath);
        if (stat.isDirectory()) fs.rmSync(absPath, { recursive: true, force: true });
        else fs.unlinkSync(absPath);
      }
      return;
    }
    await this.svn(['revert', '--', relPath]);
  }

  async commit(message: string, amend: boolean): Promise<string> {
    if (amend) throw this.unsupported(t('Amend'));
    const paths = await this.changedPaths();
    if (paths.length === 0) throw new Error(t('No SVN changes to commit.'));
    return this.commitPaths(message, paths);
  }

  async commitPaths(message: string, paths: string[]): Promise<string> {
    const uniquePaths = Array.from(new Set(paths.map(filePath => this.normalizeRepoPath(filePath))));
    if (uniquePaths.length === 0) throw new Error(t('No SVN files selected to commit.'));
    const statuses = await this.parseSvnStatus();
    const unversioned = new Set(statuses.filter(file => file.status === 'untracked').map(file => file.path));
    const pathsToAdd = uniquePaths.filter(filePath => unversioned.has(filePath));
    if (pathsToAdd.length > 0) await this.stageFiles(pathsToAdd);
    return this.runWithTargets(['commit', '-m', message], uniquePaths);
  }

  async pull(): Promise<string> {
    const output = await this.svn(['update']);
    this.clearIncomingStateCache();
    return output;
  }

  async pullRebase(): Promise<string> {
    return this.pull();
  }

  async fetchAll(): Promise<void> {
    const info = await this.getInfo();
    await this.getIncomingState(info, { force: true });
  }

  async push(): Promise<void> {
    throw new Error(t('SVN commits are sent to the server during commit; Push is not used.'));
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
  }

  async checkout(branchName: string): Promise<void> {
    const revision = branchName.match(/^r?(\d+)$/i)?.[1];
    if (revision) {
      await this.svn(['update', '-r', revision]);
      return;
    }
    const target = branchName === 'trunk'
      ? '^/trunk'
      : branchName.startsWith('tags/')
        ? `^/${branchName}`
        : branchName.startsWith('branches/')
          ? `^/${branchName}`
          : `^/branches/${branchName}`;
    await this.svn(['switch', target]);
  }

  async createBranch(branchName: string, from?: string): Promise<void> {
    const source = from ? `^/${from.replace(/^branches\//, 'branches/')}` : '.';
    await this.svn(['copy', source, `^/branches/${branchName}`, '-m', `Create branch ${branchName}`]);
  }

  async createBranchFromCommit(name: string, hash: string): Promise<void> {
    const revision = parseRevision(hash);
    const args = ['copy'];
    if (revision) args.push(`-r${revision}`);
    args.push('.', `^/branches/${name}`, '-m', `Create branch ${name}`);
    await this.svn(args);
  }

  async deleteBranch(branchName: string): Promise<void> {
    const name = branchName.replace(/^branches\//, '');
    await this.svn(['delete', `^/branches/${name}`, '-m', `Delete branch ${name}`]);
  }

  async createTag(name: string, hash: string): Promise<void> {
    const revision = parseRevision(hash);
    const args = ['copy'];
    if (revision) args.push(`-r${revision}`);
    args.push('.', `^/tags/${name}`, '-m', `Create tag ${name}`);
    await this.svn(args);
  }

  async deleteTag(name: string): Promise<void> {
    await this.svn(['delete', `^/tags/${name}`, '-m', `Delete tag ${name}`]);
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

  async merge(from: string): Promise<void> {
    const target = from === 'trunk'
      ? '^/trunk'
      : from.startsWith('^/')
        ? from
        : from.startsWith('tags/') || from.startsWith('branches/')
          ? `^/${from}`
          : `^/branches/${from}`;
    await this.svn(['merge', target]);
  }

  async mergeTag(name: string): Promise<void> {
    await this.svn(['merge', `^/tags/${name}`]);
  }

  async getTagsForCommit(): Promise<string[]> {
    return [];
  }

  async getBranchesContaining(): Promise<{ local: string[]; remote: string[]; tags: string[] }> {
    return { local: [], remote: [], tags: [] };
  }

  async getFullCommitMessage(hash: string): Promise<string> {
    const revision = parseRevision(hash);
    const raw = await this.svn(['log', '--xml', '-r', revision]);
    return this.parseLogEntries(raw)[0]?.message ?? '';
  }

  override async getRecentCommitMessages(limit: number): Promise<CommitMessageHistoryEntry[]> {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const raw = await this.svn(['log', '--xml', '--limit', String(safeLimit)]).catch(() => '');
    return this.parseLogEntries(raw).flatMap(entry => {
      const message = entry.message.trim();
      if (!message) return [];
      const timestamp = Date.parse(entry.date);
      return [{ message, timestamp: Number.isFinite(timestamp) ? timestamp : 0 }];
    });
  }

  async getCommitMeta(hash: string): Promise<{ hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] }> {
    const revision = parseRevision(hash);
    const raw = await this.svn(['log', '--xml', '-r', revision]);
    const entry = this.parseLogEntries(raw)[0];
    const revisionHash = `r${revision}`;
    return {
      hash: revisionHash,
      shortHash: revisionHash,
      message: entry?.message.split('\n')[0] ?? t('SVN revision {0}', revision),
      authorName: entry?.author || t('Unknown'),
      authorEmail: '',
      authorDate: entry?.date ?? '',
      committerDate: entry?.date ?? '',
      parents: [],
    };
  }

  async createPatch(hash: string): Promise<string> {
    return this.svn(['diff', '-c', parseRevision(hash)]);
  }

  async cherryPick(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async cherryPickMulti(): Promise<void> {
    throw this.unsupported(t('Cherry-Pick'));
  }

  async revertCommit(): Promise<void> {
    throw this.unsupported(t('Revert Commit'));
  }

  async revertCommits(): Promise<void> {
    throw this.unsupported(t('Revert Commits'));
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

  async acceptOurs(filePath: string): Promise<void> {
    await this.svn(['resolve', '--accept', 'mine-conflict', '--', this.normalizeRepoPath(filePath)]);
  }

  async acceptTheirs(filePath: string): Promise<void> {
    await this.svn(['resolve', '--accept', 'theirs-conflict', '--', this.normalizeRepoPath(filePath)]);
  }

  async resolveWorking(filePath: string): Promise<void> {
    await this.svn(['resolve', '--accept', 'working', '--', this.normalizeRepoPath(filePath)]);
  }

  async getConflictFileStatuses(): Promise<Map<string, { currentStatus: 'modified' | 'added' | 'deleted'; incomingStatus: 'modified' | 'added' | 'deleted' }>> {
    const statuses = new Map<string, { currentStatus: 'modified' | 'added' | 'deleted'; incomingStatus: 'modified' | 'added' | 'deleted' }>();
    const files = await this.parseSvnStatus();
    for (const file of files) {
      if (file.status === 'conflicted') {
        statuses.set(file.path, { currentStatus: 'modified', incomingStatus: 'modified' });
      }
    }
    return statuses;
  }

  async getFileVersions(filePath: string): Promise<{ base: string; ours: string; theirs: string; language: string }> {
    const relPath = this.normalizeRepoPath(filePath);
    const absPath = path.join(this.rootPath, relPath);
    const dir = path.dirname(absPath);
    const baseName = path.basename(absPath);
    let ours = '';
    let base = '';
    let theirs = '';

    try { ours = fs.readFileSync(`${absPath}.mine`, 'utf8'); } catch {
      try { ours = fs.readFileSync(absPath, 'utf8'); } catch { ours = ''; }
    }

    let sideFiles: string[] = [];
    try {
      sideFiles = fs.readdirSync(dir)
        .filter(name => name.startsWith(`${baseName}.r`) && /^\d+$/.test(name.slice(baseName.length + 2)))
        .sort((left, right) => Number(left.slice(baseName.length + 2)) - Number(right.slice(baseName.length + 2)));
    } catch {
      sideFiles = [];
    }

    if (sideFiles.length > 0) {
      try { base = fs.readFileSync(path.join(dir, sideFiles[0]), 'utf8'); } catch { base = ''; }
      try { theirs = fs.readFileSync(path.join(dir, sideFiles[sideFiles.length - 1]), 'utf8'); } catch { theirs = ''; }
    } else {
      base = await this.svn(['cat', '--', relPath]).catch(() => '');
      theirs = base;
    }

    return { base, ours, theirs, language: detectLanguage(relPath) };
  }

  async saveMergedContent(filePath: string, content: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    fs.writeFileSync(path.join(this.rootPath, relPath), content, 'utf8');
    await this.resolveWorking(relPath).catch(() => {});
  }

  async deleteMergedFile(filePath: string): Promise<void> {
    const relPath = this.normalizeRepoPath(filePath);
    const absPath = path.join(this.rootPath, relPath);
    if (fs.existsSync(absPath)) fs.rmSync(absPath, { recursive: true, force: true });
    await this.svn(['delete', '--', relPath]).catch(() => {});
    await this.resolveWorking(relPath).catch(() => {});
  }

  async getMergeRebaseState(): Promise<'merge' | 'rebase' | null> {
    const files = await this.parseSvnStatus();
    return files.some(file => file.status === 'conflicted') ? 'merge' : null;
  }

  async abortMerge(): Promise<void> {
    const files = await this.parseSvnStatus();
    const conflictPaths = files
      .filter(file => file.status === 'conflicted')
      .map(file => file.path);
    if (conflictPaths.length === 0) return;
    await this.runWithTargets(['revert', '--depth', 'infinity'], conflictPaths);
  }

  async getUnpushedCommits(): Promise<UnpushedCommit[]> {
    return [];
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
