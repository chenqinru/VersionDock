// Webview-side message type aliases (mirrors src/host/types/messages.ts)
// These are re-exported for convenience — Vite bundles them with type erasure.
export type { HostToCommitMsg, CommitToHostMsg, HostToLogMsg, LogToHostMsg, HostToMergeMsg, MergeToHostMsg, HostToComposerMsg, ComposerToHostMsg, ShelveEntry, StashEntry, UnpushedCommit, PushCommitFile, SubtreeEntry, SubtreeOp, SubtreePushStatus } from '../../host/types/messages';
export type { ComposerPreparedSource, ComposerCommitGroup, ComposerChangeUnit, ComposerApplyResult } from '../../host/aiCommitComposer/types';
export type { WorktreeEntry } from '../../host/git/WorkspaceGitManager';
