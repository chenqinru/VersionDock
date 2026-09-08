import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { RepoMeta } from '../types/git';
import { t } from './l10n';
import { formatRepoLabel } from './repoLabels';

export type AbortOperationState = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export type AbortOperationTarget = {
  meta: RepoMeta;
  state: AbortOperationState;
};

export type AbortOperationResult =
  | { ok: true; target: AbortOperationTarget }
  | { ok: false; cancelled: true }
  | { ok: false; error: string };

export function getAbortOperationLabel(targets: AbortOperationTarget[]): string {
  const states = getTargetStates(targets);
  if (targets.length > 1) return getAbortOperationSelectTitle(states);
  if (states.has('merge')) return t('Abort Merge');
  if (states.has('rebase')) return t('Abort Rebase');
  if (states.has('cherry-pick')) return t('Abort Cherry-pick');
  return t('Abort Revert');
}

export function getAbortOperationDescription(targets: AbortOperationTarget[]): string {
  const states = getTargetStates(targets);
  if (targets.length > 1) return getAbortOperationSelectPlaceholder(states);
  if (targets[0]?.meta.kind === 'svn' && states.has('merge')) return t('SVN conflicts detected — revert conflicted files');
  if (states.has('merge')) return t('Merge in progress — abort and restore previous state');
  if (states.has('rebase')) return t('Rebase in progress — abort and restore previous state');
  if (states.has('cherry-pick')) return t('Cherry-pick in progress — abort and restore previous state');
  return t('Revert in progress — abort and restore previous state');
}

export function getAbortOperationName(state: AbortOperationState): string {
  if (state === 'merge') return t('merge');
  if (state === 'rebase') return t('rebase');
  if (state === 'cherry-pick') return t('cherry-pick');
  return t('revert');
}

export async function collectAbortOperationTargets(
  manager: WorkspaceGitManager,
  repoIds?: string[],
  allowedStates: AbortOperationState[] = ['merge', 'rebase', 'cherry-pick', 'revert'],
): Promise<AbortOperationTarget[]> {
  const metas = manager.getRepoMetas();
  const metaById = new Map(metas.map(meta => [meta.id, meta]));
  const ids = repoIds ? [...new Set(repoIds)] : metas.map(meta => meta.id);
  const allowed = new Set(allowedStates);
  const targets: AbortOperationTarget[] = [];

  for (const repoId of ids) {
    const meta = metaById.get(repoId);
    const repo = manager.getRepo(repoId);
    if (!meta || !repo) continue;
    const state = await repo.getMergeRebaseState();
    if (!state || !allowed.has(state)) continue;
    targets.push({ meta, state });
  }

  return targets;
}

export async function runAbortOperationFlow(
  manager: WorkspaceGitManager,
  targets: AbortOperationTarget[],
): Promise<AbortOperationResult> {
  const target = await pickAbortOperationTarget(targets);
  if (!target) return { ok: false, cancelled: true };

  const confirmed = await confirmAbortOperation(target);
  if (!confirmed) return { ok: false, cancelled: true };

  const repo = manager.getRepo(target.meta.id);
  if (!repo) return { ok: false, error: t('Repo not found') };

  try {
    if (target.state === 'merge') {
      await repo.abortMerge();
    } else if (target.state === 'rebase') {
      await repo.abortRebase();
    } else if (target.state === 'cherry-pick' && 'cherryPickAbort' in repo) {
      await (repo as { cherryPickAbort(): Promise<void> }).cherryPickAbort();
    } else if (target.state === 'revert' && 'revertAbort' in repo) {
      await (repo as { revertAbort(): Promise<void> }).revertAbort();
    }
    return { ok: true, target };
  } catch (error: unknown) {
    return { ok: false, error: String(error) };
  }
}

function getTargetStates(targets: AbortOperationTarget[]): Set<AbortOperationState> {
  return new Set(targets.map(target => target.state));
}

function getAbortOperationSelectTitle(states: Set<AbortOperationState>): string {
  if (states.size > 1) return t('Abort Merge/Rebase — Select repository');
  return states.has('merge')
    ? t('Abort Merge — Select repository')
    : states.has('rebase')
    ? t('Abort Rebase — Select repository')
    : states.has('cherry-pick')
    ? t('Abort Cherry-pick — Select repository')
    : t('Abort Revert — Select repository');
}

function getAbortOperationSelectPlaceholder(states: Set<AbortOperationState>): string {
  if (states.size > 1) return t('Select the repository whose {0} should be aborted', t('merge/rebase'));
  return states.has('merge')
    ? t('Select the repository whose merge should be aborted')
    : states.has('rebase')
    ? t('Select the repository whose rebase should be aborted')
    : states.has('cherry-pick')
    ? t('Select the repository whose cherry-pick should be aborted')
    : t('Select the repository whose revert should be aborted');
}

async function pickAbortOperationTarget(targets: AbortOperationTarget[]): Promise<AbortOperationTarget | undefined> {
  if (targets.length <= 1) return targets[0];

  type AbortPickItem = vscode.QuickPickItem & { target: AbortOperationTarget };
  const states = getTargetStates(targets);
  const picks: AbortPickItem[] = targets.map(target => ({
    label: formatRepoLabel(target.meta, '$(root-folder)'),
    description: getAbortOperationName(target.state),
    detail: target.meta.rootPath,
    target,
  }));
  const pick = await vscode.window.showQuickPick(picks, {
    title: getAbortOperationSelectTitle(states),
    placeHolder: getAbortOperationSelectPlaceholder(states),
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return pick?.target;
}

async function confirmAbortOperation(target: AbortOperationTarget): Promise<boolean> {
  const action = target.state === 'merge'
    ? t('Abort Merge')
    : target.state === 'rebase'
    ? t('Abort Rebase')
    : target.state === 'cherry-pick'
    ? t('Abort Cherry-pick')
    : t('Abort Revert');
  const message = target.meta.kind === 'svn' && target.state === 'merge'
    ? t('VersionDock [{0}]: Abort SVN merge? This will revert conflicted SVN files and keep other local changes.', target.meta.name)
    : target.state === 'merge'
    ? t('VersionDock [{0}]: Abort merge? This will restore the repository to its pre-merge state.', target.meta.name)
    : t('VersionDock [{0}]: Abort {1}? This will restore the repository to its previous state.', target.meta.name, getAbortOperationName(target.state));
  const confirmed = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return confirmed === action;
}
