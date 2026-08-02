import { estimateTokenCount } from './inputTokenBudget';

const OUTPUT_TOKEN_QUANTUM = 256;
const COMMIT_MESSAGE_MIN_OUTPUT_TOKENS = 2_048;
const EXPLANATION_MIN_OUTPUT_TOKENS = 8_192;
const STRUCTURED_MIN_OUTPUT_TOKENS = 8_192;

function normalizeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function roundUpOutputTokens(value: number, minimum: number): number {
  const bounded = Math.max(minimum, Math.ceil(value));
  return Math.ceil(bounded / OUTPUT_TOKEN_QUANTUM) * OUTPUT_TOKEN_QUANTUM;
}

/** Commit messages stay short, while larger diffs receive more reasoning headroom. */
export function calculateCommitMessageOutputTokens(promptText: string): number {
  const inputTokens = estimateTokenCount(promptText);
  return roundUpOutputTokens(
    1_024 + inputTokens * 0.025,
    COMMIT_MESSAGE_MIN_OUTPUT_TOKENS,
  );
}

/** Explanations grow with both source complexity and the number of entities summarized. */
export function calculateCommitExplanationOutputTokens(
  promptText: string,
  commitCount: number,
  fileCount: number,
): number {
  const inputTokens = estimateTokenCount(promptText);
  const estimated = 2_048
    + inputTokens * 0.05
    + normalizeCount(commitCount) * 256
    + normalizeCount(fileCount) * 64;
  return roundUpOutputTokens(estimated, EXPLANATION_MIN_OUTPUT_TOKENS);
}

/** Code review reports need room for evidence, impact, and remediation per finding. */
export function calculateCodeReviewOutputTokens(
  promptText: string,
  fileCount: number,
): number {
  const inputTokens = estimateTokenCount(promptText);
  const estimated = 2_048
    + inputTokens * 0.06
    + normalizeCount(fileCount) * 192;
  return roundUpOutputTokens(estimated, EXPLANATION_MIN_OUTPUT_TOKENS);
}

/** Composer output must carry every unit ID plus messages and rationales for its groups. */
export function calculateComposerOutputTokens(promptText: string, unitIds: string[]): number {
  const inputTokens = estimateTokenCount(promptText);
  const unitIdTokens = estimateTokenCount(unitIds.join('\n'));
  const estimated = 2_048
    + inputTokens * 0.04
    + unitIdTokens
    + unitIds.length * 160;
  return roundUpOutputTokens(estimated, STRUCTURED_MIN_OUTPUT_TOKENS);
}

/** Coverage repair only returns a compact missing-unit-to-group assignment list. */
export function calculateComposerRepairOutputTokens(promptText: string, missingUnitCount: number): number {
  const inputTokens = estimateTokenCount(promptText);
  const estimated = 1_024
    + inputTokens * 0.02
    + normalizeCount(missingUnitCount) * 48;
  return roundUpOutputTokens(estimated, COMMIT_MESSAGE_MIN_OUTPUT_TOKENS);
}

/** JSON repair should reproduce the malformed response without regenerating the full plan. */
export function calculateComposerJsonRepairOutputTokens(promptText: string, responseText: string): number {
  const inputTokens = estimateTokenCount(promptText);
  const responseTokens = estimateTokenCount(responseText);
  const estimated = 1_024
    + inputTokens * 0.02
    + responseTokens * 1.25;
  return roundUpOutputTokens(estimated, COMMIT_MESSAGE_MIN_OUTPUT_TOKENS);
}

export interface MergeOutputCandidate {
  currentText: string;
  baseText: string;
  incomingText: string;
}

/** Conflict output scales with the largest plausible replacement for each block. */
export function calculateMergeOutputTokens(
  promptText: string,
  conflicts: MergeOutputCandidate[],
): number {
  const inputTokens = estimateTokenCount(promptText);
  const expectedResolutionTokens = conflicts.reduce((total, conflict) => total + Math.max(
    estimateTokenCount(conflict.currentText),
    estimateTokenCount(conflict.baseText),
    estimateTokenCount(conflict.incomingText),
  ), 0);
  const estimated = 2_048
    + inputTokens * 0.04
    + expectedResolutionTokens * 1.75
    + conflicts.length * 256;
  return roundUpOutputTokens(estimated, STRUCTURED_MIN_OUTPUT_TOKENS);
}
