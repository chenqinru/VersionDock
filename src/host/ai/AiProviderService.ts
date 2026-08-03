import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getAiProviderConfig } from './config';
import { parseStreamingResponse } from './sse';
import { estimateTokenCount, getInputTokenBudget, truncateToTokenBudget } from './inputTokenBudget';
import type {
  AiProvider,
  AiProviderConfig,
  AiProviderGenerateOptions,
  AiProviderGenerateResult,
} from './types';

const GENERATION_TIMEOUT_MS = 120_000;
const GENERATION_TEMPERATURE = 0.2;

type ProviderResponse = {
  text: string;
  streamed: boolean;
  model?: string;
  inputCharCount?: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  finishReason?: string;
  outputTokenCount?: number;
  reasoningTokenCount?: number;
  inputTruncated?: boolean;
};

type FittedCopilotPrompt = {
  message: vscode.LanguageModelChatMessage;
  inputCharCount: number;
  inputTokenCount: number;
  inputTokenBudget: number;
  maxInputTokens: number;
  inputTruncated: boolean;
};

type FittedApiPrompt = {
  systemPrompt: string;
  userMessage: string;
  inputCharCount: number;
  inputTokenCount: number;
  inputTokenBudget: number;
  maxInputTokens: number;
  inputTruncated: boolean;
};

class AiApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

export class AiProviderService {
  getProvider(): AiProvider {
    return getAiProviderConfig().provider;
  }

  getMaxOutputTokens(): number | undefined {
    const config = getAiProviderConfig();
    return config.provider === 'github-copilot' ? undefined : config.maxOutputTokens;
  }

  async getMaxInputTokens(): Promise<number> {
    const config = getAiProviderConfig();
    if (config.provider !== 'github-copilot') return config.maxInputTokens;
    const model = await this.selectCopilotModel(config.model);
    return model.maxInputTokens;
  }

  async generate(options: AiProviderGenerateOptions): Promise<AiProviderGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const config = getAiProviderConfig();
    if (config.provider !== 'github-copilot') await this.ensureApiConfig(config);
    throwIfCancelled(options.cancellationToken);
    const maxOutputTokens = config.provider === 'github-copilot'
      ? undefined
      : this.resolveMaxOutputTokens(config.maxOutputTokens, options.maxOutputTokens);
    const temperature = options.temperature === undefined
      ? GENERATION_TEMPERATURE
      : Math.max(0, Math.min(1, options.temperature));

    const requestStartedAt = Date.now();
    let timedOut = false;
    let streamChunkCount = 0;
    let streamCharCount = 0;
    let firstTokenLatencyMs: number | undefined;
    const requestCancellation = new vscode.CancellationTokenSource();
    const parentCancellation = options.cancellationToken.onCancellationRequested(() => requestCancellation.cancel());
    const timeout = setTimeout(() => {
      timedOut = true;
      requestCancellation.cancel();
    }, GENERATION_TIMEOUT_MS);

    const onDelta = (delta: string): void => {
      if (!delta || requestCancellation.token.isCancellationRequested) return;
      if (firstTokenLatencyMs === undefined) firstTokenLatencyMs = Date.now() - requestStartedAt;
      streamChunkCount += 1;
      streamCharCount += delta.length;
      options.onDelta(delta);
    };

    try {
      const response: ProviderResponse = config.provider === 'github-copilot'
        ? await this.generateWithCopilot(config.model, options.systemPrompt, options.userMessage, requestCancellation.token, onDelta)
        : await this.generateWithApi(
          config,
          options.systemPrompt,
          options.userMessage,
          requestCancellation.token,
          onDelta,
          maxOutputTokens ?? config.maxOutputTokens,
          temperature,
        );
      throwIfCancelled(requestCancellation.token);
      if (!response.text.trim()) throw new Error(t('AI provider did not return content.'));

      return {
        text: response.text,
        provider: config.provider,
        model: config.provider === 'github-copilot' ? response.model : config.model,
        inputCharCount: response.inputCharCount ?? options.systemPrompt.length + options.userMessage.length,
        inputTokenCount: response.inputTokenCount,
        inputTokenBudget: response.inputTokenBudget,
        maxInputTokens: response.maxInputTokens,
        maxOutputTokens: response.maxOutputTokens,
        finishReason: response.finishReason,
        outputTokenCount: response.outputTokenCount,
        reasoningTokenCount: response.reasoningTokenCount,
        inputTruncated: response.inputTruncated ?? false,
        streamed: response.streamed,
        streamChunkCount,
        streamCharCount,
        firstTokenLatencyMs,
        durationMs: Date.now() - requestStartedAt,
      };
    } catch (error: unknown) {
      if (options.cancellationToken.isCancellationRequested) throw new Error('Cancelled');
      if (timedOut) throw new Error(t('AI request timed out after 120 seconds.'));
      if (error instanceof AiApiRequestError && (error.status === 401 || error.status === 403)) {
        throw new Error(t('AI API authentication failed. Check the configured API key.'));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      parentCancellation.dispose();
      requestCancellation.dispose();
    }
  }

  private async ensureApiConfig(config: AiProviderConfig): Promise<void> {
    if (!config.apiKey || !config.apiUrl || !config.model) {
      const configure = t('Open Settings');
      const selected = await vscode.window.showWarningMessage(
        t('Provider {0} requires an API Key, API URL, and model.', config.provider),
        configure,
      );
      if (selected === configure) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'versiondock.ai');
      }
      throw new Error('Cancelled');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(config.apiUrl);
    } catch {
      throw new Error(t('AI API URL is invalid: {0}', config.apiUrl));
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      throw new Error(t('AI API URL must use HTTP or HTTPS.'));
    }
  }

  private resolveMaxOutputTokens(configuredMaximum: number, requestedMaximum?: number): number {
    const requested = typeof requestedMaximum === 'number' && Number.isFinite(requestedMaximum)
      ? Math.max(1, Math.floor(requestedMaximum))
      : configuredMaximum;
    return Math.min(configuredMaximum, requested);
  }

  private async generateWithCopilot(
    configuredModel: string,
    systemPrompt: string,
    userMessage: string,
    cancellationToken: vscode.CancellationToken,
    onDelta: (delta: string) => void,
  ): Promise<ProviderResponse> {
    const model = await this.selectCopilotModel(configuredModel);
    throwIfCancelled(cancellationToken);
    const fittedPrompt = this.fitCopilotPrompt(model, systemPrompt, userMessage);
    throwIfCancelled(cancellationToken);

    const response = await model.sendRequest(
      [fittedPrompt.message],
      {},
      cancellationToken,
    );
    let text = '';
    for await (const delta of response.text) {
      throwIfCancelled(cancellationToken);
      text += delta;
      onDelta(delta);
    }
    return {
      text,
      streamed: text.length > 0,
      model: model.name || model.family || model.id,
      inputCharCount: fittedPrompt.inputCharCount,
      inputTokenCount: fittedPrompt.inputTokenCount,
      inputTokenBudget: fittedPrompt.inputTokenBudget,
      maxInputTokens: fittedPrompt.maxInputTokens,
      inputTruncated: fittedPrompt.inputTruncated,
    };
  }

  private fitCopilotPrompt(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userMessage: string,
  ): FittedCopilotPrompt {
    const prefix = `${systemPrompt}\n\n---\n\n`;
    const maxInputTokens = model.maxInputTokens;
    const inputTokenBudget = getInputTokenBudget(maxInputTokens);
    const createMessage = (messageText: string): vscode.LanguageModelChatMessage => (
      vscode.LanguageModelChatMessage.User(messageText)
    );

    const completeText = `${prefix}${userMessage}`;
    const completeMessage = createMessage(completeText);
    const completeTokenCount = estimateTokenCount(completeText);
    if (completeTokenCount <= inputTokenBudget) {
      return {
        message: completeMessage,
        inputCharCount: completeText.length,
        inputTokenCount: completeTokenCount,
        inputTokenBudget,
        maxInputTokens,
        inputTruncated: false,
      };
    }

    const prefixTokenCount = estimateTokenCount(prefix);
    if (prefixTokenCount > inputTokenBudget) {
      throw new Error(t(
        'AI prompt exceeds the input limit of GitHub Copilot model "{0}".',
        model.name || model.id,
      ));
    }

    const fittedUserMessage = truncateToTokenBudget(
      userMessage,
      Math.max(1, inputTokenBudget - prefixTokenCount),
      '\n\n...',
    );
    const fittedText = `${prefix}${fittedUserMessage}`;

    return {
      message: createMessage(fittedText),
      inputCharCount: fittedText.length,
      inputTokenCount: estimateTokenCount(fittedText),
      inputTokenBudget,
      maxInputTokens,
      inputTruncated: true,
    };
  }

  private async selectCopilotModel(configuredModel: string): Promise<vscode.LanguageModelChat> {
    const requestedModel = configuredModel.trim();
    if (!requestedModel) {
      const automaticModels = await this.selectCopilotModels({ vendor: 'copilot' });
      const automaticModel = automaticModels[0];
      if (automaticModel) return automaticModel;
      throw new Error(t('No AI model available. Install GitHub Copilot to use this feature.'));
    }

    const selectors: vscode.LanguageModelChatSelector[] = [
      { vendor: 'copilot', id: requestedModel },
      { vendor: 'copilot', family: requestedModel },
    ];
    for (const selector of selectors) {
      const matched = await this.selectCopilotModels(selector);
      if (matched[0]) return matched[0];
    }

    const normalizedRequestedModel = requestedModel.toLowerCase();
    const availableModels = await this.selectCopilotModels({ vendor: 'copilot' });
    const matchedByName = availableModels.find(model => [model.name, model.id, model.family]
      .some(value => value.toLowerCase() === normalizedRequestedModel));
    if (matchedByName) return matchedByName;
    throw new Error(t('Configured GitHub Copilot model "{0}" is not available.', requestedModel));
  }

  private async selectCopilotModels(selector: vscode.LanguageModelChatSelector): Promise<vscode.LanguageModelChat[]> {
    try {
      return await vscode.lm.selectChatModels(selector);
    } catch {
      return [];
    }
  }

  private async generateWithApi(
    config: AiProviderConfig,
    systemPrompt: string,
    userMessage: string,
    cancellationToken: vscode.CancellationToken,
    onDelta: (delta: string) => void,
    maxOutputTokens: number,
    temperature: number,
  ): Promise<ProviderResponse> {
    const fittedPrompt = this.fitApiPrompt(config.maxInputTokens, systemPrompt, userMessage);
    const controller = new AbortController();
    const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
    try {
      const response = config.provider === 'claude'
        ? await fetch(config.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'x-api-key': config.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: config.model,
            max_tokens: maxOutputTokens,
            system: fittedPrompt.systemPrompt,
            temperature,
            stream: true,
            messages: [{ role: 'user', content: fittedPrompt.userMessage }],
          }),
        })
        : await fetch(config.apiUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            Authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: 'system', content: fittedPrompt.systemPrompt },
              { role: 'user', content: fittedPrompt.userMessage },
            ],
            temperature,
            stream: true,
            ...(config.provider === 'openai' ? { stream_options: { include_usage: true } } : {}),
            ...(config.provider === 'openai'
              ? { max_completion_tokens: maxOutputTokens }
              : { max_tokens: maxOutputTokens }),
          }),
        });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_000);
        throw new AiApiRequestError(
          response.status,
          t('AI API request failed: {0} {1} {2}', response.status, response.statusText, body),
        );
      }
      return {
        ...await parseStreamingResponse(response, onDelta),
        inputCharCount: fittedPrompt.inputCharCount,
        inputTokenCount: fittedPrompt.inputTokenCount,
        inputTokenBudget: fittedPrompt.inputTokenBudget,
        maxInputTokens: fittedPrompt.maxInputTokens,
        maxOutputTokens,
        inputTruncated: fittedPrompt.inputTruncated,
      };
    } finally {
      cancellation.dispose();
    }
  }

  private fitApiPrompt(maxInputTokens: number, systemPrompt: string, userMessage: string): FittedApiPrompt {
    const inputTokenBudget = getInputTokenBudget(maxInputTokens);
    const promptTokenCount = estimateTokenCount(systemPrompt);
    if (promptTokenCount > inputTokenBudget) {
      throw new Error(t('AI prompt exceeds the configured input limit of {0} tokens.', maxInputTokens));
    }

    const completeTokenCount = promptTokenCount + estimateTokenCount(userMessage);
    if (completeTokenCount <= inputTokenBudget) {
      return {
        systemPrompt,
        userMessage,
        inputCharCount: systemPrompt.length + userMessage.length,
        inputTokenCount: completeTokenCount,
        inputTokenBudget,
        maxInputTokens,
        inputTruncated: false,
      };
    }

    const fittedUserMessage = truncateToTokenBudget(
      userMessage,
      Math.max(1, inputTokenBudget - promptTokenCount),
      '\n\n...',
    );
    return {
      systemPrompt,
      userMessage: fittedUserMessage,
      inputCharCount: systemPrompt.length + fittedUserMessage.length,
      inputTokenCount: promptTokenCount + estimateTokenCount(fittedUserMessage),
      inputTokenBudget,
      maxInputTokens,
      inputTruncated: true,
    };
  }
}
