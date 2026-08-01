const INPUT_TOKEN_RESERVE_MAX = 512;
const INPUT_TOKEN_RESERVE_MIN = 64;
const CONTEXT_INSTRUCTION_RESERVE_MAX = 8_192;
const CONTEXT_INSTRUCTION_RESERVE_MIN = 2_048;

function countNonAsciiTokens(value: string): number {
  return Array.from(value).reduce(
    (total, character) => total + ((character.codePointAt(0) ?? 0) > 0xffff ? 2 : 1),
    0,
  );
}

function isAscii(value: string): boolean {
  return Array.from(value).every(character => (character.codePointAt(0) ?? 0) <= 0x7f);
}

/**
 * Conservatively estimates tokens for providers that do not expose a token
 * counting API. Word-like ASCII runs are commonly packed into several
 * characters per token, while punctuation and non-ASCII text are counted more
 * strictly because source code and CJK text tokenize more densely.
 */
export function estimateTokenCount(value: string): number {
  if (!value) return 0;
  const segments = value.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]+/gu) ?? [];
  let tokens = 0;
  for (const segment of segments) {
    if (/^[A-Za-z0-9_]+$/.test(segment)) {
      tokens += Math.ceil(segment.length / 3);
    } else if (/^\s+$/.test(segment)) {
      tokens += Math.ceil(segment.length / 4);
    } else if (isAscii(segment)) {
      tokens += Math.ceil(segment.length / 2);
    } else {
      tokens += countNonAsciiTokens(segment);
    }
  }
  return tokens;
}

export function getInputTokenBudget(maxInputTokens: number): number {
  const reserve = Math.min(
    INPUT_TOKEN_RESERVE_MAX,
    Math.max(INPUT_TOKEN_RESERVE_MIN, Math.floor(maxInputTokens * 0.05)),
  );
  return Math.max(1, maxInputTokens - reserve);
}

/** Leaves room for the active system prompt and the request wrapper. */
export function getContextTokenBudget(maxInputTokens: number): number {
  const inputBudget = getInputTokenBudget(maxInputTokens);
  const instructionReserve = Math.min(
    CONTEXT_INSTRUCTION_RESERVE_MAX,
    Math.max(CONTEXT_INSTRUCTION_RESERVE_MIN, Math.floor(maxInputTokens * 0.05)),
  );
  return Math.max(1, inputBudget - instructionReserve);
}

export function truncateToTokenBudget(value: string, tokenBudget: number, suffix = '\n...'): string {
  if (estimateTokenCount(value) <= tokenBudget) return value;
  const suffixTokens = estimateTokenCount(suffix);
  const fittedSuffix = suffixTokens <= tokenBudget ? suffix : '';
  const contentBudget = Math.max(0, tokenBudget - estimateTokenCount(fittedSuffix));
  let low = 0;
  let high = value.length;
  let fittedLength = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTokenCount(value.slice(0, middle)) <= contentBudget) {
      fittedLength = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  const lineBoundary = value.lastIndexOf('\n', fittedLength);
  const end = lineBoundary > 0 ? lineBoundary : fittedLength;
  return `${value.slice(0, end)}${fittedSuffix}`;
}

export function splitTextByTokenBudget(value: string, tokenBudget: number): string[] {
  if (!value) return [''];
  const safeBudget = Math.max(1, tokenBudget);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let low = offset + 1;
    let high = value.length;
    let fittedEnd = offset + 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (estimateTokenCount(value.slice(offset, middle)) <= safeBudget) {
        fittedEnd = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (fittedEnd < value.length) {
      const lastCodeUnit = value.charCodeAt(fittedEnd - 1);
      const nextCodeUnit = value.charCodeAt(fittedEnd);
      if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        fittedEnd--;
      }
    }
    if (fittedEnd <= offset) fittedEnd = Math.min(value.length, offset + 1);
    chunks.push(value.slice(offset, fittedEnd));
    offset = fittedEnd;
  }
  return chunks;
}

export function splitLinesByTokenBudget(lines: string[], tokenBudget: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (!current.length) return;
    chunks.push(current);
    current = [];
    currentTokens = 0;
  };

  for (const line of lines) {
    const lineParts = splitTextByTokenBudget(line, tokenBudget);
    for (const part of lineParts) {
      const partTokens = estimateTokenCount(part) + (current.length > 0 ? estimateTokenCount('\n') : 0);
      if (current.length > 0 && currentTokens + partTokens > tokenBudget) flush();
      current.push(part);
      currentTokens += estimateTokenCount(part) + (current.length > 1 ? estimateTokenCount('\n') : 0);
    }
  }
  flush();
  return chunks;
}

export class TokenBudgetTextBuilder {
  private readonly lines: string[] = [];
  private usedTokens = 0;
  private didTruncate = false;

  constructor(readonly tokenBudget: number) {}

  append(line: string): boolean {
    if (this.didTruncate) return false;
    const separator = this.lines.length > 0 ? '\n' : '';
    const next = `${separator}${line}`;
    const nextTokens = estimateTokenCount(next);
    if (this.usedTokens + nextTokens <= this.tokenBudget) {
      this.lines.push(line);
      this.usedTokens += nextTokens;
      return true;
    }

    const remaining = this.tokenBudget - this.usedTokens - estimateTokenCount(separator);
    if (remaining > estimateTokenCount('\n...')) {
      this.lines.push(truncateToTokenBudget(line, remaining));
      this.usedTokens = this.tokenBudget;
    }
    this.didTruncate = true;
    return false;
  }

  get truncated(): boolean {
    return this.didTruncate;
  }

  get tokenCount(): number {
    return this.usedTokens;
  }

  toString(): string {
    return this.lines.join('\n');
  }
}
