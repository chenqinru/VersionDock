import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import { createGitClient } from './GitOperationLock';

export interface GitProfile {
  id: string;
  name: string;
  gitName: string;
  gitEmail: string;
  /** 'local' and 'global' are built-in dynamic profiles — credentials read live from git config */
  builtIn?: 'local' | 'global';
}

export interface EffectiveProfile {
  profile: GitProfile;
  source: 'active' | 'local' | 'global';
}

const PROFILES_KEY = 'versiondock.gitProfiles';
const ACTIVE_KEY = 'versiondock.activeProfileId';

export const LOCAL_PROFILE_ID = '__local__';
export const GLOBAL_PROFILE_ID = '__global__';

export class GitProfileService implements vscode.Disposable {
  private _onProfileChange = new vscode.EventEmitter<void>();
  readonly onProfileChange = this._onProfileChange.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
  ) {}

  // ── Profiles ─────────────────────────────────────────────────────────────────

  getProfiles(): GitProfile[] {
    return this.context.globalState.get<GitProfile[]>(PROFILES_KEY, []);
  }

  async saveProfile(profile: GitProfile): Promise<void> {
    const profiles = this.getProfiles();
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      profiles[idx] = profile;
    } else {
      profiles.push(profile);
    }
    await this.context.globalState.update(PROFILES_KEY, profiles);
    this._onProfileChange.fire();
  }

  async deleteProfile(id: string): Promise<void> {
    if (id === LOCAL_PROFILE_ID || id === GLOBAL_PROFILE_ID) return;
    const profiles = this.getProfiles().filter(p => p.id !== id);
    await this.context.globalState.update(PROFILES_KEY, profiles);
    if (this.getActiveProfileId() === id) {
      await this.context.workspaceState.update(ACTIVE_KEY, '');
    }
    this._onProfileChange.fire();
  }

  // ── Active profile (per-workspace) ───────────────────────────────────────────

  getActiveProfileId(): string {
    const id = this.context.workspaceState.get<string>(ACTIVE_KEY, '');
    this.logger.trace('Identity', 'Read active Git identity selection', { configured: Boolean(id) });
    return id;
  }

  /** Returns the profile pointed to by activeId, or undefined if not set / not found. */
  getActiveProfile(): GitProfile | undefined {
    const id = this.getActiveProfileId();
    if (!id) return undefined;
    if (id === LOCAL_PROFILE_ID) return this.makeLocalPlaceholder();
    if (id === GLOBAL_PROFILE_ID) return this.makeGlobalPlaceholder();
    return this.getProfiles().find(p => p.id === id);
  }

  async setActiveProfile(id: string): Promise<void> {
    const profileKind = id === LOCAL_PROFILE_ID ? 'local' : id === GLOBAL_PROFILE_ID ? 'global' : 'custom';
    this.logger.info('Identity', 'Updating active Git identity selection', { profileKind });
    await this.context.workspaceState.update(ACTIVE_KEY, id);
    const verify = this.context.workspaceState.get<string>(ACTIVE_KEY, '');
    this.logger.debug('Identity', 'Active Git identity selection updated', { persisted: verify === id, profileKind });
    this._onProfileChange.fire();
  }

  async clearActiveProfile(): Promise<void> {
    await this.context.workspaceState.update(ACTIVE_KEY, '');
    this._onProfileChange.fire();
  }

  // ── Built-in Local / Global ───────────────────────────────────────────────────

  private makeLocalPlaceholder(): GitProfile {
    return { id: LOCAL_PROFILE_ID, name: 'Local', gitName: '', gitEmail: '', builtIn: 'local' };
  }

  private makeGlobalPlaceholder(): GitProfile {
    return { id: GLOBAL_PROFILE_ID, name: 'Global', gitName: '', gitEmail: '', builtIn: 'global' };
  }

  async readLocalCreds(repoPath: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
    try {
      const git = createGitClient(repoPath);
      const [name, email] = await Promise.all([
        git.raw(['config', '--local', 'user.name']).catch(() => ''),
        git.raw(['config', '--local', 'user.email']).catch(() => ''),
      ]);
      if (name.trim() || email.trim()) {
        return { gitName: name.trim(), gitEmail: email.trim() };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  async readGlobalCreds(): Promise<{ gitName: string; gitEmail: string } | undefined> {
    try {
      const git = createGitClient(process.cwd());
      const [name, email] = await Promise.all([
        git.raw(['config', '--global', 'user.name']).catch(() => ''),
        git.raw(['config', '--global', 'user.email']).catch(() => ''),
      ]);
      if (name.trim() || email.trim()) {
        return { gitName: name.trim(), gitEmail: email.trim() };
      }
    } catch { /* ignore */ }
    return undefined;
  }

  // ── Effective profile resolution ──────────────────────────────────────────────
  //
  // Priority: active (per-workspace) → local .git/config → global ~/.gitconfig
  // Returns undefined only when nothing is configured anywhere.

  async getEffectiveProfile(repoPath?: string): Promise<EffectiveProfile | undefined> {
    this.logger.trace('Identity', 'Resolving effective Git identity', {
      customProfileCount: this.getProfiles().length,
      repoPath,
    });

    // 1. Explicit active for this workspace
    const activeId = this.getActiveProfileId();
    if (activeId) {
      if (activeId === LOCAL_PROFILE_ID) {
        const creds = repoPath ? await this.readLocalCreds(repoPath) : undefined;
        if (creds) return { profile: { ...this.makeLocalPlaceholder(), ...creds }, source: 'active' };
      } else if (activeId === GLOBAL_PROFILE_ID) {
        const creds = await this.readGlobalCreds();
        if (creds) return { profile: { ...this.makeGlobalPlaceholder(), ...creds }, source: 'active' };
      } else {
        const profile = this.getProfiles().find(p => p.id === activeId);
        this.logger.debug('Identity', 'Resolved custom Git identity selection', { found: Boolean(profile) });
        if (profile) {
          this.logger.debug('Identity', 'Using active custom Git identity');
          return { profile, source: 'active' };
        }
      }
      // Active id is stale (profile was deleted) — fall through
      this.logger.warn('Identity', 'Active Git identity selection is stale; falling back to Git configuration');
    }

    // 2. Local .git/config
    const local = repoPath ? await this.readLocalCreds(repoPath) : undefined;
    if (local) return { profile: { ...this.makeLocalPlaceholder(), ...local }, source: 'local' };

    // 3. Global ~/.gitconfig
    const global = await this.readGlobalCreds();
    if (global) return { profile: { ...this.makeGlobalPlaceholder(), ...global }, source: 'global' };

    return undefined;
  }

  dispose(): void {
    this._onProfileChange.dispose();
  }
}
