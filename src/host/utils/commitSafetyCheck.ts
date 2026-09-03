import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\.local|\.production|\.development|\.staging)?$/i,
  /\.(?:pem|key|pfx|p12|pkcs12|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
];

export function isSensitivePath(filePath: string): boolean {
  const baseName = path.basename(filePath);
  return SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(baseName));
}

// Windows-reserved file base names (e.g. CON, PRN, AUX, NUL, COM1-9, LPT1-9)
const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

// Characters forbidden in Windows filenames
// eslint-disable-next-line no-control-regex
const WINDOWS_FORBIDDEN_CHARS_REGEX = /[<>:"|?*\x00-\x1F]/;

const COMMON_BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svgz',
  'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'flac',
  'zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'xz',
  'exe', 'dll', 'so', 'dylib', 'bin', 'iso',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'wasm', 'class', 'pyc', 'node', 'woff', 'woff2', 'ttf', 'eot',
]);

export interface SafetyCheckResult {
  hasIssues: boolean;
  largeFiles: { path: string; sizeFormatted: string }[];
  sensitiveFiles: string[];
  invalidFileNameFiles: { path: string; reason: string }[];
  crlfFiles: string[];
}

export interface CommitSafetyOptions {
  warnOnLargeFiles?: boolean;
  largeFileSizeLimitMB?: number;
  warnOnSensitiveFiles?: boolean;
  warnOnInvalidFileNames?: boolean;
  warnOnCrlf?: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isBinaryExtension(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return COMMON_BINARY_EXTENSIONS.has(ext);
}

/**
 * Checks staged or selected files for size violations, sensitive files, invalid filenames, and CRLF.
 */
export function checkCommitSafety(
  rootPath: string,
  relativePaths: readonly string[],
  options?: CommitSafetyOptions,
): SafetyCheckResult {
  const config = vscode.workspace.getConfiguration('versiondock');

  const warnLarge = options?.warnOnLargeFiles ?? config.get<boolean>('guard.warnOnLargeFiles', true);
  const sizeLimitMB = options?.largeFileSizeLimitMB ?? config.get<number>('guard.largeFileSizeLimitMB', 50);
  const maxSizeBytes = Math.max(1, sizeLimitMB) * 1024 * 1024;

  const warnSensitive = options?.warnOnSensitiveFiles ?? true;
  const warnInvalidNames = options?.warnOnInvalidFileNames ?? config.get<boolean>('guard.warnOnInvalidFileNames', true);
  const warnCrlf = options?.warnOnCrlf ?? config.get<boolean>('guard.warnOnCrlf', true);

  const largeFiles: { path: string; sizeFormatted: string }[] = [];
  const sensitiveFiles: string[] = [];
  const invalidFileNameFiles: { path: string; reason: string }[] = [];
  const crlfFiles: string[] = [];

  const seenLowercasePaths = new Map<string, string>();

  for (const relPath of relativePaths) {
    const base = path.basename(relPath);
    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(rootPath, relPath);

    // 1. Sensitive filenames
    if (warnSensitive && !base.endsWith('.example') && !base.endsWith('.sample') && !base.endsWith('.template')) {
      if (SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(base))) {
        sensitiveFiles.push(relPath);
      }
    }

    // 2. Invalid or cross-platform incompatible filenames
    if (warnInvalidNames) {
      const baseWithoutExt = base.split('.')[0]?.toLowerCase() ?? '';
      if (WINDOWS_FORBIDDEN_CHARS_REGEX.test(base)) {
        invalidFileNameFiles.push({ path: relPath, reason: 'contains characters forbidden on Windows (: * ? " < > |)' });
      } else if (base.endsWith(' ') || base.endsWith('.')) {
        invalidFileNameFiles.push({ path: relPath, reason: 'ends with space or dot' });
      } else if (WINDOWS_RESERVED_NAMES.has(baseWithoutExt)) {
        invalidFileNameFiles.push({ path: relPath, reason: `uses Windows-reserved name "${baseWithoutExt}"` });
      }

      // Check case collision in batch
      const lowerKey = relPath.toLowerCase();
      const existing = seenLowercasePaths.get(lowerKey);
      if (existing && existing !== relPath) {
        invalidFileNameFiles.push({ path: relPath, reason: `case collision with "${existing}"` });
      } else {
        seenLowercasePaths.set(lowerKey, relPath);
      }
    }

    // 3. File existence & size / CRLF inspection
    try {
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          // Large file check
          if (warnLarge && stat.size > maxSizeBytes) {
            largeFiles.push({ path: relPath, sizeFormatted: formatBytes(stat.size) });
          }

          // CRLF check on text files (< 5MB)
          if (warnCrlf && !isBinaryExtension(relPath) && stat.size > 0 && stat.size < 5 * 1024 * 1024) {
            const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
            const fd = fs.openSync(fullPath, 'r');
            try {
              const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
              const slice = buffer.subarray(0, bytesRead);
              // Search for \r\n (0x0D 0x0A)
              for (let i = 0; i < slice.length - 1; i++) {
                if (slice[i] === 0x0D && slice[i + 1] === 0x0A) {
                  crlfFiles.push(relPath);
                  break;
                }
              }
            } finally {
              fs.closeSync(fd);
            }
          }
        }
      }
    } catch {
      // Ignore filesystem read errors during pre-commit check
    }
  }

  return {
    hasIssues: largeFiles.length > 0 || sensitiveFiles.length > 0 || invalidFileNameFiles.length > 0 || crlfFiles.length > 0,
    largeFiles,
    sensitiveFiles,
    invalidFileNameFiles,
    crlfFiles,
  };
}
