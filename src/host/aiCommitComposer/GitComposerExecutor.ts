import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectLanguage, parseDiff } from '../git/DiffParser';
import type { GitService } from '../git/GitService';
import { t } from '../utils/l10n';
import { execCli } from '../vcs/cli';
import type { ComposerApplyResult, ComposerChangeUnit, ComposerCommitGroup, ComposerPreparedSource } from './types';

const BACKUP_PREFIX = 'refs/versiondock/ai-composer/';
const BACKUP_LIMIT = 10;
const COMPOSER_GIT_MAX_BUFFER = 256 * 1024 * 1024;

interface PatchUnit extends ComposerChangeUnit {
  patch: string;
}

export interface PreparedGitComposerSession {
  source: ComposerPreparedSource;
  baseHash: string;
  oldHead: string;
  branchRef: string;
  expectedTree: string;
  unselectedIndexPatch: string;
  selectedPaths: string[];
  stagedOnly: boolean;
  fingerprint: string;
  units: PatchUnit[];
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashParts(...values: string[]): string {
  const digest = crypto.createHash('sha256');
  values.forEach((value, index) => {
    if (index > 0) digest.update('\0');
    digest.update(value);
  });
  return digest.digest('hex');
}

function patchInput(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function literalPathspec(filePath: string): string {
  return `:(literal)${filePath}`;
}

function countChanges(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { added, removed };
}

function summarizeBinaryPatch(chunk: string): string {
  const headers = chunk.split('\n').filter(line => (
    line.startsWith('diff --git ')
    || line.startsWith('new file mode ')
    || line.startsWith('deleted file mode ')
    || line.startsWith('old mode ')
    || line.startsWith('new mode ')
    || line.startsWith('similarity index ')
    || line.startsWith('rename from ')
    || line.startsWith('rename to ')
    || line.startsWith('copy from ')
    || line.startsWith('copy to ')
    || line.startsWith('Binary files ')
  ));
  return `${headers.join('\n')}\nBinary content omitted from AI context.\n`;
}

function splitPatch(rawPatch: string): PatchUnit[] {
  const chunks = rawPatch.split(/(?=^diff --git )/m).filter(chunk => chunk.startsWith('diff --git '));
  const parsed = parseDiff(rawPatch, 'composer');
  const units: PatchUnit[] = [];
  chunks.forEach((chunk, fileIndex) => {
    const file = parsed[fileIndex];
    if (!file) return;
    const filePath = file.newPath || file.oldPath;
    const atomic = file.isBinary || file.isNew || file.isDeleted
      || /^(rename|copy) (?:from|to) /m.test(chunk)
      || /^old mode |^new mode /m.test(chunk)
      || /^index [0-9a-f]+\.\.[0-9a-f]+ (?:120000|160000)$/m.test(chunk)
      || /Subproject commit [0-9a-f]+/m.test(chunk)
      || !chunk.includes('\n@@ ');
    const status = file.isNew ? 'added' : file.isDeleted ? 'deleted' : /rename from /m.test(chunk) ? 'renamed' : file.isBinary ? 'binary' : 'modified';

    if (atomic) {
      const counts = countChanges(chunk);
      units.push({
        id: `file-${hashParts(filePath, chunk).slice(0, 16)}`,
        filePath,
        oldPath: file.oldPath !== file.newPath ? file.oldPath : undefined,
        kind: 'file',
        status,
        title: path.basename(filePath),
        diff: file.isBinary ? summarizeBinaryPatch(chunk) : chunk,
        patch: chunk,
        language: detectLanguage(filePath),
        ...counts,
        atomic: true,
      });
      return;
    }

    const hunkIndex = chunk.search(/^@@ /m);
    // A full-index line describes the complete file patch. Individual hunks are
    // intentionally applied across separate commits, so retaining that line
    // would make later hunks require the original blob id and fail after an
    // earlier hunk changed the same file.
    const header = chunk.slice(0, hunkIndex)
      .split('\n')
      .filter(line => !line.startsWith('index '))
      .join('\n');
    const hunks = chunk.slice(hunkIndex).split(/(?=^@@ )/m).filter(Boolean);
    hunks.forEach((hunk, index) => {
      const patch = `${header}${hunk.endsWith('\n') ? hunk : `${hunk}\n`}`;
      const counts = countChanges(hunk);
      units.push({
        id: `hunk-${hash(`${filePath}\n${hunk}`).slice(0, 16)}`,
        filePath,
        kind: 'hunk',
        status,
        title: hunk.split('\n')[0]?.trim() || `${path.basename(filePath)} · ${index + 1}`,
        diff: hunk,
        patch,
        language: detectLanguage(filePath),
        ...counts,
        atomic: false,
      });
    });
  });
  return units;
}

export class GitComposerExecutor {
  private async git(
    rootPath: string,
    args: string[],
    options: { stdin?: string; env?: NodeJS.ProcessEnv; timeout?: number; trimOutput?: boolean } = {},
  ): Promise<string> {
    const { trimOutput = true, ...cliOptions } = options;
    const stdout = (await execCli('git', args, {
      cwd: rootPath,
      maxBuffer: COMPOSER_GIT_MAX_BUFFER,
      ...cliOptions,
    })).stdout;
    return trimOutput ? stdout.trim() : stdout;
  }

  async prepareWorking(repo: GitService, repoName: string, paths: string[], stagedOnly: boolean): Promise<PreparedGitComposerSession> {
    const requestedPaths = Array.from(new Set(paths.map(value => repo.resolveRepoPath(value).relativePath))).sort();
    if (requestedPaths.length === 0) throw new Error(t('Select changes before opening AI Commit Composer.'));
    const [oldHead, branchRef, operation, status] = await Promise.all([
      this.git(repo.rootPath, ['rev-parse', 'HEAD']).catch(() => { throw new Error(t('Create the initial Git commit before using AI Commit Composer.')); }),
      this.git(repo.rootPath, ['symbolic-ref', 'HEAD']).catch(() => ''),
      repo.getOperationState(),
      repo.getStatusFresh(),
    ]);
    if (!branchRef) throw new Error(t('AI Commit Composer requires a checked-out branch.'));
    if (operation || status.conflictCount > 0) throw new Error(t('Finish the current Git operation and resolve conflicts before using AI Commit Composer.'));

    // Include both sides of selected renames/copies. A destination-only pathspec
    // would otherwise leave the source deletion outside the composed commits.
    const selectedPathSet = new Set(requestedPaths);
    for (const file of [...status.stagedFiles, ...status.unstagedFiles]) {
      if (!selectedPathSet.has(file.path) && (!file.oldPath || !selectedPathSet.has(file.oldPath))) continue;
      selectedPathSet.add(file.path);
      if (file.oldPath) selectedPathSet.add(file.oldPath);
    }
    const selectedPaths = Array.from(selectedPathSet).sort();
    const selectedPathspecs = selectedPaths.map(literalPathspec);

    const stagedOutside = Array.from(new Set(status.stagedFiles.flatMap(file => {
      if (selectedPathSet.has(file.path) || (file.oldPath && selectedPathSet.has(file.oldPath))) return [];
      return [file.oldPath, file.path].filter((value): value is string => Boolean(value));
    })));
    const unselectedIndexPatch = stagedOutside.length > 0
      ? await this.git(repo.rootPath, ['diff', '--cached', '--binary', '--full-index', '-M', '-C', 'HEAD', '--', ...stagedOutside.map(literalPathspec)], { trimOutput: false })
      : '';
    const selectedIndexPatch = stagedOnly
      ? await this.git(
        repo.rootPath,
        ['diff', '--cached', '--binary', '--full-index', '-M', '-C', 'HEAD', '--', ...selectedPathspecs],
        { trimOutput: false },
      )
      : '';
    const versionedSelectedPaths = stagedOnly
      ? new Set<string>()
      : new Set((await this.git(
        repo.rootPath,
        ['ls-files', '-z', '--cached', '--with-tree=HEAD', '--', ...selectedPathspecs],
        { trimOutput: false },
      )).split('\0').filter(Boolean));

    let sourcePatch = '';
    let expectedTree = '';
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-composer-index-'));
    const indexPath = path.join(tempRoot, 'index');
    const env = { ...process.env, GIT_INDEX_FILE: indexPath };
    try {
      await this.git(repo.rootPath, ['read-tree', 'HEAD'], { env });
      if (stagedOnly) {
        sourcePatch = selectedIndexPatch;
        if (sourcePatch) await this.git(repo.rootPath, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { env, stdin: patchInput(sourcePatch) });
      } else {
        const regularPathspecs = selectedPaths
          .filter(filePath => !versionedSelectedPaths.has(filePath))
          .map(literalPathspec);
        const versionedPathspecs = selectedPaths
          .filter(filePath => versionedSelectedPaths.has(filePath))
          .map(literalPathspec);
        if (regularPathspecs.length > 0) {
          await this.git(repo.rootPath, ['add', '-A', '--', ...regularPathspecs], { env });
        }
        if (versionedPathspecs.length > 0) {
          // Git rejects an explicitly selected path below an ignored directory
          // even when that path is already in HEAD or the real index. Force is
          // limited to those versioned paths, so unrelated ignored files stay
          // excluded from the temporary composer index.
          await this.git(repo.rootPath, ['add', '-f', '-A', '--', ...versionedPathspecs], { env });
        }
        sourcePatch = await this.git(repo.rootPath, ['diff', '--cached', '--binary', '--full-index', '-M', '-C', 'HEAD', '--', ...selectedPathspecs], { env, trimOutput: false });
      }
      expectedTree = await this.git(repo.rootPath, ['write-tree'], { env });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    if (!sourcePatch) throw new Error(t('No selected changes are available for AI Commit Composer.'));
    const units = splitPatch(sourcePatch);
    if (units.length === 0) throw new Error(t('AI Commit Composer could not build change units from the selected changes.'));
    const fingerprint = hashParts(oldHead, expectedTree, sourcePatch, unselectedIndexPatch);
    return {
      source: {
        sessionId: crypto.randomUUID(), mode: 'working', repoId: repo.repoId, repoName, vcsKind: 'git',
        branch: branchRef.replace(/^refs\/heads\//, ''), sourceLabel: stagedOnly ? t('Selected staged changes') : t('Selected working changes'),
        units: units.map(({ patch: _patch, ...unit }) => unit),
      },
      baseHash: oldHead, oldHead, branchRef, expectedTree, unselectedIndexPatch,
      selectedPaths, stagedOnly, fingerprint, units,
    };
  }

  async prepareHistory(repo: GitService, repoName: string, hashes: string[]): Promise<PreparedGitComposerSession> {
    const validation = await repo.canReorganizeCommitRange(hashes);
    if (!validation.ok || !validation.oldestHash) throw new Error(validation.reason ?? t('Selected commits cannot be reorganized.'));
    const status = await repo.getStatusFresh();
    if (status.stagedFiles.length || status.unstagedFiles.length || status.conflictCount || await repo.getOperationState()) {
      throw new Error(t('Clean the working tree and finish the current Git operation before reorganizing commits.'));
    }
    const [oldHead, branchRef, baseHash] = await Promise.all([
      this.git(repo.rootPath, ['rev-parse', 'HEAD']),
      this.git(repo.rootPath, ['symbolic-ref', 'HEAD']).catch(() => ''),
      this.git(repo.rootPath, ['rev-parse', `${validation.oldestHash}^1`]),
    ]);
    if (!branchRef) throw new Error(t('AI Commit Composer requires a checked-out branch.'));
    const sourcePatch = await this.git(repo.rootPath, ['diff', '--binary', '--full-index', '-M', '-C', baseHash, oldHead], { trimOutput: false });
    const expectedTree = await this.git(repo.rootPath, ['rev-parse', `${oldHead}^{tree}`]);
    const units = splitPatch(sourcePatch);
    if (units.length === 0) throw new Error(t('The selected commits do not contain reorganizable changes.'));
    const fingerprint = hashParts(oldHead, expectedTree, sourcePatch);
    return {
      source: {
        sessionId: crypto.randomUUID(), mode: 'history', repoId: repo.repoId, repoName, vcsKind: 'git',
        branch: branchRef.replace(/^refs\/heads\//, ''), sourceLabel: t('{0} consecutive unpushed commits', validation.hashes.length),
        originalCommitCount: validation.hashes.length,
        units: units.map(({ patch: _patch, ...unit }) => unit),
      },
      baseHash, oldHead, branchRef, expectedTree, unselectedIndexPatch: '', selectedPaths: [], stagedOnly: false, fingerprint, units,
    };
  }

  async apply(
    repo: GitService,
    session: PreparedGitComposerSession,
    groups: ComposerCommitGroup[],
    onProgress: (completed: number, total: number, message: string) => void,
  ): Promise<ComposerApplyResult> {
    this.validateGroups(session, groups);
    const currentHead = await this.git(repo.rootPath, ['rev-parse', 'HEAD']);
    if (currentHead !== session.oldHead) throw new Error(t('Repository HEAD changed after analysis. Analyze the changes again.'));
    if (session.source.mode === 'working') {
      const refreshed = await this.prepareWorking(repo, session.source.repoName, session.selectedPaths, session.stagedOnly);
      if (refreshed.fingerprint !== session.fingerprint) throw new Error(t('Selected changes changed after analysis. Analyze them again.'));
    } else {
      const status = await repo.getStatusFresh();
      if (status.stagedFiles.length || status.unstagedFiles.length || status.conflictCount || await repo.getOperationState()) {
        throw new Error(t('Repository state changed after analysis. Clean the working tree and try again.'));
      }
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-composer-'));
    const worktreePath = path.join(tempRoot, 'worktree');
    const commitHashes: string[] = [];
    let worktreeAdded = false;
    let backupRef: string | undefined;
    let branchUpdated = false;
    try {
      await this.git(repo.rootPath, ['worktree', 'add', '--detach', worktreePath, session.baseHash]);
      worktreeAdded = true;
      const unitsById = new Map(session.units.map(unit => [unit.id, unit]));
      for (let index = 0; index < groups.length; index++) {
        const group = groups[index];
        onProgress(index, groups.length, group.message.split('\n')[0]);
        for (const unitId of group.unitIds) {
          const unit = unitsById.get(unitId)!;
          await this.git(worktreePath, ['apply', '--index', '--binary', '--whitespace=nowarn', '-'], { stdin: patchInput(unit.patch) });
        }
        await this.git(worktreePath, ['commit', '-m', group.message], { timeout: 300_000 });
        commitHashes.push(await this.git(worktreePath, ['rev-parse', 'HEAD']));
      }
      const newHead = commitHashes.at(-1)!;
      const actualTree = await this.git(worktreePath, ['rev-parse', `${newHead}^{tree}`]);
      if (actualTree !== session.expectedTree) throw new Error(t('Composed commits do not reproduce the expected final tree. No history was changed.'));

      if (session.unselectedIndexPatch) await this.preflightIndexPatch(repo.rootPath, newHead, session.unselectedIndexPatch);
      if (session.source.mode === 'working') {
        backupRef = `${BACKUP_PREFIX}${Date.now()}-${session.oldHead.slice(0, 8)}`;
        await this.git(repo.rootPath, ['update-ref', backupRef, session.oldHead]);
      }
      await this.git(repo.rootPath, ['update-ref', session.branchRef, newHead, session.oldHead]);
      branchUpdated = true;
      if (session.source.mode === 'working') {
        await this.git(repo.rootPath, ['reset', '--mixed', newHead]);
        if (session.unselectedIndexPatch) {
          await this.git(repo.rootPath, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { stdin: patchInput(session.unselectedIndexPatch) });
        }
      }
      if (backupRef) await this.pruneBackupRefs(repo.rootPath).catch(() => undefined);
      onProgress(groups.length, groups.length, t('AI Commit Composer completed'));
      return {
        commitCount: groups.length,
        commitHashes,
        ...(backupRef ? {
          backupRef,
          recoveryCommand: `git reset --mixed ${backupRef}`,
        } : {}),
      };
    } catch (error: unknown) {
      if (branchUpdated && backupRef) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(t('Commits were created, but final workspace restoration failed: {0}. Recover with: {1}', detail, `git reset --mixed ${backupRef}`));
      }
      throw error;
    } finally {
      if (worktreeAdded) await this.git(repo.rootPath, ['worktree', 'remove', '--force', worktreePath]).catch(() => '');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  private validateGroups(session: PreparedGitComposerSession, groups: ComposerCommitGroup[]): void {
    if (!groups.length || groups.some(group => !group.message.trim() || !group.unitIds.length)) throw new Error(t('Every commit group needs a message and at least one change.'));
    const expected = new Set(session.units.map(unit => unit.id));
    const seen = new Set<string>();
    for (const group of groups) for (const id of group.unitIds) {
      if (!expected.has(id) || seen.has(id)) throw new Error(t('Every change unit must be assigned exactly once.'));
      seen.add(id);
    }
    if (seen.size !== expected.size) throw new Error(t('Every change unit must be assigned exactly once.'));
  }

  private async preflightIndexPatch(rootPath: string, head: string, patch: string): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'versiondock-composer-preflight-'));
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tempRoot, 'index') };
    try {
      await this.git(rootPath, ['read-tree', head], { env });
      await this.git(rootPath, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { env, stdin: patchInput(patch) });
    } finally { fs.rmSync(tempRoot, { recursive: true, force: true }); }
  }

  private async pruneBackupRefs(rootPath: string): Promise<void> {
    const refs = (await this.git(rootPath, ['for-each-ref', '--sort=-refname', '--format=%(refname)', BACKUP_PREFIX]))
      .split('\n').map(value => value.trim()).filter(Boolean);
    for (const ref of refs.slice(BACKUP_LIMIT)) await this.git(rootPath, ['update-ref', '-d', ref]);
  }
}
