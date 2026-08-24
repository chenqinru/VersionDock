import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { TextDecoder } from 'util';
import { type SimpleGit } from 'simple-git';
import type { ShelveEntry } from '../types/messages';
import { t } from '../utils/l10n';
import { createGitClient, withGitWriteLock } from './GitOperationLock';

type ChangelistAssignment = NonNullable<ShelveEntry['changelistAssignments']>[number];

const META_FILE = 'shelves.json';
const MAX_SYNTHETIC_TEXT_PATCH_BYTES = 8 * 1024 * 1024;

interface BinaryFile {
  repoRelPath: string;   // path relative to repo root
  storeName: string;     // filename inside shelfDir
  mode?: number;
  kind?: 'file' | 'symlink'; // missing means file for backward compatibility
}

// Extended entry stored only internally (not in messages.ts)
interface ShelveEntryInternal extends ShelveEntry {
  binaryFiles?: BinaryFile[];
  // changelistAssignments is inherited from ShelveEntry and persisted
}

interface ShelfMetaInternal {
  shelves: ShelveEntryInternal[];
}

export class ShelveService {
  private git: SimpleGit;
  private shelfDir: string;
  private metaPath: string;

  constructor(public readonly rootPath: string, globalStorage: string) {
    // Keep read-only shelf queries concurrent; Git writes are serialized by
    // GitOperationLock and optional index refreshes are disabled below.
    this.git = createGitClient(rootPath);
    const repoHash = crypto.createHash('sha1').update(rootPath).digest('hex').slice(0, 16);
    this.shelfDir = path.join(globalStorage, 'shelves', repoHash);
    this.metaPath = path.join(this.shelfDir, META_FILE);
  }

  private ensureShelfDir(): void {
    if (!fs.existsSync(this.shelfDir)) {
      fs.mkdirSync(this.shelfDir, { recursive: true });
    }
  }

  private resolveRelativeFile(basePath: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) {
      throw new Error(`Invalid relative path: ${relativePath}`);
    }
    const resolvedBase = path.resolve(basePath);
    const resolvedPath = path.resolve(resolvedBase, relativePath);
    const relation = path.relative(resolvedBase, resolvedPath);
    if (!relation || relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) {
      throw new Error(`Path escapes its storage root: ${relativePath}`);
    }
    return resolvedPath;
  }

  private resolveShelfFile(relativePath: string): string {
    return this.resolveRelativeFile(this.shelfDir, relativePath);
  }

  private resolveRepoFile(relativePath: string): string {
    return this.resolveRelativeFile(this.rootPath, relativePath);
  }

  private normalizeRepoRelativePath(relativePath: string): string {
    const absolutePath = this.resolveRepoFile(relativePath);
    return path.relative(path.resolve(this.rootPath), absolutePath).split(path.sep).join('/');
  }

  private literalPathspec(relativePath: string): string {
    return `:(literal)${this.normalizeRepoRelativePath(relativePath)}`;
  }

  private literalPathspecs(relativePaths: string[]): string[] {
    return relativePaths.map(relativePath => this.literalPathspec(relativePath));
  }

  private resolveStoredRegularFile(relativePath: string): string {
    const storedPath = this.resolveShelfFile(relativePath);
    this.assertNoSymlinkComponents(this.shelfDir, storedPath);
    const stat = fs.lstatSync(storedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Stored content is not a regular file: ${relativePath}`);
    }
    return storedPath;
  }

  private assertNoSymlinkComponents(basePath: string, targetPath: string): void {
    const resolvedBase = path.resolve(basePath);
    const relation = path.relative(resolvedBase, targetPath);
    let currentPath = resolvedBase;
    for (const component of relation.split(path.sep).filter(Boolean)) {
      currentPath = path.join(currentPath, component);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(currentPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic link in destination path: ${currentPath}`);
      }
    }
  }

  private prepareBinaryRestores(entry: ShelveEntryInternal, paths?: string[]): Array<BinaryFile & { src: string; dst: string }> {
    const selected = paths
      ? (entry.binaryFiles ?? []).filter(binary => paths.includes(binary.repoRelPath))
      : (entry.binaryFiles ?? []);

    return selected.map(binary => {
      try {
        const src = this.resolveStoredRegularFile(binary.storeName);

        const dst = this.resolveRepoFile(binary.repoRelPath);
        this.assertNoSymlinkComponents(this.rootPath, dst);
        try {
          fs.lstatSync(dst);
          throw new Error('Destination already exists');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return { ...binary, src, dst };
      } catch (error) {
        throw new Error(t('Cannot safely restore shelved file {0}: {1}', binary.repoRelPath, error instanceof Error ? error.message : String(error)));
      }
    });
  }

  private readMeta(): ShelfMetaInternal {
    try {
      if (fs.existsSync(this.metaPath)) {
        return JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as ShelfMetaInternal;
      }
    } catch { /* corrupt meta → start fresh */ }
    return { shelves: [] };
  }

  private writeMeta(meta: ShelfMetaInternal): void {
    this.ensureShelfDir();
    const tempPath = `${this.metaPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(meta, null, 2), 'utf8');
      fs.renameSync(tempPath, this.metaPath);
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* renamed or never created */ }
    }
  }

  async list(): Promise<ShelveEntry[]> {
    const meta = this.readMeta();
    const valid = meta.shelves.filter(s => {
      try {
        this.resolveStoredRegularFile(s.patchFile);
        return true;
      } catch {
        return false;
      }
    });
    if (valid.length !== meta.shelves.length) this.writeMeta({ shelves: valid });
    // Strip internal fields before returning to webview
    return valid.map(({ binaryFiles: _b, ...rest }) => rest);
  }

  /**
   * Treat large, invalid UTF-8, or NUL-containing files as binary. Text-patch
   * candidates are scanned completely so a late binary segment cannot be
   * decoded with replacement characters and permanently changed.
   */
  private isBinary(absPath: string): boolean {
    let fd: number | undefined;
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const buf = Buffer.allocUnsafe(64 * 1024);
      fd = fs.openSync(absPath, 'r');
      if (fs.fstatSync(fd).size > MAX_SYNTHETIC_TEXT_PATCH_BYTES) return true;
      let position = 0;
      let bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
      while (bytesRead > 0) {
        const chunk = buf.subarray(0, bytesRead);
        if (chunk.includes(0)) return true;
        decoder.decode(chunk, { stream: true });
        position += bytesRead;
        bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
      }
      decoder.decode();
      return false;
    } catch {
      return true;
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore close failure */ }
      }
    }
  }

  /** Decode the C-style quoting used by Git patch headers, including octal UTF-8 bytes. */
  private decodeGitQuotedPath(value: string): string | undefined {
    if (!value.startsWith('"') || !value.endsWith('"')) return value;
    const bytes: number[] = [];
    for (let index = 1; index < value.length - 1; index++) {
      const character = value[index];
      if (character !== '\\') {
        const codePoint = value.codePointAt(index);
        if (codePoint === undefined) return undefined;
        bytes.push(...Buffer.from(String.fromCodePoint(codePoint), 'utf8'));
        if (codePoint > 0xffff) index++;
        continue;
      }

      const escaped = value[++index];
      if (escaped === undefined || index >= value.length) return undefined;
      const escapeBytes: Record<string, number> = {
        a: 0x07,
        b: 0x08,
        t: 0x09,
        n: 0x0a,
        v: 0x0b,
        f: 0x0c,
        r: 0x0d,
        '"': 0x22,
        '\\': 0x5c,
      };
      if (escapeBytes[escaped] !== undefined) {
        bytes.push(escapeBytes[escaped]);
        continue;
      }
      if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        while (octal.length < 3 && index + 1 < value.length - 1 && /[0-7]/.test(value[index + 1])) {
          octal += value[++index];
        }
        bytes.push(Number.parseInt(octal, 8));
        continue;
      }
      return undefined;
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
    } catch {
      return undefined;
    }
  }

  private quoteGitPatchPath(value: string): string {
    let result = '"';
    for (const byte of Buffer.from(value, 'utf8')) {
      if (byte === 0x22) result += '\\"';
      else if (byte === 0x5c) result += '\\\\';
      else if (byte >= 0x20 && byte <= 0x7e) result += String.fromCharCode(byte);
      else result += `\\${byte.toString(8).padStart(3, '0')}`;
    }
    return `${result}"`;
  }

  private buildUntrackedTextPatch(repoRelPath: string, content: string, mode: number): string {
    const aPath = this.quoteGitPatchPath(`a/${repoRelPath}`);
    const bPath = this.quoteGitPatchPath(`b/${repoRelPath}`);
    const fileMode = (mode & 0o111) !== 0 ? '100755' : '100644';
    const contentLines = content.split('\n');
    const hasFinalNewline = content.endsWith('\n');
    if (hasFinalNewline) contentLines.pop();
    let patch = `diff --git ${aPath} ${bPath}\nnew file mode ${fileMode}\n--- /dev/null\n+++ ${bPath}\n`;
    if (contentLines.length === 0) return patch;
    patch += `@@ -0,0 +1,${contentLines.length} @@\n`;
    patch += `${contentLines.map(line => `+${line}`).join('\n')}\n`;
    if (!hasFinalNewline) patch += '\\ No newline at end of file\n';
    return patch;
  }

  private patchChunkTouchesPath(chunk: string, repoRelPath: string): boolean {
    const decode = (rawPath: string, stripDiffPrefix: boolean): string => {
      if (!rawPath || rawPath === '/dev/null') return '';
      // Git appends a tab sentinel to unquoted ---/+++ paths containing spaces.
      // A real tab in a filename is C-quoted, so stripping this one delimiter is
      // unambiguous for patches generated by `git diff`.
      const encodedPath = stripDiffPrefix && !rawPath.startsWith('"') && rawPath.endsWith('\t')
        ? rawPath.slice(0, -1)
        : rawPath;
      const decoded = this.decodeGitQuotedPath(encodedPath);
      if (decoded === undefined) return '';
      return stripDiffPrefix ? decoded.replace(/^[ab]\//, '') : decoded;
    };
    for (const line of chunk.split('\n')) {
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        if (decode(line.slice(4), true) === repoRelPath) return true;
      } else if (line.startsWith('rename from ')) {
        if (decode(line.slice(12), false) === repoRelPath) return true;
      } else if (line.startsWith('rename to ')) {
        if (decode(line.slice(10), false) === repoRelPath) return true;
      }
    }
    return false;
  }

  async push(name: string, paths?: string[], changelistAssignments?: ChangelistAssignment[]): Promise<ShelveEntry> {
    return withGitWriteLock(this.rootPath, () => this.pushLocked(name, paths, changelistAssignments));
  }

  private async pushLocked(name: string, paths?: string[], changelistAssignments?: ChangelistAssignment[]): Promise<ShelveEntry> {
    this.ensureShelfDir();

    const statusOutput = await this.git.status();
    const allChanged = [...new Set([
      ...statusOutput.modified,
      ...statusOutput.created,
      ...statusOutput.deleted,
      ...statusOutput.renamed.map(r => r.to),
      ...statusOutput.not_added,
    ])];

    const filesToShelve = paths
      ? allChanged.filter(f => paths.includes(f))
      : allChanged;

    if (filesToShelve.length === 0) throw new Error(t('No changes to shelve'));

    const trackedFiles = filesToShelve.filter(f => !statusOutput.not_added.includes(f));
    const untrackedFiles = filesToShelve.filter(f => statusOutput.not_added.includes(f));
    const selectedRenames = statusOutput.renamed.filter(rename => trackedFiles.includes(rename.to));
    const trackedDiffPaths = Array.from(new Set([
      ...trackedFiles,
      ...selectedRenames.flatMap(rename => [rename.from, rename.to]),
    ]));

    const id = `shelf-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    const binaryFiles: BinaryFile[] = [];

    // ── Tracked files: use git diff HEAD --binary ─────────────────────────────
    // --binary produces a complete patch including binary deltas that git apply
    // can reconstruct, with the full index line required for binary files.
    let combinedDiff = '';
    if (trackedDiffPaths.length > 0) {
      // Never continue with an empty patch after a Git failure: doing so and
      // then restoring the worktree would discard changes that were not saved.
      combinedDiff = await this.git.raw([
        '-c', 'core.quotepath=false',
        'diff', 'HEAD', '--binary', '--', ...this.literalPathspecs(trackedDiffPaths),
      ]);
    }

    // ── Untracked files ───────────────────────────────────────────────────────
    // Text files: synthetic new-file diff.
    // Binary files: copy them physically into the shelf dir.
    for (const f of untrackedFiles) {
      const absPath = path.join(this.rootPath, f);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absPath);
      } catch (error) {
        throw new Error(t('Unable to read untracked file {0}: {1}', f, String(error)));
      }
      if (stat.isSymbolicLink()) {
        // POSIX symlink targets are arbitrary bytes (except NUL). Reading them
        // as UTF-8 text can replace invalid bytes, while an embedded newline
        // cannot be represented safely as a one-line synthetic patch. Store the
        // raw target bytes and recreate the link directly when unshelving.
        const storeName = `${id}-${crypto.createHash('sha1').update(f).digest('hex').slice(0, 8)}.symlink`;
        try {
          const target = fs.readlinkSync(absPath, { encoding: 'buffer' });
          fs.writeFileSync(this.resolveShelfFile(storeName), target, { flag: 'wx', mode: 0o600 });
          binaryFiles.push({ repoRelPath: f, storeName, kind: 'symlink' });
        } catch (error) {
          throw new Error(t('Unable to save untracked file {0}: {1}', f, String(error)));
        }
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(t('Unable to shelve unsupported file type: {0}', f));
      }
      if (this.isBinary(absPath)) {
        // Store a raw copy alongside the patch
        const storeName = `${id}-${crypto.createHash('sha1').update(f).digest('hex').slice(0, 8)}${path.extname(f)}`;
        try {
          fs.copyFileSync(absPath, this.resolveShelfFile(storeName), fs.constants.COPYFILE_EXCL);
          binaryFiles.push({ repoRelPath: f, storeName, mode: stat.mode & 0o777, kind: 'file' });
        } catch (error) {
          throw new Error(t('Unable to save untracked file {0}: {1}', f, String(error)));
        }
      } else {
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          combinedDiff += this.buildUntrackedTextPatch(f, content, stat.mode);
        } catch (error) {
          throw new Error(t('Unable to save untracked file {0}: {1}', f, String(error)));
        }
      }
    }

    if (!combinedDiff.trim() && binaryFiles.length === 0) {
      throw new Error(t('Nothing to shelve (diff is empty)'));
    }

    // ── Write patch file ──────────────────────────────────────────────────────
    const patchFileName = `${id}.patch`;
    fs.writeFileSync(this.resolveShelfFile(patchFileName), combinedDiff, { encoding: 'utf8', flag: 'wx' });

    // ── Build file list with status ───────────────────────────────────────────
    const statusMap: Record<string, string> = {};
    for (const f of statusOutput.modified) statusMap[f] = 'modified';
    for (const f of statusOutput.created) statusMap[f] = 'added';
    for (const f of statusOutput.deleted) statusMap[f] = 'deleted';
    for (const r of statusOutput.renamed) statusMap[r.to] = 'renamed';
    for (const f of statusOutput.not_added) statusMap[f] = 'untracked';

    const fileList: Array<{ path: string; status: string }> = [];
    for (const f of filesToShelve) fileList.push({ path: f, status: statusMap[f] ?? 'modified' });

    const entry: ShelveEntryInternal = {
      id,
      name,
      date: new Date().toISOString(),
      branch: statusOutput.current || undefined,
      files: fileList,
      patchFile: patchFileName,
      binaryFiles: binaryFiles.length > 0 ? binaryFiles : undefined,
      changelistAssignments: changelistAssignments && changelistAssignments.length > 0 ? changelistAssignments : undefined,
    };

    const meta = this.readMeta();
    meta.shelves.unshift(entry);
    this.writeMeta(meta);

    // ── Revert shelved files ──────────────────────────────────────────────────
    const renamedTargets = new Set(selectedRenames.map(rename => rename.to));
    for (const rename of selectedRenames) {
      // A pathspec containing only the destination makes Git render a rename as
      // an add and cannot restore the source. Reset both sides, restore the old
      // path from HEAD, then remove the now-untracked destination.
      const renamePathspecs = this.literalPathspecs([rename.from, rename.to]);
      const sourcePathspec = this.literalPathspec(rename.from);
      await this.git.raw(['reset', 'HEAD', '--', ...renamePathspecs]);
      await this.git.raw(['restore', '--source=HEAD', '--worktree', '--', sourcePathspec])
        .catch(() => this.git.raw(['checkout', 'HEAD', '--', sourcePathspec]));
      fs.rmSync(path.join(this.rootPath, rename.to), { recursive: true, force: true });
    }
    for (const f of trackedFiles.filter(filePath => !renamedTargets.has(filePath))) {
      const pathspec = this.literalPathspec(f);
      // git restore --staged --worktree restores both index and working tree from HEAD.
      // For deleted files (staged or unstaged) this recreates the file.
      const ok = await this.git.raw(['restore', '--staged', '--worktree', '--', pathspec]).then(() => true).catch(() => false);
      if (!ok) {
        // Older git: restore staged first (index ← HEAD), then worktree (file ← index)
        await this.git.raw(['reset', 'HEAD', '--', pathspec]);
        const restored = await this.git.raw(['checkout', 'HEAD', '--', pathspec]).then(() => true).catch(() => false);
        if (!restored) {
          // A newly-added path does not exist in HEAD, so checkout cannot remove
          // it after reset. The patch is already durable at this point.
          if (statusOutput.created.includes(f)) {
            fs.rmSync(this.resolveRepoFile(f), { recursive: true, force: true });
          } else {
            throw new Error(t('Cannot safely restore shelved file {0}: {1}', f, 'path is absent from HEAD'));
          }
        }
      }
    }
    for (const f of untrackedFiles) {
      const abs = path.join(this.rootPath, f);
      try { fs.unlinkSync(abs); } catch { /* already gone */ }
    }

    return entry;
  }

  async apply(shelveId: string, paths?: string[]): Promise<ChangelistAssignment[] | undefined> {
    return withGitWriteLock(this.rootPath, () => this.applyLocked(shelveId, paths));
  }

  private async applyLocked(shelveId: string, paths?: string[]): Promise<ChangelistAssignment[] | undefined> {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(t('Shelve "{0}" not found', shelveId));

    let patchAbs: string;
    try {
      patchAbs = this.resolveStoredRegularFile(entry.patchFile);
    } catch {
      throw new Error(t('Patch file not found on disk'));
    }

    // ── Apply text/binary patch ───────────────────────────────────────────────
    const fullPatch = fs.readFileSync(patchAbs, 'utf8');

    // When applying a subset of files, extract only their chunks into a temp patch.
    let applyAbs: string | undefined = patchAbs;
    let tmpPath: string | undefined;
    if (paths && paths.length > 0 && fullPatch.trim()) {
      const chunks = fullPatch.split(/(?=^diff --git )/m);
      const selected = chunks.filter(c =>
        paths.some(p => this.patchChunkTouchesPath(c, p))
      );
      if (selected.length > 0) {
        tmpPath = this.resolveShelfFile(`_tmp_${crypto.randomBytes(8).toString('hex')}.patch`);
        fs.writeFileSync(tmpPath, selected.join(''), { encoding: 'utf8', flag: 'wx' });
        applyAbs = tmpPath;
      } else {
        // A subset request that has no text patch must not fall back to applying
        // the entire shelf (it may be selecting a physically-stored binary only).
        applyAbs = undefined;
      }
    }

    const binaryToRestore = this.prepareBinaryRestores(entry, paths);
    try {
      if (applyAbs && fullPatch.trim()) {
        try {
          // --binary: allow binary patch reconstruction; --3way: leave conflict markers
          await this.git.raw(['apply', '--binary', '--3way', '--whitespace=nowarn', applyAbs]);
        } catch (e) {
          const conflictCheck = await this.git.raw(['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '');
          if (conflictCheck) {
            throw Object.assign(new Error('SHELVE_CONFLICT'), {
              code: 'SHELVE_CONFLICT',
              conflictFiles: conflictCheck.split('\0').filter(Boolean),
            });
          }
          // Fallback without --3way (older git)
          await this.git.raw(['apply', '--binary', '--whitespace=nowarn', applyAbs]).catch(() => {
            throw new Error(t('Failed to apply patch: {0}', String(e)));
          });
        }
      }

      // ── Restore physically-stored binary untracked files ────────────────────
      for (const bf of binaryToRestore) {
        fs.mkdirSync(path.dirname(bf.dst), { recursive: true });
        this.assertNoSymlinkComponents(this.rootPath, bf.dst);
        try {
          if (bf.kind === 'symlink') {
            fs.symlinkSync(fs.readFileSync(bf.src), bf.dst);
          } else {
            fs.copyFileSync(bf.src, bf.dst, fs.constants.COPYFILE_EXCL);
            if (bf.mode !== undefined) fs.chmodSync(bf.dst, bf.mode);
          }
        } catch (error) {
          throw new Error(t('Cannot safely restore shelved file {0}: {1}', bf.repoRelPath, error instanceof Error ? error.message : String(error)));
        }
      }
    } finally {
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }

    // Return changelist assignments so caller can restore them
    if (!paths && entry.changelistAssignments?.length) return entry.changelistAssignments;
    if (paths && entry.changelistAssignments?.length) {
      const pathSet = new Set(paths);
      const filtered = entry.changelistAssignments.filter(a => pathSet.has(a.path));
      return filtered.length > 0 ? filtered : undefined;
    }
    return undefined;
  }

  drop(shelveId: string): void {
    const meta = this.readMeta();
    const idx = meta.shelves.findIndex(s => s.id === shelveId);
    if (idx === -1) throw new Error(t('Shelve "{0}" not found', shelveId));
    const entry = meta.shelves[idx];
    // Delete patch file
    try { fs.unlinkSync(this.resolveShelfFile(entry.patchFile)); } catch { /* already gone or unsafe */ }
    // Delete any stored binary copies
    for (const bf of entry.binaryFiles ?? []) {
      try { fs.unlinkSync(this.resolveShelfFile(bf.storeName)); } catch { /* already gone or unsafe */ }
    }
    meta.shelves.splice(idx, 1);
    this.writeMeta(meta);
  }

  rename(shelveId: string, newName: string): void {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(t('Shelve "{0}" not found', shelveId));
    entry.name = newName;
    this.writeMeta(meta);
  }

  getFileDiff(shelveId: string, filePath: string): string {
    const meta = this.readMeta();
    const entry = meta.shelves.find(s => s.id === shelveId);
    if (!entry) throw new Error(t('Shelve "{0}" not found', shelveId));

    let patchAbs: string;
    try {
      patchAbs = this.resolveStoredRegularFile(entry.patchFile);
    } catch {
      return '';
    }
    if (!fs.existsSync(patchAbs)) return '';

    const fullPatch = fs.readFileSync(patchAbs, 'utf8');
    const chunks = fullPatch.split(/(?=^diff --git )/m);
    const chunk = chunks.find(c => this.patchChunkTouchesPath(c, filePath));
    return chunk?.trim() ?? '';
  }
}
