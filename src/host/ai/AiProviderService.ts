import * as vscode from 'vscode';
import { t } from '../utils/l10n';
import { getAiProviderConfig } from './config';
import { parseStreamingResponse } from './sse';
import type {
  AiProvider,
  AiProviderConfig,
  AiProviderGenerateOptions,
  AiProviderGenerateResult,
} from './types';

const GENERATION_TIMEOUT_MS = 120_000;
const GENERATION_TEMPERATURE = 0.2;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const COPILOT_INPUT_TOKEN_RESERVE_MAX = 512;
const COPILOT_INPUT_TOKEN_RESERVE_MIN = 64;

type ProviderResponse = {
  text: string;
  streamed: boolean;
  model?: string;
  inputCharCount?: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
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

  async generate(options: AiProviderGenerateOptions): Promise<AiProviderGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const config = getAiProviderConfig();
    if (config.provider !== 'github-copilot') await this.ensureApiConfig(config);
    throwIfCancelled(options.cancellationToken);

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
        : await this.generateWithApi(config, options.systemPrompt, options.userMessage, requestCancellation.token, onDelta, options.maxOutputTokens);
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

  private async generateWithCopilot(
    configuredModel: string,
    systemPrompt: string,
    userMessage: string,
    cancellationToken: vscode.CancellationToken,
    onDelta: (delta: string) => void,
  ): Promise<ProviderResponse> {
    const model = await this.selectCopilotModel(configuredModel);
    throwIfCancelled(cancellationToken);
    const fittedPrompt = await this.fitCopilotPrompt(model, systemPrompt, userMessage, cancellationToken);
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

  private async fitCopilotPrompt(
    model: vscode.LanguageModelChat,
    systemPrompt: string,
    userMessage: string,
    cancellationToken: vscode.CancellationToken,
  ): Promise<FittedCopilotPrompt> {
    const prefix = `${systemPrompt}\n\n---\n\n`;
    const maxInputTokens = model.maxInputTokens;
    const tokenReserve = Math.min(
      COPILOT_INPUT_TOKEN_RESERVE_MAX,
      Math.max(COPILOT_INPUT_TOKEN_RESERVE_MIN, Math.floor(maxInputTokens * 0.05)),
    );
    const inputTokenBudget = Math.max(1, maxInputTokens - tokenReserve);
    const createMessage = (messageText: string): vscode.LanguageModelChatMessage => (
      vscode.LanguageModelChatMessage.User(messageText)
    );
    const countTokens = async (message: vscode.LanguageModelChatMessage): Promise<number> => {
      const count = await model.countTokens(message, cancellationToken);
      throwIfCancelled(cancellationToken);
      return count;
    };

    const completeText = `${prefix}${userMessage}`;
    const completeMessage = createMessage(completeText);
    const completeTokenCount = await countTokens(completeMessage);
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

    const truncationSuffix = '\n\n...';
    const promptOnlyText = `${prefix}${truncationSuffix}`;
    const promptOnlyMessage = createMessage(promptOnlyText);
    const promptOnlyTokenCount = await countTokens(promptOnlyMessage);
    if (promptOnlyTokenCount > inputTokenBudget) {
      throw new Error(t(
        'AI prompt exceeds the input limit of GitHub Copilot model "{0}".',
        model.name || model.id,
      ));
    }

    let low = 0;
    let high = userMessage.length;
    let fittedText = promptOnlyText;
    let fittedTokenCount = promptOnlyTokenCount;
    let fittedUserMessageLength = 0;
    while (low <= high) {
      throwIfCancelled(cancellationToken);
      const middle = Math.floor((low + high) / 2);
      const candidateText = `${prefix}${userMessage.slice(0, middle)}${truncationSuffix}`;
      const candidateMessage = createMessage(candidateText);
      const candidateTokenCount = await countTokens(candidateMessage);
      if (candidateTokenCount <= inputTokenBudget) {
        fittedText = candidateText;
        fittedTokenCount = candidateTokenCount;
        fittedUserMessageLength = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const lineBoundary = userMessage.lastIndexOf('\n', fittedUserMessageLength);
    if (lineBoundary > 0 && fittedUserMessageLength < userMessage.length) {
      fittedText = `${prefix}${userMessage.slice(0, lineBoundary)}${truncationSuffix}`;
      fittedTokenCount = await countTokens(createMessage(fittedText));
    }

    return {
      message: createMessage(fittedText),
      inputCharCount: fittedText.length,
      inputTokenCount: fittedTokenCount,
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
    maxOutputTokens?: number,
  ): Promise<{ text: string; streamed: boolean }> {
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
            max_tokens: maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
            system: systemPrompt,
            temperature: GENERATION_TEMPERATURE,
            stream: true,
            messages: [{ role: 'user', content: userMessage }],
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
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: GENERATION_TEMPERATURE,
            stream: true,
            ...(maxOutputTokens === undefined ? {} : { max_tokens: maxOutputTokens }),
          }),
        });

      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_000);
        throw new AiApiRequestError(
          response.status,
          t('AI API request failed: {0} {1} {2}', response.status, response.statusText, body),
        );
      }
      return await parseStreamingResponse(response, onDelta);
    } finally {
      cancellation.dispose();
    }
  }
}
