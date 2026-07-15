import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { RepoMeta } from '../types/git';
import { t } from './l10n';
import { formatRepoLabel } from './repoLabels';

export type AbortOperationState = 'merge' | 'rebase';

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
  return states.has('merge') ? t('Abort Merge') : t('Abort Rebase');
}

export function getAbortOperationDescription(targets: AbortOperationTarget[]): string {
  const states = getTargetStates(targets);
  if (targets.length > 1) return getAbortOperationSelectPlaceholder(states);
  if (targets[0]?.meta.kind === 'svn' && states.has('merge')) return t('SVN conflicts detected — revert conflicted files');
  return states.has('merge')
    ? t('Merge in progress — abort and restore previous state')
    : t('Rebase in progress — abort and restore previous state');
}

export function getAbortOperationName(state: AbortOperationState): string {
  return state === 'merge' ? t('merge') : t('rebase');
}

export async function collectAbortOperationTargets(
  manager: WorkspaceGitManager,
  repoIds?: string[],
  allowedStates: AbortOperationState[] = ['merge', 'rebase'],
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
    } else {
      await repo.abortRebase();
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
    : t('Abort Rebase — Select repository');
}

function getAbortOperationSelectPlaceholder(states: Set<AbortOperationState>): string {
  if (states.size > 1) return t('Select the repository whose {0} should be aborted', t('merge/rebase'));
  return states.has('merge')
    ? t('Select the repository whose merge should be aborted')
    : t('Select the repository whose rebase should be aborted');
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
  const action = target.state === 'merge' ? t('Abort Merge') : t('Abort Rebase');
  const message = target.meta.kind === 'svn' && target.state === 'merge'
    ? t('Abort SVN merge in {0}? This will revert conflicted SVN files and keep other local changes.', target.meta.name)
    : target.state === 'merge'
    ? t('Abort merge in {0}? This will restore the repository to its pre-merge state.', target.meta.name)
    : t('Abort {0} in {1}? This will restore the repository to its previous state.', getAbortOperationName(target.state), target.meta.name);
  const confirmed = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return confirmed === action;
}
