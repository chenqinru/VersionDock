import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import simpleGit, { type SimpleGit, type SimpleGitOptions } from 'simple-git';

interface LockToken {
  active: boolean;
}

type LockContext = ReadonlyMap<string, LockToken>;

const writeTails = new Map<string, Promise<void>>();
const activeWrites = new Map<string, Promise<void>>();
const writeGenerations = new Map<string, number>();
const lockContext = new AsyncLocalStorage<LockContext>();

const DEFAULT_EXTERNAL_LOCK_TIMEOUT_MS = 5_000;
const INITIAL_EXTERNAL_LOCK_DELAY_MS = 50;
const MAX_EXTERNAL_LOCK_DELAY_MS = 250;
const STALE_LOCK_AGE_MS = 10_000;
const STALE_CHECK_WAIT_MS = 200;

function lockKey(rootPath: string): string {
  const absolutePath = path.resolve(rootPath);
  const normalizeCase = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  try {
    return normalizeCase(fs.realpathSync.native(absolutePath));
  } catch {
    return normalizeCase(absolutePath);
  }
}

function resolveGitDir(rootPath: string): string | undefined {
  const dotGitPath = path.join(path.resolve(rootPath), '.git');
  try {
    const stat = fs.statSync(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    if (!stat.isFile()) return undefined;

    const gitFile = fs.readFileSync(dotGitPath, 'utf8').trim();
    const match = gitFile.match(/^gitdir:\s*(.+)$/i);
    if (!match) return undefined;
    return path.resolve(path.dirname(dotGitPath), match[1].trim());
  } catch {
    return undefined;
  }
}

function resolveIndexLockPath(rootPath: string): string | undefined {
  const gitDir = resolveGitDir(rootPath);
  return gitDir ? path.join(gitDir, 'index.lock') : undefined;
}

/** Environment shared by every VersionDock-owned Git child process. */
export function getGitEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...overrides,
    // Do not let read commands refresh the index and create an optional lock.
    GIT_OPTIONAL_LOCKS: '0',
  };
}

function isGitIndexLockError(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown; gitErrorCode?: unknown } | undefined;
  const detail = [value?.message, value?.stderr, value?.gitErrorCode]
    .filter((part): part is string => typeof part === 'string')
    .join('\n');
  return /index\.lock|unable to create .*index|another git process.*repository/i.test(detail);
}

/** Retry one Git command when another process briefly owns index.lock. */
export async function runGitCommandWithIndexLockRetry<T>(
  rootPath: string,
  command: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await command();
    } catch (error) {
      if (!isGitIndexLockError(error) || attempt >= 2) throw error;
      await waitForExternalGitIndexLock(rootPath);
    }
  }
}

/** Create the standard VersionDock Git client without limiting read concurrency. */
export function createGitClient(rootPath: string): SimpleGit {
  // simple-git's .env(name, value) replaces the child-process environment
  // instead of extending it. Passing only GIT_OPTIONAL_LOCKS therefore drops
  // HOME, which makes `git config --global` fail with "$HOME not set". Keep
  // the same environment Git would inherit when launched by the extension.
  const environment = getGitEnvironment();
  const client = simpleGit({
    baseDir: rootPath,
    // Recent simple-git versions validate environment variables passed through
    // .env(). These are inherited from the extension host, not repository
    // input, so allow only the categories that are actually present and keep
    // the previous Git authentication/editor behavior intact.
    unsafe: getSimpleGitUnsafeOptions(environment),
  }).env(environment);
  const builderMethods = new Set(['customBinary', 'env', 'outputHandler', 'silent']);

  const wrapped = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || builderMethods.has(property)) {
        return value;
      }
      return (...args: unknown[]) => runGitCommandWithIndexLockRetry(
        rootPath,
        () => Promise.resolve(value.apply(target, args)),
      );
    },
  });
  return wrapped;
}

type SimpleGitUnsafeOptions = NonNullable<SimpleGitOptions['unsafe']>;

function getSimpleGitUnsafeOptions(environment: NodeJS.ProcessEnv): SimpleGitUnsafeOptions {
  const options: SimpleGitUnsafeOptions = {};
  const has = (...names: string[]): boolean => names.some(name => environment[name] !== undefined);

  options.allowUnsafeProtocolOverride = true;

  if (has('GIT_ASKPASS', 'SSH_ASKPASS')) options.allowUnsafeAskPass = true;
  if (has('EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR')) options.allowUnsafeEditor = true;
  if (has('GIT_PAGER', 'PAGER')) options.allowUnsafePager = true;
  if (has('GIT_SSH', 'GIT_SSH_COMMAND')) options.allowUnsafeSshCommand = true;
  if (has('GIT_PROXY_COMMAND')) options.allowUnsafeGitProxy = true;
  if (has('GIT_EXTERNAL_DIFF')) options.allowUnsafeDiffExternal = true;
  if (has('GIT_TEMPLATE_DIR')) options.allowUnsafeTemplateDir = true;
  if (has('GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXEC_PATH')) {
    options.allowUnsafeConfigPaths = true;
  }

  // GIT_CONFIG_COUNT can inject arbitrary Git config entries. Preserve the
  // inherited environment for compatibility, while explicitly acknowledging
  // all config categories simple-git may validate from those entries.
  if (has('GIT_CONFIG_COUNT') || Object.keys(environment).some(key => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key))) {
    options.allowUnsafeConfigEnvCount = true;
    options.allowUnsafeCredentialHelper = true;
    options.allowUnsafeEditor = true;
    options.allowUnsafePager = true;
    options.allowUnsafeSshCommand = true;
    options.allowUnsafeGitProxy = true;
    options.allowUnsafeDiffExternal = true;
    options.allowUnsafeDiffTextConv = true;
    options.allowUnsafeFilter = true;
    options.allowUnsafeFsMonitor = true;
    options.allowUnsafeGpgProgram = true;
    options.allowUnsafeTemplateDir = true;
    options.allowUnsafeMergeDriver = true;
  }

  return options;
}

function tryRemoveStaleGitIndexLock(lockPath: string, reason: string): boolean {
  try {
    if (!fs.existsSync(lockPath)) return true;
    fs.unlinkSync(lockPath);
    console.warn(`[VersionDock] Automatically removed ${reason} Git index lock: ${lockPath}`);
    return true;
  } catch (error) {
    console.error(`[VersionDock] Failed to remove Git index lock ${lockPath}:`, error);
    return false;
  }
}

/**
 * Wait for an index lock created by another Git process.
 * If the lock file is identified as a stale lock left behind by an aborted or crashed
 * process, it will be automatically cleaned up safely so operations never hang or fail.
 */
export async function waitForExternalGitIndexLock(
  rootPath: string,
  timeoutMs = DEFAULT_EXTERNAL_LOCK_TIMEOUT_MS,
): Promise<void> {
  const lockPath = resolveIndexLockPath(rootPath);
  if (!lockPath) return;

  let initialStat: fs.Stats;
  try {
    initialStat = fs.statSync(lockPath);
  } catch {
    return;
  }

  // Fast path for stale locks: if the lock file already existed more than STALE_LOCK_AGE_MS
  // before this operation (e.g. minutes or days ago from a crash), verify it is completely
  // static and automatically clean it up.
  const initialAge = Date.now() - initialStat.mtimeMs;
  if (initialAge >= STALE_LOCK_AGE_MS) {
    await new Promise<void>(resolve => setTimeout(resolve, STALE_CHECK_WAIT_MS));
    try {
      const currentStat = fs.statSync(lockPath);
      if (currentStat.mtimeMs === initialStat.mtimeMs && currentStat.size === initialStat.size) {
        if (tryRemoveStaleGitIndexLock(lockPath, `stale (${Math.round(initialAge / 1000)}s old)`)) {
          return;
        }
      }
    } catch {
      return;
    }
  }

  const startedAt = Date.now();
  let delayMs = INITIAL_EXTERNAL_LOCK_DELAY_MS;
  let lastMtime = initialStat.mtimeMs;
  let lastSize = initialStat.size;

  while (fs.existsSync(lockPath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      // Timeout reached: if the lock file remained completely static throughout our entire
      // wait duration (no size change and no mtime update), it is an abandoned dead lock.
      try {
        const finalStat = fs.statSync(lockPath);
        const totalAge = Date.now() - finalStat.mtimeMs;
        if (totalAge >= timeoutMs && finalStat.mtimeMs === lastMtime && finalStat.size === lastSize) {
          if (tryRemoveStaleGitIndexLock(lockPath, `abandoned (${Math.round(totalAge / 1000)}s old)`)) {
            return;
          }
        }
      } catch {
        return;
      }
      throw new Error(`Git index is busy: ${lockPath}`);
    }
    await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    try {
      const s = fs.statSync(lockPath);
      lastMtime = s.mtimeMs;
      lastSize = s.size;
    } catch {
      return;
    }
    delayMs = Math.min(delayMs * 2, MAX_EXTERNAL_LOCK_DELAY_MS);
  }
}

/**
 * Wait until VersionDock's in-process Git writers for this working tree have
 * finished. It also waits briefly for an existing physical index.lock before a
 * VersionDock writer starts, coordinating independently-created GitService,
 * ShelveService, Composer, and other Git clients in this extension host.
 */
export async function waitForGitWrite(rootPath: string): Promise<void> {
  const key = lockKey(rootPath);
  if (lockContext.getStore()?.get(key)?.active) return;
  // Only wait for the writer currently holding the lock. A reader that starts
  // while later writers are queued should not wait for the entire future queue.
  await activeWrites.get(key);
}

/** Monotonic counter used by status reads to detect a write during the read. */
export function getGitWriteGeneration(rootPath: string): number {
  return writeGenerations.get(lockKey(rootPath)) ?? 0;
}

/**
 * Serialize all Git operations that can mutate a working tree or its index.
 * Reentrancy is required because compound operations such as conflict
 * resolution call stageFiles() after already acquiring the repository lock.
 */
export async function withGitWriteLock<T>(rootPath: string, operation: () => Promise<T>): Promise<T> {
  const key = lockKey(rootPath);
  const currentContext = lockContext.getStore();
  if (currentContext?.get(key)?.active) return operation();

  const previous = writeTails.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const token: LockToken = { active: true };
  writeTails.set(key, current);

  try {
    await previous;
    await waitForExternalGitIndexLock(key);
    activeWrites.set(key, current);
    writeGenerations.set(key, (writeGenerations.get(key) ?? 0) + 1);
    const nextContext = new Map(currentContext ?? []);
    nextContext.set(key, token);
    return await lockContext.run(nextContext, operation);
  } finally {
    token.active = false;
    if (activeWrites.get(key) === current) activeWrites.delete(key);
    release();
    if (writeTails.get(key) === current) writeTails.delete(key);
  }
}

/** Acquire several repository locks in a stable order to avoid lock inversion. */
export async function withGitWriteLocks<T>(rootPaths: string[], operation: () => Promise<T>): Promise<T> {
  const keys = Array.from(new Set(rootPaths.map(lockKey))).sort();
  const acquire = async (index: number): Promise<T> => {
    if (index >= keys.length) return operation();
    return withGitWriteLock(keys[index], () => acquire(index + 1));
  };
  return acquire(0);
}
