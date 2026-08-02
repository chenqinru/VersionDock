import type * as vscode from 'vscode';
import type { AiProvider } from '../ai/types';

export type CodeReviewVerdict = 'pass' | 'warning' | 'block';
export type CodeReviewSeverity = 'critical' | 'high' | 'medium' | 'low';
export type CodeReviewPromptSource = 'workspace' | 'global' | 'builtin';
export type CodeReviewDiffSource = 'staged' | 'working';

export interface CodeReviewCandidate {
  repoId: string;
  paths: string[];
  stagedOnly: boolean;
}

export interface CodeReviewAnchor {
  id: string;
  repoId: string;
  repoName: string;
  filePath: string;
  source: CodeReviewDiffSource;
  oldLine?: number;
  newLine?: number;
  fingerprint: string;
}

export interface CodeReviewFinding {
  id: string;
  severity: CodeReviewSeverity;
  title: string;
  anchorId: string;
  repoId: string;
  repoName: string;
  filePath: string;
  source: CodeReviewDiffSource;
  oldLine?: number;
  newLine?: number;
  evidence: string;
  impact: string;
  suggestion: string;
}

export interface CodeReviewReport {
  verdict: CodeReviewVerdict;
  summary: string;
  findings: CodeReviewFinding[];
}

export interface CodeReviewContext {
  text: string;
  repoRootPaths: string[];
  vcsKinds: Array<'git' | 'svn'>;
  repositoryCount: number;
  fileCount: number;
  contextCharCount: number;
  truncated: boolean;
  anchors: Map<string, CodeReviewAnchor>;
}

export interface CodeReviewGenerateResult {
  report: CodeReviewReport;
  provider: AiProvider;
  model?: string;
  promptSource: CodeReviewPromptSource;
  inputTruncated: boolean;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
}

export interface CodeReviewGenerateOptions {
  context: CodeReviewContext;
  cancellationToken: vscode.CancellationToken;
  onDelta: (delta: string) => void;
}
