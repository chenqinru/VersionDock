import { TextDecoder } from 'util';

export interface StreamParseResult {
  text: string;
  streamed: boolean;
}

function extractStreamDelta(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as {
    choices?: Array<{ delta?: { content?: unknown } }>;
    delta?: { text?: unknown };
  };
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
  return typeof value.delta?.text === 'string' ? value.delta.text : '';
}

function extractCompleteMessage(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const value = payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ text?: unknown }>;
    output_text?: unknown;
  };
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
  return typeof value.output_text === 'string' ? value.output_text : '';
}

export async function parseStreamingResponse(
  response: Response,
  onDelta: (delta: string) => void,
): Promise<StreamParseResult> {
  if (!response.body) {
    const payload = await response.json() as unknown;
    return { text: extractCompleteMessage(payload), streamed: false };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let rawResponse = '';
  let fullText = '';
  let streamed = false;
  let completed = false;

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
      const delta = extractStreamDelta(JSON.parse(data) as unknown);
      if (!delta) return;
      streamed = true;
      fullText += delta;
      onDelta(delta);
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

  if (!completed && buffer.trim()) consumeBlock(buffer);
  if (streamed) return { text: fullText, streamed: true };

  try {
    const payload = JSON.parse(rawResponse) as unknown;
    return { text: extractCompleteMessage(payload), streamed: false };
  } catch {
    return { text: '', streamed: false };
  }
}
