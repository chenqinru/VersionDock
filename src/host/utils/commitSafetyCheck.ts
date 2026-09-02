import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\.local|\.production|\.development|\.staging)?$/i,
  /\.(?:pem|key|pfx|p12|pkcs12|kdbx)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i,
];

export interface SafetyCheckResult {
  hasIssues: boolean;
  largeFiles: { path: string; sizeFormatted: string }[];
  sensitiveFiles: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Checks staged or selected files for size threshold violations and sensitive filenames.
 */
export function checkCommitSafety(
  rootPath: string,
  relativePaths: readonly string[],
  maxSizeBytes: number = DEFAULT_MAX_FILE_SIZE_BYTES,
): SafetyCheckResult {
  const largeFiles: { path: string; sizeFormatted: string }[] = [];
  const sensitiveFiles: string[] = [];

  for (const relPath of relativePaths) {
    const base = path.basename(relPath);

    // 1. Check for sensitive filenames (excluding templates like .env.example)
    if (!base.endsWith('.example') && !base.endsWith('.sample') && !base.endsWith('.template')) {
      if (SENSITIVE_FILENAME_PATTERNS.some(pattern => pattern.test(base))) {
        sensitiveFiles.push(relPath);
      }
    }

    // 2. Check for physical file size on disk
    try {
      const fullPath = path.isAbsolute(relPath) ? relPath : path.join(rootPath, relPath);
      if (fs.existsSync(fullPath)) {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > maxSizeBytes) {
          largeFiles.push({ path: relPath, sizeFormatted: formatBytes(stat.size) });
        }
      }
    } catch {
      // Ignore filesystem read errors during pre-commit check
    }
  }

  return {
    hasIssues: largeFiles.length > 0 || sensitiveFiles.length > 0,
    largeFiles,
    sensitiveFiles,
  };
}
