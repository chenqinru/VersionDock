import * as path from 'path';
import { createGitClient, waitForGitWrite } from './GitOperationLock';

export interface BlameLine {
  lineNumber: number; // 0-indexed
  hash: string;
  author: string;
  date: Date;
  summary: string;
  isUncommitted: boolean;
}

export class BlameService {
  private static readonly MAX_CACHE_ENTRIES = 50;
  private cache = new Map<string, BlameLine[]>();
  private pending = new Map<string, Promise<BlameLine[]>>();
  private revisions = new Map<string, number>();
  private activeRequests = new Map<string, number>();

  async getBlame(filePath: string, rootPath: string): Promise<BlameLine[]> {
    const cached = this.cache.get(filePath);
    if (cached) {
      // Refresh insertion order to keep recently-used annotations cached.
      this.cache.delete(filePath);
      this.cache.set(filePath, cached);
      return cached;
    }
    const inFlight = this.pending.get(filePath);
    if (inFlight) return inFlight;

    const revision = this.revisions.get(filePath) ?? 0;
    this.activeRequests.set(filePath, (this.activeRequests.get(filePath) ?? 0) + 1);
    const request = (async () => {
      await waitForGitWrite(rootPath);
      const git = createGitClient(rootPath);
      const relPath = path.relative(rootPath, filePath).split(path.sep).join('/');

      let raw: string;
      try {
        // `git blame` accepts one literal path rather than a general pathspec;
        // keep the global guard explicit so future command changes cannot turn a
        // filename beginning with `:(...)` into pathspec magic.
        raw = await git.raw(['--literal-pathspecs', 'blame', '--porcelain', '--', relPath]);
      } catch {
        return [];
      }

      const result = this.parsePorcelain(raw);
      if ((this.revisions.get(filePath) ?? 0) === revision) {
        this.cache.set(filePath, result);
        while (this.cache.size > BlameService.MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value as string | undefined;
          if (!oldest) break;
          this.cache.delete(oldest);
        }
      }
      return result;
    })();
    this.pending.set(filePath, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(filePath) === request) {
        this.pending.delete(filePath);
      }
      const activeCount = (this.activeRequests.get(filePath) ?? 1) - 1;
      if (activeCount <= 0) {
        this.activeRequests.delete(filePath);
        this.revisions.delete(filePath);
      } else {
        this.activeRequests.set(filePath, activeCount);
      }
    }
  }

  invalidate(filePath: string): void {
    this.cache.delete(filePath);
    // An invalidated request is removed from `pending` so a replacement can
    // start immediately, but it remains in `activeRequests` until its process
    // finishes. Keep the revision monotonic while any older request is active;
    // otherwise a second invalidation can reset it to zero and let the oldest
    // result repopulate the cache.
    if ((this.activeRequests.get(filePath) ?? 0) > 0) {
      this.pending.delete(filePath);
      this.revisions.set(filePath, (this.revisions.get(filePath) ?? 0) + 1);
    } else {
      this.revisions.delete(filePath);
    }
  }

  private parsePorcelain(raw: string): BlameLine[] {
    const lines = raw.split('\n');
    const commitMeta = new Map<string, { author: string; date: Date; summary: string }>();
    const result: BlameLine[] = [];

    let i = 0;
    while (i < lines.length) {
      const headerLine = lines[i];
      if (!headerLine || !/^[0-9a-f]{40,64} /.test(headerLine)) {
        i++;
        continue;
      }

      const parts = headerLine.split(' ');
      const hash = parts[0];
      const finalLine = parseInt(parts[2], 10); // 1-indexed in git output

      i++;

      const isNew = !commitMeta.has(hash);
      let author = '';
      let timestamp = 0;
      let summary = '';

      while (i < lines.length && !lines[i].startsWith('\t')) {
        const l = lines[i];
        if (isNew) {
          if (l.startsWith('author ')) author = l.slice(7);
          else if (l.startsWith('author-time ')) timestamp = parseInt(l.slice(12), 10);
          else if (l.startsWith('summary ')) summary = l.slice(8);
        }
        i++;
      }

      if (isNew) {
        commitMeta.set(hash, { author, date: new Date(timestamp * 1000), summary });
      }

      if (i < lines.length) i++; // skip the \t-prefixed line content

      const meta = commitMeta.get(hash)!;
      result.push({
        lineNumber: finalLine - 1, // convert to 0-indexed
        hash,
        author: meta.author,
        date: meta.date,
        summary: meta.summary,
        isUncommitted: hash.startsWith('0000000'),
      });
    }

    return result;
  }
}
