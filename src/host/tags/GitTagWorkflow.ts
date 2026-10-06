import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { RepoMeta } from '../types/git';
import { t } from '../utils/l10n';

import type { TagOutcome, TagTargetResult, TagWorkflowRequest, TagWorkflowResult } from '../types/tags';
type Target = {
  meta: RepoMeta; repo: GitService; remote?: string; commit?: string; blocked?: string;
};
const workflows = new WeakMap<WorkspaceGitManager, GitTagWorkflow>();

export function getGitTagWorkflow(manager: WorkspaceGitManager): GitTagWorkflow {
  let workflow = workflows.get(manager);
  if (!workflow) { workflow = new GitTagWorkflow(manager); workflows.set(manager, workflow); }
  return workflow;
}

/** Shared interactive policy; GitService owns commands and repository write locks. */
export class GitTagWorkflow {
  private active = false;
  private readonly listeners = new Set<(busy: boolean, repoIds: string[]) => void>();
  constructor(private readonly manager: WorkspaceGitManager) {}
  get busy(): boolean { return this.active; }
  onChange(listener: (busy: boolean, repoIds: string[]) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }
  private emit(repoIds: string[] = []): void { this.listeners.forEach(listener => listener(this.active, repoIds)); }

  private async chooseTargets(request: TagWorkflowRequest): Promise<Target[] | undefined> {
    const metas = this.manager.getRepoMetas().filter(meta => meta.kind !== 'svn'
      && (request.repoId ? meta.id === request.repoId : !request.repoIds || request.repoIds.includes(meta.id)));
    if (!metas.length) throw new Error(t('No Git repositories available.'));
    let selected = metas;
    if (!request.repoId && metas.length > 1) {
      const items = metas.map(meta => ({ label: meta.name, description: meta.rootPath, meta, picked: meta.id === request.preferredRepoId }));
      if (request.action === 'create') {
        const pick = await vscode.window.showQuickPick([...items].sort((a, b) => Number(b.picked) - Number(a.picked)), { title: t('Select repository for tag operation') });
        if (!pick) return;
        selected = [pick.meta];
      } else {
        const picks = await vscode.window.showQuickPick(items, { canPickMany: true, title: t('Select repositories for tag operation') });
        if (!picks?.length) return;
        selected = picks.map(pick => pick.meta);
      }
    }
    return selected.map(meta => {
      const repo = this.manager.getRepo(meta.id);
      if (!repo || repo.kind === 'svn') throw new Error(t('Repository no longer available: {0}', meta.name));
      return { meta, repo };
    });
  }

  private async chooseRemote(target: Target, preferred?: string): Promise<string | undefined> {
    const remotes = await target.repo.getRemotes();
    if (!remotes.length) {
      const choice = await vscode.window.showWarningMessage(t('VersionDock [{0}]: No remotes configured.', target.meta.name), t('Manage Remotes…'));
      if (choice) await vscode.commands.executeCommand('versiondock.manageTagRemotes', target.meta.id);
      throw new Error(t('No remotes configured.'));
    }
    if (preferred) {
      if (!remotes.includes(preferred)) throw new Error(t('Remote not found: {0}', preferred));
      return preferred;
    }
    if (remotes.length === 1) return remotes[0];
    return vscode.window.showQuickPick(remotes, { title: t('Select remote for {0}', target.meta.name) });
  }

  async run(request: TagWorkflowRequest): Promise<TagWorkflowResult> {
    if (this.active) {
      await vscode.window.showInformationMessage(t('A tag operation is already in progress.'));
      return { outcome: 'cancelled', targets: [] };
    }
    this.active = true;
    this.emit();
    let targets: Target[] = [];
    let tagName = request.tagName;
    let deletion: 'local' | 'remote' | 'both' | undefined;
    let message: string | undefined;
    const results: TagTargetResult[] = [];
    const touched = new Set<string>();
    const cancelled = (): TagWorkflowResult => ({ outcome: 'cancelled', targets: [] });
    try {
      if (!['create', 'push', 'delete', 'checkout', 'merge'].includes(request.action)) {
        throw new Error(t('Unsupported tag operation: {0}', request.action));
      }
      const chosen = await this.chooseTargets(request);
      if (!chosen) return cancelled();
      targets = chosen;
      if (request.action === 'create') {
        const target = targets[0];
        let ref = request.hash;
        if (!ref) {
          try { await target.repo.resolveTagCommit('HEAD'); }
          catch { throw new Error(t('Create a commit before creating a tag.')); }
          const input = await vscode.window.showInputBox({
            title: t('Commit for tag in {0}', target.meta.name),
            prompt: t('Commit reference (leave empty for HEAD)'),
            value: 'HEAD',
            placeHolder: 'HEAD, main~2, abc1234',
            validateInput: async value => {
              try { await target.repo.resolveTagCommit(value.trim() || 'HEAD'); return undefined; }
              catch { return t('Commit reference cannot be resolved to a commit.'); }
            },
          });
          if (input === undefined) return cancelled();
          ref = input.trim() || 'HEAD';
        }
        target.commit = await target.repo.resolveTagCommit(ref);
        tagName = await vscode.window.showInputBox({ title: t('New Tag in {0}', target.meta.name),
          prompt: t('Tag name for commit {0}', target.commit.slice(0, 7)), placeHolder: 'v1.0.0',
          validateInput: async value => { try { await target.repo.validateTagName(value.trim()); return undefined; } catch (error: unknown) { return String(error); } },
        });
        if (!tagName) return cancelled();
        tagName = tagName.trim();
        const description = await vscode.window.showInputBox({
          title: t('Tag description'),
          prompt: t('Leave empty for a lightweight tag; enter a message for an annotated tag.'),
        });
        if (description === undefined) return cancelled();
        message = description.trim() ? description : undefined;
      }
      if (request.action === 'delete') {
        const pick = await vscode.window.showQuickPick([
          { label: t('Delete Local'), value: 'local' as const },
          { label: t('Delete on Remote'), value: 'remote' as const },
          { label: t('Delete Local and Remote'), value: 'both' as const },
        ], { title: t('Delete tag "{0}"', tagName ?? '') });
        if (!pick) return cancelled();
        deletion = pick.value;
      }
      // Complete all interaction and preflight before the first write in any repository.
      for (const target of targets) {
        try {
          if (request.action === 'push' || (deletion && deletion !== 'local')) {
            target.remote = await this.chooseRemote(target, request.remote);
            if (!target.remote) return cancelled();
          }
          if (tagName && ['push', 'checkout', 'merge'].includes(request.action)) {
            target.commit = await target.repo.resolveTagCommit(`refs/tags/${tagName}`);
          }
          if (request.action === 'merge' || (request.action === 'delete' && deletion !== 'remote')) {
            const current = await target.repo.getCurrentBranch();
            if (request.action === 'merge' && (current.detachedTag || current.detachedHash || current.name === 'HEAD')) {
              throw new Error(t('Create or checkout a branch before merging a tag.'));
            }
            if (request.action === 'delete' && current.detachedTag === tagName) throw new Error(t('Cannot delete the currently checked out tag locally.'));
            if (request.action === 'delete' && !(await target.repo.getTags()).some(tag => tag.name === tagName)) {
              throw new Error(t('Local tag not found: {0}', tagName ?? ''));
            }
          }
        } catch (error: unknown) { target.blocked = String(error); }
      }
      const preview = targets.map(target => `${target.meta.name}${target.remote ? ` → ${target.remote}` : ''}${target.blocked ? `: ${target.blocked}` : ''}`).join('\n');
      if (targets.some(target => target.blocked)) {
        await vscode.window.showWarningMessage(t('Tag operation cannot start. Adjust the targets and retry.\n{0}', preview), { modal: true });
        return { outcome: 'failed', targets: targets.map(target => ({ repoId: target.meta.id, outcome: target.blocked ? 'failed' : 'noop', error: target.blocked })) };
      }
      if (['delete', 'checkout', 'merge'].includes(request.action)) {
        const detail = request.action === 'checkout' ? t('Checkout enters detached HEAD.') : request.action === 'merge'
          ? (await Promise.all(targets.map(async target => `${target.meta.name}: ${(await target.repo.getCurrentBranch()).name}`))).join('\n')
          : deletion ? t(deletion === 'local' ? 'Delete Local' : deletion === 'remote' ? 'Delete on Remote' : 'Delete Local and Remote') : '';
        const confirm = await vscode.window.showWarningMessage(t('Confirm tag operation: {0}\n{1}\n{2}', tagName ?? '', preview, detail), { modal: true }, t('Continue'));
        if (!confirm) return cancelled();
      }
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Git tag operation…'), cancellable: false }, async progress => {
        for (const target of targets) {
          const result: TagTargetResult = { repoId: target.meta.id, remote: target.remote, outcome: 'success' };
          progress.report({ message: target.meta.name });
          try {
            // Revalidate ownership after asynchronous prompts.
            if (this.manager.getRepo(target.meta.id) !== target.repo || target.repo.kind === 'svn') throw new Error(t('Repository no longer available: {0}', target.meta.name));
            if (target.remote && !(await target.repo.getRemotes()).includes(target.remote)) throw new Error(t('Remote not found: {0}', target.remote));
            touched.add(target.meta.id);
            switch (request.action) {
              case 'create': await target.repo.createTag(tagName!, target.commit!, message); result.local = 'success'; break;
              case 'push': await target.repo.pushTag(tagName!, target.remote!); result.remoteResult = 'success'; break;
              case 'checkout': await target.repo.checkoutTag(tagName!); break;
              case 'merge': await target.repo.mergeTag(tagName!); break;
              case 'delete':
                if (deletion !== 'remote' && (await target.repo.getCurrentBranch()).detachedTag === tagName) throw new Error(t('Cannot delete the currently checked out tag locally.'));
                if (deletion !== 'local') { await target.repo.deleteTagRemote(tagName!, target.remote!); result.remoteResult = 'success'; }
                if (deletion !== 'remote') { await target.repo.deleteTag(tagName!); result.local = 'success'; }
                break;
            }
          } catch (error: unknown) {
            result.outcome = result.local === 'success' || result.remoteResult === 'success' ? 'partial' : 'failed';
            result.error = String(error);
            if (request.action === 'delete') {
              if (deletion !== 'local' && result.remoteResult !== 'success') result.remoteResult = 'failed';
              else if (deletion !== 'remote') result.local = 'failed';
            }
          }
          results.push(result);
        }
      });
      const failed = results.filter(result => result.outcome === 'failed' || result.outcome === 'partial');
      const succeeded = results.filter(result => result.outcome === 'success');
      const outcome: TagOutcome = failed.length ? (succeeded.length || failed.some(result => result.outcome === 'partial') ? 'partial' : 'failed')
        : succeeded.length ? 'success' : 'noop';
      if (failed.length) {
        const detail = results.map(result => `${this.manager.getRepoMeta(result.repoId)?.name ?? result.repoId}${result.remote ? ` → ${result.remote}` : ''}: ${t(result.outcome)}${result.remoteResult ? `; ${t('Remote')}: ${t(result.remoteResult)}` : ''}${result.local ? `; ${t('Local')}: ${t(result.local)}` : ''}${result.error ? `; ${result.error}` : ''}`).join('\n');
        await vscode.window.showWarningMessage(t('Tag operation result: {0}\n{1}', t(outcome), detail), { modal: true });
      } else if (request.action !== 'create') {
        const detail = results.map(result => `${this.manager.getRepoMeta(result.repoId)?.name ?? result.repoId}${result.remote ? ` → ${result.remote}` : ''}: ${t(result.outcome)}`).join('; ');
        void vscode.window.showInformationMessage(t('Tag operation result: {0}\n{1}', t(outcome), detail));
      }
      if (request.action === 'create' && outcome === 'success') {
        // Optional publishing must not hold the operation guard while a notification is ignored.
        void vscode.window.showInformationMessage(t('Tag "{0}" created locally.', tagName!), t('Push this tag')).then(pick => {
          if (pick) return this.run({ action: 'push', repoId: targets[0].meta.id, tagName });
        });
      }
      return { outcome, targets: results };
    } catch (error: unknown) {
      await vscode.window.showErrorMessage(t('Tag operation failed: {0}', String(error)));
      return { outcome: 'failed', targets: results.length ? results : targets.map(target => ({ repoId: target.meta.id, outcome: 'failed', error: String(error) })) };
    } finally {
      if (touched.size) this.manager.notifyBranchesChanged();
      this.active = false;
      this.emit([...touched]);
    }
  }
}
