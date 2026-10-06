export type TagAction = 'create' | 'push' | 'delete' | 'checkout' | 'merge';
export type TagOutcome = 'success' | 'cancelled' | 'noop' | 'failed' | 'partial';
export interface TagTargetResult {
  repoId: string;
  remote?: string;
  outcome: TagOutcome;
  local?: 'success' | 'failed' | 'partial';
  remoteResult?: 'success' | 'failed' | 'partial';
  error?: string;
}
export interface TagWorkflowResult { outcome: TagOutcome; targets: TagTargetResult[] }
export interface TagWorkflowRequest {
  action: TagAction;
  repoId?: string;
  repoIds?: string[];
  preferredRepoId?: string;
  tagName?: string;
  hash?: string;
  remote?: string;
}
