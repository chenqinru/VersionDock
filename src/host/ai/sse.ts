import { TextDecoder } from 'util';

export interface StreamParseResult {
  text: string;
  streamed: boolean;
  finishReason?: string;
  outputTokenCount?: number;
  reasoningTokenCount?: number;
}

interface ResponseMetadata {
  finishReason?: string;
  outputTokenCount?: number;
  reasoningTokenCount?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function extractResponseMetadata(payload: unknown): ResponseMetadata {
  if (!payload || typeof payload !== 'object') return {};
  const outer = payload as Record<string, unknown>;
  const value = (asRecord(outer.response) ?? outer) as {
    choices?: Array<{ finish_reason?: unknown }>;
    finish_reason?: unknown;
    stop_reason?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown };
    delta?: { stop_reason?: unknown };
    usage?: {
      completion_tokens?: unknown;
      output_tokens?: unknown;
      completion_tokens_details?: { reasoning_tokens?: unknown };
      output_tokens_details?: { reasoning_tokens?: unknown };
    };
    message?: {
      usage?: {
        completion_tokens?: unknown;
        output_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
        output_tokens_details?: { reasoning_tokens?: unknown };
      };
    };
  };
  const finishReasonCandidate = value.choices?.[0]?.finish_reason
    ?? value.finish_reason
    ?? value.stop_reason
    ?? value.delta?.stop_reason
    ?? value.incomplete_details?.reason
    ?? value.status;
  const usage = value.usage ?? value.message?.usage;
  return {
    finishReason: typeof finishReasonCandidate === 'string' ? finishReasonCandidate : undefined,
    outputTokenCount: asTokenCount(usage?.completion_tokens ?? usage?.output_tokens),
    reasoningTokenCount: asTokenCount(
      usage?.completion_tokens_details?.reasoning_tokens
      ?? usage?.output_tokens_details?.reasoning_tokens,
    ),
  };
}

function extractStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as {
    choices?: Array<{ delta?: { content?: unknown } }>;
    type?: unknown;
    delta?: { text?: unknown } | string;
  };
  if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') return value.delta;
  const openAiContent = value.choices?.[0]?.delta?.content;
  if (typeof openAiContent === 'string') return openAiContent;
  if (Array.isArray(openAiContent)) {
    return openAiContent.map(part => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object' || !('text' in part)) return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }).join('');
  }
  return typeof value.delta === 'object' && typeof value.delta?.text === 'string' ? value.delta.text : '';
}

function extractCompleteMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const outer = payload as Record<string, unknown>;
  const value = (asRecord(outer.response) ?? outer) as {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ text?: unknown }>;
    output?: Array<{ type?: unknown; content?: Array<{ type?: unknown; text?: unknown }> }>;
    output_text?: unknown;
    type?: unknown;
    text?: unknown;
  };
  if (value.type === 'response.output_text.done' && typeof value.text === 'string') return value.text;
  const openAiContent = value.choices?.[0]?.message?.content;
  if (typeof openAiContent === 'string') return openAiContent;
  if (Array.isArray(openAiContent)) {
    return openAiContent.map(part => {
      if (!part || typeof part !== 'object' || !('text' in part)) return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    }).join('');
  }
  const claudeContent = value.content?.[0]?.text;
  if (typeof claudeContent === 'string') return claudeContent;
  const responsesContent = value.output
    ?.filter(item => item?.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => String(part.text))
    .join('');
  if (responsesContent) return responsesContent;
  return typeof value.output_text === 'string' ? value.output_text : '';
}

export async function parseStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<StreamParseResult> {
  if (!response.body) {
    const payload = await response.json() as unknown;
    return { text: extractCompleteMessage(payload), streamed: false, ...extractResponseMetadata(payload) };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawResponse = '';
  let fullText = '';
  let streamed = false;
  let completed = false;
  let finishReason: string | undefined;
  let outputTokenCount: number | undefined;
  let reasoningTokenCount: number | undefined;
  let streamError: string | undefined;

  const consumeBlock = (block: string): void => {
    const data = block
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) return;
    if (data === '[DONE]') {
      completed = true;
      return;
    }

    try {
      const payload = JSON.parse(data) as unknown;
      const metadata = extractResponseMetadata(payload);
      if (metadata.finishReason !== undefined) finishReason = metadata.finishReason;
      if (metadata.outputTokenCount !== undefined) outputTokenCount = metadata.outputTokenCount;
      if (metadata.reasoningTokenCount !== undefined) reasoningTokenCount = metadata.reasoningTokenCount;
      const delta = extractStreamDelta(payload);
      if (delta) {
        streamed = true;
        fullText += delta;
        onDelta(delta);
      } else if (!fullText) {
        fullText = extractCompleteMessage(payload);
      }
      const record = asRecord(payload);
      if (record?.type === 'error') {
        const error = asRecord(record.error);
        streamError = typeof error?.message === 'string'
          ? error.message
          : typeof record.message === 'string'
            ? record.message
            : 'Unknown streaming error';
      }
      if (record?.type === 'response.failed') {
        const response = asRecord(record.response);
        const error = asRecord(response?.error);
        streamError = typeof error?.message === 'string' ? error.message : 'Response generation failed';
        completed = true;
      } else if (record?.type === 'response.completed' || record?.type === 'response.incomplete') {
        completed = true;
      }
    } catch {
      // Ignore malformed keep-alive or vendor-specific events.
    }
  };

  while (!completed) {
    const { value, done } = await reader.read();
    const decoded = decoder.decode(value ?? new Uint8Array(), { stream: !done });
    rawResponse += decoded;
    buffer += decoded;

    let separator = /\r?\n\r?\n/.exec(buffer);
    while (separator) {
      const block = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator[0].length);
      consumeBlock(block);
      if (completed) break;
      separator = /\r?\n\r?\n/.exec(buffer);
    }
    if (done) break;
  }

  if (completed) await reader.cancel().catch(() => undefined);
  if (!completed && buffer.trim()) consumeBlock(buffer);
  if (streamError) throw new Error(streamError);
  if (fullText) return {
    text: fullText,
    streamed,
    finishReason,
    outputTokenCount,
    reasoningTokenCount,
  };

  try {
    const payload = JSON.parse(rawResponse) as unknown;
    return { text: extractCompleteMessage(payload), streamed: false, ...extractResponseMetadata(payload) };
  } catch {
    return { text: '', streamed: false, finishReason, outputTokenCount, reasoningTokenCount };
  }
}
