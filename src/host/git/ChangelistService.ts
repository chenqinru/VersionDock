import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ChangelistData, RepoStatus } from '../types/git';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../types/git';

interface ChangelistsJson {
  changelists: ChangelistData[];
}

function makeDefaultChangelists(): ChangelistData[] {
  return [
    { id: CHANGELIST_DEFAULT_ID, name: 'Changes', fileAssignments: {} },
    { id: CHANGELIST_UNVERSIONED_ID, name: 'Unversioned Files', fileAssignments: {} },
  ];
}

export class ChangelistService {
  private changelists: ChangelistData[];
  private readonly globalFilePath: string;

  /**
   * @param workspaceFolderPath  fsPath of the first workspace folder (always provided)
   * @param globalStoragePath    VSCode globalStorageUri.fsPath for per-extension storage
   * @param isChangelistMode     whether the current view mode is 'changelists'
   */
  constructor(
    private readonly workspaceFolderPath: string,
    globalStoragePath: string,
    private isChangelistMode: boolean = false,
  ) {
    const repoHash = crypto.createHash('sha1').update(workspaceFolderPath).digest('hex').slice(0, 16);
    this.globalFilePath = path.join(globalStoragePath, 'changelists', repoHash, 'changelists.json');
    this.changelists = this.load();
  }

  setChangelistMode(enabled: boolean): void {
    this.isChangelistMode = enabled;
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private load(): ChangelistData[] {
    try {
      const raw = fs.readFileSync(this.globalFilePath, 'utf8');
      const parsed = JSON.parse(raw) as ChangelistsJson;
      return this.ensureFixedChangelists(parsed.changelists ?? []);
    } catch {
      return makeDefaultChangelists();
    }
  }

  private ensureFixedChangelists(data: ChangelistData[]): ChangelistData[] {
    if (!data.find(c => c.id === CHANGELIST_DEFAULT_ID)) {
      data.unshift({ id: CHANGELIST_DEFAULT_ID, name: 'Changes', fileAssignments: {} });
    }
    if (!data.find(c => c.id === CHANGELIST_UNVERSIONED_ID)) {
      const idx = data.findIndex(c => c.id === CHANGELIST_DEFAULT_ID);
      data.splice(idx + 1, 0, { id: CHANGELIST_UNVERSIONED_ID, name: 'Unversioned Files', fileAssignments: {} });
    }
    return data;
  }

  private save(): void {
    try {
      if (!this.isChangelistMode) return;
      const dir = path.dirname(this.globalFilePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.globalFilePath, JSON.stringify({ changelists: this.changelists }, null, 2), 'utf8');
    } catch {
      // Non-critical — silently fail
    }
  }

  // ── Reconciliation ───────────────────────────────────────────────────────────

  /**
   * Reconcile changelists against current git status.
   * - Removes assignments for files that no longer exist in the repo status.
   * - New staged/modified files (not untracked) → assigned to "Changes" if unassigned.
   * - New untracked files → assigned to "Unversioned Files" if unassigned.
   */
  reconcile(repos: RepoStatus[]): void {
    // Tracked files only (staged + non-untracked unstaged).
    // Unversioned Files (untracked) are always computed live from git status in the view layer
    // and are never persisted in fileAssignments.
    const trackedFiles = new Map<string, Set<string>>();
    for (const r of repos) {
      const tracked = new Set<string>();
      for (const f of r.stagedFiles) tracked.add(f.path);
      for (const f of r.unstagedFiles) {
        if (f.status !== 'untracked') tracked.add(f.path);
      }
      trackedFiles.set(r.repoId, tracked);
    }

    // Migrate assignments created before repo IDs included the VCS kind.
    // Same-path Git/SVN workspaces previously registered only Git, so prefer
    // the Git instance when both new IDs exist for a legacy path key.
    for (const changelist of this.changelists) {
      for (const legacyRepoId of Object.keys(changelist.fileAssignments)) {
        if (trackedFiles.has(legacyRepoId)) continue;
        const normalizedLegacyId = path.normalize(legacyRepoId);
        const gitRepoId = `${normalizedLegacyId}::git`;
        const svnRepoId = `${normalizedLegacyId}::svn`;
        const migratedRepoId = trackedFiles.has(gitRepoId)
          ? gitRepoId
          : trackedFiles.has(svnRepoId) ? svnRepoId : undefined;
        if (!migratedRepoId) continue;
        const existing = changelist.fileAssignments[migratedRepoId] ?? [];
        changelist.fileAssignments[migratedRepoId] = Array.from(new Set([
          ...existing,
          ...changelist.fileAssignments[legacyRepoId],
        ]));
        delete changelist.fileAssignments[legacyRepoId];
      }
    }

    // Clear any stale unversioned assignments (legacy data migration)
    const untrackedCl = this.changelists.find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (untrackedCl) untrackedCl.fileAssignments = {};

    // Build reverse map: repoId+path → changelistId (excluding unversioned)
    const assigned = new Map<string, string>();
    for (const cl of this.changelists) {
      if (cl.id === CHANGELIST_UNVERSIONED_ID) continue;
      for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
        for (const p of paths) assigned.set(`${repoId}::${p}`, cl.id);
      }
    }

    // Prune stale assignments and assign new tracked files to "Changes"
    const defaultCl = this.changelists.find(c => c.id === CHANGELIST_DEFAULT_ID)!;
    for (const cl of this.changelists) {
      if (cl.id === CHANGELIST_UNVERSIONED_ID) continue;
      for (const repoId of Object.keys(cl.fileAssignments)) {
        const repoTracked = trackedFiles.get(repoId);
        if (!repoTracked) { delete cl.fileAssignments[repoId]; continue; }
        cl.fileAssignments[repoId] = cl.fileAssignments[repoId].filter(p => repoTracked.has(p));
        if (cl.fileAssignments[repoId].length === 0) delete cl.fileAssignments[repoId];
      }
    }

    for (const r of repos) {
      const repoId = r.repoId;
      for (const filePath of trackedFiles.get(repoId) ?? []) {
        if (assigned.has(`${repoId}::${filePath}`)) continue;
        if (!defaultCl.fileAssignments[repoId]) defaultCl.fileAssignments[repoId] = [];
        defaultCl.fileAssignments[repoId].push(filePath);
        assigned.set(`${repoId}::${filePath}`, CHANGELIST_DEFAULT_ID);
      }
    }

    this.save();
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  getAll(): ChangelistData[] {
    const unversioned = this.changelists.find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (!unversioned || this.changelists[this.changelists.length - 1]?.id === CHANGELIST_UNVERSIONED_ID) {
      return this.changelists;
    }
    return [
      ...this.changelists.filter(c => c.id !== CHANGELIST_UNVERSIONED_ID),
      unversioned,
    ];
  }

  create(name: string): ChangelistData {
    const id = `cl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const cl: ChangelistData = { id, name, fileAssignments: {} };
    this.changelists.push(cl);
    this.save();
    return cl;
  }

  rename(id: string, name: string): void {
    if (id === CHANGELIST_DEFAULT_ID || id === CHANGELIST_UNVERSIONED_ID) return;
    const cl = this.changelists.find(c => c.id === id);
    if (cl) { cl.name = name; this.save(); }
  }

  delete(id: string): void {
    if (id === CHANGELIST_DEFAULT_ID || id === CHANGELIST_UNVERSIONED_ID) return;
    const cl = this.changelists.find(c => c.id === id);
    if (!cl) return;

    // Move files back to default changelist
    const defaultCl = this.changelists.find(c => c.id === CHANGELIST_DEFAULT_ID)!;
    for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
      if (!defaultCl.fileAssignments[repoId]) defaultCl.fileAssignments[repoId] = [];
      defaultCl.fileAssignments[repoId].push(...paths);
    }

    this.changelists = this.changelists.filter(c => c.id !== id);
    this.save();
  }

  moveFiles(assignments: Array<{ repoId: string; path: string; changelistId: string }>): void {
    // Remove files from all changelists first
    for (const { repoId, path: filePath } of assignments) {
      for (const cl of this.changelists) {
        if (cl.fileAssignments[repoId]) {
          cl.fileAssignments[repoId] = cl.fileAssignments[repoId].filter(p => p !== filePath);
          if (cl.fileAssignments[repoId].length === 0) delete cl.fileAssignments[repoId];
        }
      }
    }
    // Assign to target changelists
    for (const { repoId, path: filePath, changelistId } of assignments) {
      const target = this.changelists.find(c => c.id === changelistId);
      if (!target) continue;
      if (!target.fileAssignments[repoId]) target.fileAssignments[repoId] = [];
      if (!target.fileAssignments[repoId].includes(filePath)) {
        target.fileAssignments[repoId].push(filePath);
      }
    }
    this.save();
  }
}
