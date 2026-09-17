import * as fs from 'fs';
import * as path from 'path';
import { t } from './l10n';

export interface ResolvedRepoPath {
  absolutePath: string;
  relativePath: string;
}

export interface ResolveRepoPathOptions {
  allowAbsolute?: boolean;
  allowRoot?: boolean;
}

export function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Resolve a path against a repository root and reject paths that escape it.
 * Webview-originated paths should keep allowAbsolute disabled.
 */
export function resolveRepoPath(
  rootPath: string,
  filePath: string,
  options: ResolveRepoPathOptions = {},
): ResolvedRepoPath {
  if (typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error(t('Path is outside the repository: {0}', String(filePath)));
  }
  if (!options.allowAbsolute && path.isAbsolute(filePath)) {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  const normalizedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(normalizedRoot, filePath);
  if (!isSameOrChildPath(normalizedRoot, absolutePath)) {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  const relative = path.relative(normalizedRoot, absolutePath);
  if (!options.allowRoot && relative === '') {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  return {
    absolutePath,
    relativePath: relative.split(path.sep).join('/'),
  };
}

/**
 * Reject an existing symbolic link between the repository root and a target.
 * The repository root itself may be a symlink because opening a symlinked
 * workspace is valid. Include the leaf when an operation would follow or
 * overwrite it rather than merely unlinking the link itself.
 */
export function assertNoSymlinkAncestors(
  rootPath: string,
  targetPath: string,
  options: { includeTarget?: boolean } = {},
): void {
  const resolved = resolveRepoPath(rootPath, targetPath, { allowAbsolute: true, allowRoot: true });
  const segments = resolved.relativePath.split('/').filter(Boolean);
  const count = options.includeTarget ? segments.length : Math.max(0, segments.length - 1);
  let cursor = path.resolve(rootPath);
  for (const segment of segments.slice(0, count)) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(t('Path is outside the repository: {0}', targetPath));
    }
  }
}

const WINDOWS_RESERVED_DEVICE_NAMES = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

/**
 * 校验跨平台有效的单级目录名（用于 Git 克隆 / SVN 检出的目标子目录名）
 * 严格防范 Windows 保留设备名、非法控制字符、路径分隔符以及末尾点和空格。
 */
export function isValidTargetDirName(name: string): boolean {
  if (typeof name !== 'string') return false;
  // 禁止前导空格、末尾空格或末尾句点（Windows 会自动剥离或导致路径碰撞）
  if (name.startsWith(' ') || name.endsWith(' ') || name.endsWith('.')) return false;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return false;
  // 禁止包含正反斜杠以及路径穿越
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (path.posix.basename(trimmed) !== trimmed || path.win32.basename(trimmed) !== trimmed) return false;
  // 禁止 Windows 非法字符 < > : " | ? *
  if (/[<>:"|?*]/.test(trimmed)) return false;
  // 禁止控制字符（ASCII 0-31 及 127）
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  // 禁止 Windows 保留设备名（CON, PRN, AUX, NUL, COM1-9, LPT1-9 等，包括大小写及带扩展名）
  if (WINDOWS_RESERVED_DEVICE_NAMES.test(trimmed)) return false;

  return true;
}
