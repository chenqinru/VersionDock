// Webview-side message type aliases (mirrors src/host/types/messages.ts)
// These are re-exported for convenience — Vite bundles them with type erasure.
export type { HostToCommitMsg, CommitToHostMsg, HostToLogMsg, LogToHostMsg, HostToMergeMsg, MergeToHostMsg, HostToComposerMsg, ComposerToHostMsg, HostToCodeReviewMsg, CodeReviewToHostMsg, CodeReviewPhase, ShelveEntry, StashEntry, UnpushedCommit, PushCommitFile, IncomingCommit, SyncPullStrategy, SubtreeEntry, SubtreeOp, SubtreePushStatus, RepoSubmodules, SubmoduleItem, SubmoduleSyncStatus } from '../../host/types/messages';
export type { ComposerPreparedSource, ComposerCommitGroup, ComposerChangeUnit, ComposerApplyResult } from '../../host/aiCommitComposer/types';
export type { CodeReviewFinding, CodeReviewReport, CodeReviewSeverity, CodeReviewVerdict } from '../../host/aiCodeReview/types';
export type { WorktreeEntry } from '../../host/git/WorkspaceGitManager';
