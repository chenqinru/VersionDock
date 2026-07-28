import type { DiffHunk, FileDiff } from '../types/git';
import * as path from 'path';

interface DiffPaths {
  oldPath: string;
  newPath: string;
}

const LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  php: 'php', py: 'python', go: 'go', java: 'java', rs: 'rust',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', xml: 'xml', svg: 'xml',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  md: 'markdown', sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', graphql: 'graphql', vue: 'html',
  c: 'c', cpp: 'cpp', cs: 'csharp', rb: 'ruby', swift: 'swift',
  kt: 'kotlin', dart: 'dart',
};

export function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).replace('.', '').toLowerCase();
  return LANG_MAP[ext] ?? 'plaintext';
}

/** Decode the C-style quoting Git uses for paths containing control bytes. */
function decodeGitPath(value: string): string | undefined {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) return undefined;

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
    if (escaped === undefined || index >= value.length - 1) return undefined;
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
    if (!/[0-7]/.test(escaped)) return undefined;
    let octal = escaped;
    while (octal.length < 3 && index + 1 < value.length - 1 && /[0-7]/.test(value[index + 1])) {
      octal += value[++index];
    }
    bytes.push(Number.parseInt(octal, 8));
  }

  return Buffer.from(bytes).toString('utf8');
}

function stripPatchPrefix(value: string): string {
  if (value === '/dev/null') return '';
  // Git terminates an unquoted ---/+++ path containing spaces with a tab, and
  // SVN appends its revision/working-copy label after the same delimiter. A
  // real tab in a Git filename is C-quoted, so taking the prefix is safe.
  const tabIndex = value.startsWith('"') ? -1 : value.indexOf('\t');
  const encoded = tabIndex >= 0 ? value.slice(0, tabIndex) : value;
  const decoded = decodeGitPath(encoded) ?? '';
  return decoded.startsWith('a/') || decoded.startsWith('b/') ? decoded.slice(2) : decoded;
}

function parseQuotedToken(value: string, start: number): { token: string; next: number } | undefined {
  if (value[start] !== '"') return undefined;
  let escaped = false;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (!escaped && character === '"') {
      return { token: value.slice(start, index + 1), next: index + 1 };
    }
    if (!escaped && character === '\\') escaped = true;
    else escaped = false;
  }
  return undefined;
}

function parseDiffHeader(header: string): DiffPaths {
  if (header.startsWith('"')) {
    const oldToken = parseQuotedToken(header, 0);
    if (oldToken) {
      const newStart = header.slice(oldToken.next).search(/\S/);
      if (newStart >= 0) {
        const absoluteNewStart = oldToken.next + newStart;
        const newToken = parseQuotedToken(header, absoluteNewStart);
        if (newToken && !header.slice(newToken.next).trim()) {
          return {
            oldPath: stripPatchPrefix(oldToken.token),
            newPath: stripPatchPrefix(newToken.token),
          };
        }
      }
    }
  }

  // Unquoted paths may contain spaces, including the apparent " b/"
  // delimiter. Prefer the split where both sides name the same path; renames
  // are resolved later from their unambiguous rename-from/to headers.
  for (let index = header.indexOf(' b/'); index >= 0; index = header.indexOf(' b/', index + 1)) {
    const oldToken = header.slice(0, index);
    const newToken = header.slice(index + 1);
    if (oldToken.startsWith('a/') && newToken.startsWith('b/') && oldToken.slice(2) === newToken.slice(2)) {
      return { oldPath: oldToken.slice(2), newPath: newToken.slice(2) };
    }
  }

  const separator = header.indexOf(' b/');
  if (header.startsWith('a/') && separator >= 0) {
    return { oldPath: header.slice(2, separator), newPath: header.slice(separator + 3) };
  }
  return { oldPath: '', newPath: '' };
}

export function parseDiff(rawDiff: string, repoId: string): FileDiff[] {
  const results: FileDiff[] = [];
  if (!rawDiff.trim()) return results;

  const fileChunks = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerLine = lines[0];

    const headerPaths = parseDiffHeader(headerLine);
    let oldPath = headerPaths.oldPath;
    let newPath = headerPaths.newPath || oldPath;

    let isBinary = false;
    let isNew = false;
    let isDeleted = false;
    let hunkStart = -1;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('Binary files') || line === 'GIT binary patch') { isBinary = true; break; }
      if (line.startsWith('new file mode')) isNew = true;
      if (line.startsWith('deleted file mode')) isDeleted = true;
      if (line.startsWith('rename from ')) oldPath = decodeGitPath(line.slice('rename from '.length)) ?? oldPath;
      if (line.startsWith('rename to ')) newPath = decodeGitPath(line.slice('rename to '.length)) ?? newPath;
      if (line.startsWith('copy from ')) oldPath = decodeGitPath(line.slice('copy from '.length)) ?? oldPath;
      if (line.startsWith('copy to ')) newPath = decodeGitPath(line.slice('copy to '.length)) ?? newPath;
      if (line.startsWith('--- ')) oldPath = stripPatchPrefix(line.slice(4)) || oldPath;
      if (line.startsWith('+++ ')) newPath = stripPatchPrefix(line.slice(4)) || newPath;
      if (line.startsWith('@@')) { hunkStart = i; break; }
    }

    const hunks: DiffHunk[] = isBinary ? [] : parseHunks(lines.slice(hunkStart >= 0 ? hunkStart : lines.length));

    results.push({
      repoId,
      oldPath,
      newPath,
      isBinary,
      isNew,
      isDeleted,
      hunks,
      language: detectLanguage(newPath || oldPath),
    });
  }

  return results;
}

function parseHunks(lines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkMatch) {
      if (current) hunks.push(current);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      const ranges = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      current = {
        header: line,
        oldStart: parseInt(ranges?.[1] ?? '0', 10),
        oldLines: parseInt(ranges?.[2] ?? '1', 10),
        newStart: parseInt(ranges?.[3] ?? '0', 10),
        newLines: parseInt(ranges?.[4] ?? '1', 10),
        lines: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', content: line.slice(1), newLineNo: newLine++ });
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine++ });
    } else if (line.startsWith(' ')) {
      current.lines.push({ type: 'context', content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

export function buildMonacoContents(hunks: DiffHunk[]): { original: string; modified: string } {
  const originalLines: string[] = [];
  const modifiedLines: string[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') {
        originalLines.push(line.content);
        modifiedLines.push(line.content);
      } else if (line.type === 'remove') {
        originalLines.push(line.content);
      } else if (line.type === 'add') {
        modifiedLines.push(line.content);
      }
    }
  }

  return {
    original: originalLines.join('\n'),
    modified: modifiedLines.join('\n'),
  };
}
