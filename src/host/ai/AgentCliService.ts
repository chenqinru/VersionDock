import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import {
  createAntigravityStreamInput,
  createOpenCodeSessionTitle,
  getAgentCliAdapter,
} from './AgentCliAdapters';
import type {
  AiCliProvider,
  AiProviderConfig,
  AiProviderGenerateOptions,
  AiRuntimeProvider,
  AiTaskKind,
} from './types';

const ANTIGRAVITY_SESSIONS_KEY = 'versiondock.ai.antigravityConversations';
const OPENCODE_PENDING_SESSIONS_KEY = 'versiondock.ai.openCodePendingSessions';
const APPROVED_ROOT_SETS_KEY = 'versiondock.ai.approvedCliRootSets';
const MAX_CLI_OUTPUT_BYTES = 40 * 1024 * 1024;

type CliGenerationResult = {
  text: string;
  provider: AiRuntimeProvider;
  model?: string;
  inputCharCount: number;
  inputTruncated: false;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
  conversationId?: string;
  sessionId?: string;
};

type StreamState = {
  text: string;
  streamedText: string;
  model?: string;
  sessionId?: string;
  conversationId?: string;
  error?: string;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
};

type ProcessResult = {
  stdout: string;
  stderr: string;
  state: StreamState;
};

type AntigravityConversation = {
  workingRoot: string;
  conversationId: string;
};

function isPathInsideOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function runtimeProvider(provider: AiCliProvider): AiRuntimeProvider {
  return `${provider}-cli`;
}

function findString(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (!value || typeof value !== 'object' || depth > 5) return undefined;
  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (keys.has(key.toLowerCase()) && typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findString(item, keys, depth + 1);
        if (found) return found;
      }
    } else {
      const found = findString(nested, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function getEventDelta(provider: AiCliProvider, event: Record<string, unknown>): string | undefined {
  if (provider === 'claude' || provider === 'antigravity') {
    if (event.type === 'stream_event') {
      const streamEvent = event.event as Record<string, unknown> | undefined;
      const delta = streamEvent?.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') return delta.text;
    }
  }
  if (provider === 'opencode' && event.type === 'text') {
    const part = event.part as Record<string, unknown> | undefined;
    if (typeof part?.text === 'string') return part.text;
  }
  return undefined;
}

function getEventFinalText(provider: AiCliProvider, event: Record<string, unknown>): string | undefined {
  if (provider === 'antigravity' && event.event === 'result') {
    const result = event.result as Record<string, unknown> | undefined;
    if (result?.structured_output && typeof result.structured_output === 'object') return JSON.stringify(result.structured_output);
    if (typeof result?.response === 'string') return result.response;
  }
  if ((provider === 'claude' || provider === 'antigravity') && event.type === 'result') {
    if (event.structured_output && typeof event.structured_output === 'object') return JSON.stringify(event.structured_output);
    if (typeof event.result === 'string') return event.result;
    if (typeof event.response === 'string') return event.response;
  }
  if (provider === 'codex' && event.type === 'item.completed') {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message' && typeof item.text === 'string') return item.text;
  }
  if (provider === 'opencode' && event.type === 'text') {
    const part = event.part as Record<string, unknown> | undefined;
    if (typeof part?.text === 'string') return part.text;
  }
  if (provider === 'antigravity' || provider === 'claude') {
    const message = event.message as Record<string, unknown> | undefined;
    const content = message?.content ?? event.content;
    if (Array.isArray(content)) {
      const text = content
        .map(item => item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
          ? String((item as Record<string, unknown>).text)
          : '')
        .join('');
      if (text) return text;
    }
  }
  return undefined;
}

function getOpenCodeProviderError(line: string): string | undefined {
  if (!line.includes('level=ERROR') || !line.includes('message="stream error"')) return undefined;
  const encoded = line.match(/error\.error="((?:\\.|[^"\\])*)"/)?.[1];
  if (!encoded) return undefined;
  let detail: string;
  try {
    detail = JSON.parse(`"${encoded}"`) as string;
  } catch {
    detail = encoded;
  }
  if (!/(?:rate limit|usage limit|quota|credits?|token plan|billing|unauthorized|forbidden|invalid api key)/i.test(detail)) {
    return undefined;
  }
  return `OpenCode: ${detail.replace(/^AI_[A-Za-z]+Error:\s*/, '').trim()}`;
}

function outputSchemaFor(taskKind?: AiTaskKind): Record<string, unknown> | undefined {
  if (taskKind === 'merge-conflict') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        resolutions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              index: { type: 'integer' },
              lines: { type: 'array', items: { type: 'string' } },
            },
            required: ['index', 'lines'],
          },
        },
      },
      required: ['resolutions'],
    };
  }
  if (taskKind === 'code-review') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        verdict: { type: 'string', enum: ['pass', 'warning', 'block'] },
        summary: { type: 'string' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
              title: { type: 'string' },
              anchorId: { type: 'string' },
              evidence: { type: 'string' },
              impact: { type: 'string' },
              suggestion: { type: 'string' },
            },
            required: ['id', 'severity', 'title', 'anchorId', 'evidence', 'impact', 'suggestion'],
          },
        },
      },
      required: ['verdict', 'summary', 'findings'],
    };
  }
  if (taskKind === 'commit-composer') {
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        groups: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              message: { type: 'string' },
              rationale: { type: 'string' },
              unitIds: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'message', 'rationale', 'unitIds'],
          },
        },
      },
      required: ['groups'],
    };
  }
  return undefined;
}

export class AgentCliService {
  private readonly antigravityQueues = new Map<string, Promise<void>>();
  private readonly antigravitySessions: Record<string, AntigravityConversation>;
  private readonly capabilityChecks = new Map<string, Promise<void>>();
  private readonly pendingOpenCodeSessions: Set<string>;
  private antigravityStateQueue = Promise.resolve();
  private openCodeStateQueue = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger?: VersionDockLogger,
  ) {
    this.antigravitySessions = { ...context.globalState.get<Record<string, AntigravityConversation>>(ANTIGRAVITY_SESSIONS_KEY, {}) };
    this.pendingOpenCodeSessions = new Set(context.globalState.get<string[]>(OPENCODE_PENDING_SESSIONS_KEY, []));
    void this.cleanupPendingOpenCodeSessions();
  }

  async generate(config: AiProviderConfig, options: AiProviderGenerateOptions): Promise<CliGenerationResult> {
    if (!vscode.workspace.isTrusted) throw new Error(t('Trust this workspace before using an AI CLI agent.'));
    await this.ensureCapabilities(config);
    const roots = await this.normalizeRoots(options.repoRootPaths);
    const workingRoot = this.commonRoot(roots);
    await this.confirmExpandedRoot(workingRoot, roots);
    const prompt = this.buildPrompt(options, roots, workingRoot);
    const schema = options.outputSchema ?? outputSchemaFor(options.taskKind);
    if (config.cliProvider === 'antigravity') {
      return this.enqueueAntigravity(workingRoot, () => this.runAntigravity(config, options, prompt, roots, workingRoot, schema));
    }
    return this.runOnce(config, options, prompt, roots, workingRoot, schema);
  }

  async checkCurrentCli(): Promise<void> {
    const config = (await import('./config')).getAiProviderConfig();
    this.capabilityChecks.delete(`${config.cliProvider}:${config.cliExecutablePaths[config.cliProvider]}`);
    await this.ensureCapabilities(config);
    await vscode.window.showInformationMessage(t('VersionDock: {0} CLI is available and supports the required options.', config.cliProvider));
  }

  private ensureCapabilities(config: AiProviderConfig): Promise<void> {
    const executable = config.cliExecutablePaths[config.cliProvider];
    const cacheKey = `${config.cliProvider}:${executable}`;
    const cached = this.capabilityChecks.get(cacheKey);
    if (cached) return cached;
    const check = this.checkCapabilities(config, executable).catch(error => {
      this.capabilityChecks.delete(cacheKey);
      throw error;
    });
    this.capabilityChecks.set(cacheKey, check);
    return check;
  }

  private async checkCapabilities(config: AiProviderConfig, executable: string): Promise<void> {
    const adapter = getAgentCliAdapter(config.cliProvider);
    const output: string[] = [];
    for (const args of adapter.capabilityChecks) {
      const result = await this.runSimple(executable, args, this.defaultCwd(), 15_000);
      output.push(result.stdout, result.stderr);
    }
    const combined = output.join('\n');
    if (!adapter.supports(combined)) {
      throw new Error(t('The configured {0} CLI does not support the required VersionDock options.', config.cliProvider));
    }
  }

  async resetCurrentAntigravitySession(): Promise<void> {
    const roots = await this.normalizeRoots(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath));
    const sessions = this.getAntigravitySessions();
    const keys = Object.entries(sessions)
      .filter(([, session]) => roots.some(root => (
        isPathInsideOrEqual(root, session.workingRoot) || isPathInsideOrEqual(session.workingRoot, root)
      )))
      .map(([key]) => key);
    if (keys.length === 0) {
      await vscode.window.showInformationMessage(t('VersionDock: No saved Antigravity conversation exists for this workspace.'));
      return;
    }
    for (const key of keys) delete sessions[key];
    await this.persistAntigravitySessions();
    await vscode.window.showInformationMessage(t('VersionDock: The Antigravity conversation mapping was reset. The next request will create one replacement conversation.'));
  }

  private async runOnce(
    config: AiProviderConfig,
    options: AiProviderGenerateOptions,
    prompt: string,
    roots: string[],
    workingRoot: string,
    schema?: Record<string, unknown>,
  ): Promise<CliGenerationResult> {
    if (config.cliProvider === 'opencode') return this.runOpenCode(config, options, prompt, roots, workingRoot, schema);
    const invocation = await getAgentCliAdapter(config.cliProvider).prepare({
      model: config.cliModel,
      prompt,
      workingRoot,
      repoRootPaths: roots,
      outputSchema: schema,
    });
    try {
      return await this.execute(config, options, invocation.stdin ?? prompt, workingRoot, invocation.args, invocation.env);
    } finally {
      await invocation.cleanup?.().catch(() => undefined);
    }
  }

  private async runAntigravity(
    config: AiProviderConfig,
    options: AiProviderGenerateOptions,
    prompt: string,
    roots: string[],
    workingRoot: string,
    schema?: Record<string, unknown>,
  ): Promise<CliGenerationResult> {
    const key = this.antigravityKey(workingRoot);
    const sessions = this.getAntigravitySessions();
    const existingConversation = sessions[key]?.conversationId;
    const run = async (conversationId?: string): Promise<CliGenerationResult> => {
      const invocation = await getAgentCliAdapter('antigravity').prepare({
        model: config.cliModel,
        prompt,
        workingRoot,
        repoRootPaths: roots,
        outputSchema: schema,
        conversationId,
      });
      const result = await this.execute(config, options, invocation.stdin ?? prompt, workingRoot, invocation.args, invocation.env);
      const captured = result.conversationId ?? result.sessionId ?? conversationId;
      if (!captured) {
        throw new Error(t('Antigravity CLI did not expose a conversation ID, so VersionDock cannot safely reuse the conversation.'));
      }
      if (sessions[key]?.conversationId !== captured) {
        sessions[key] = { workingRoot, conversationId: captured };
        await this.persistAntigravitySessions();
      }
      return result;
    };
    try {
      return await run(existingConversation);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!existingConversation || !/conversation.*(?:not found|missing|invalid)|找不到.*会话/i.test(detail)) throw error;
      delete sessions[key];
      await this.persistAntigravitySessions();
      return run();
    }
  }

  private async runOpenCode(
    config: AiProviderConfig,
    options: AiProviderGenerateOptions,
    prompt: string,
    roots: string[],
    workingRoot: string,
    schema?: Record<string, unknown>,
  ): Promise<CliGenerationResult> {
    const operationId = crypto.randomUUID();
    const sessionTitle = createOpenCodeSessionTitle(operationId);
    const invocation = await getAgentCliAdapter('opencode').prepare({
      model: config.cliModel,
      prompt,
      workingRoot,
      repoRootPaths: roots,
      outputSchema: schema,
      operationId,
    });
    const executable = config.cliExecutablePaths.opencode;
    let sessionId: string | undefined;
    let registration = Promise.resolve();
    let result: CliGenerationResult | undefined;
    const registerSession = (id: string): void => {
      sessionId ??= id;
      registration = registration.then(() => this.addPendingOpenCodeSession(id));
    };
    const execution = this.execute(config, options, invocation.stdin ?? prompt, workingRoot, invocation.args, invocation.env, registerSession);
    const discovery = this.discoverOpenCodeSession(executable, sessionTitle, workingRoot).then(id => {
      if (id) registerSession(id);
    }).catch((error: unknown) => {
      this.logger?.warn('AICli', 'Failed to discover VersionDock OpenCode session', {
        sessionTitle,
        error: String(error),
      });
    });
    try {
      result = await execution;
      sessionId ??= result.sessionId;
    } finally {
      await discovery;
      await registration;
      if (sessionId) await this.addPendingOpenCodeSession(sessionId);
      if (sessionId && !await this.deleteOpenCodeSession(executable, sessionId, workingRoot)) {
        void vscode.window.showWarningMessage(t(
          'VersionDock could not delete its temporary OpenCode session. It will retry when the extension next starts.',
        ));
      }
    }
    if (!sessionId) throw new Error(t('OpenCode did not expose a session ID, so VersionDock cannot safely delete its session.'));
    return result;
  }

  private async discoverOpenCodeSession(executable: string, title: string, cwd: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const listed = await this.runSimple(
        executable,
        ['session', 'list', '--format', 'json', '--max-count', '50'],
        cwd,
        15_000,
      );
      let parsed: unknown = [];
      try {
        parsed = listed.stdout.trim() ? JSON.parse(listed.stdout) as unknown : [];
      } catch {
        parsed = [];
      }
      if (Array.isArray(parsed)) {
        const match = parsed.find(item => {
          if (!item || typeof item !== 'object') return false;
          const record = item as Record<string, unknown>;
          return record.title === title && path.resolve(String(record.directory ?? cwd)) === path.resolve(cwd);
        }) as Record<string, unknown> | undefined;
        if (typeof match?.id === 'string' && match.id.trim()) return match.id.trim();
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return undefined;
  }

  private async execute(
    config: AiProviderConfig,
    options: AiProviderGenerateOptions,
    prompt: string,
    workingRoot: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    onSessionId?: (sessionId: string) => void,
  ): Promise<CliGenerationResult> {
    const startedAt = Date.now();
    const executable = config.cliExecutablePaths[config.cliProvider];
    this.logger?.info('AICli', 'Starting agent CLI request', {
      provider: config.cliProvider,
      taskKind: options.taskKind,
      workingRoot,
      repositoryCount: options.repoRootPaths?.length ?? 0,
    });
    const processResult = await this.runStreamingProcess(
      executable,
      args,
      workingRoot,
      prompt,
      env,
      config.cliTimeoutSeconds * 1_000,
      options.cancellationToken,
      config.cliProvider,
      options.onDelta,
      onSessionId,
    );
    const text = processResult.state.text.trim() || processResult.state.streamedText.trim();
    if (!text) throw new Error(t('{0} CLI did not return assistant content.', config.cliProvider));
    return {
      text,
      provider: runtimeProvider(config.cliProvider),
      model: (processResult.state.model ?? config.cliModel) || undefined,
      inputCharCount: prompt.length,
      inputTruncated: false,
      streamed: processResult.state.streamChunkCount > 0,
      streamChunkCount: processResult.state.streamChunkCount,
      streamCharCount: processResult.state.streamCharCount,
      firstTokenLatencyMs: processResult.state.firstTokenLatencyMs,
      durationMs: Date.now() - startedAt,
      conversationId: processResult.state.conversationId,
      sessionId: processResult.state.sessionId,
    };
  }

  private runStreamingProcess(
    executable: string,
    args: string[],
    cwd: string,
    stdin: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    cancellationToken: vscode.CancellationToken,
    provider: AiCliProvider,
    onDelta: (delta: string) => void,
    onSessionId?: (sessionId: string) => void,
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const state: StreamState = { text: '', streamedText: '', streamChunkCount: 0, streamCharCount: 0 };
      let stdout = '';
      let stderr = '';
      let lineBuffer = '';
      let stderrLineBuffer = '';
      let outputBytes = 0;
      let settled = false;
      let timedOut = false;
      let antigravityRecoverySent = false;
      const startedAt = Date.now();
      const stop = (): void => {
        if (settled) return;
        child.kill('SIGTERM');
        setTimeout(() => { if (!settled) child.kill('SIGKILL'); }, 2_000).unref();
      };
      const timeout = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
      const cancellation = cancellationToken.onCancellationRequested(stop);
      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let event: Record<string, unknown>;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          event = parsed as Record<string, unknown>;
        } catch {
          return;
        }
        const sessionIdValue = event.sessionID ?? event.sessionId ?? event.session_id;
        const sessionId = typeof sessionIdValue === 'string' ? sessionIdValue.trim() : undefined;
        if (sessionId && !state.sessionId) {
          state.sessionId = sessionId;
          onSessionId?.(sessionId);
        }
        const antigravityResult = provider === 'antigravity' && event.event === 'result'
          ? event.result as Record<string, unknown> | undefined
          : undefined;
        const conversationIdValue = event.conversationID
          ?? event.conversationId
          ?? event.conversation_id
          ?? antigravityResult?.conversation_id;
        const conversationId = typeof conversationIdValue === 'string' ? conversationIdValue.trim() : undefined;
        if (conversationId && !state.conversationId) state.conversationId = conversationId;
        const model = findString(event, new Set(['model']));
        if (model) state.model = model;
        if (event.type === 'error') state.error = findString(event, new Set(['message', 'error'])) ?? trimmed;
        if (antigravityResult?.status === 'ERROR' && typeof antigravityResult.error === 'string') {
          state.error = antigravityResult.error;
        }
        const delta = getEventDelta(provider, event);
        if (delta) {
          if (state.firstTokenLatencyMs === undefined) state.firstTokenLatencyMs = Date.now() - startedAt;
          state.streamedText += delta;
          state.streamChunkCount += 1;
          state.streamCharCount += delta.length;
          onDelta(delta);
        }
        const finalText = getEventFinalText(provider, event);
        if (finalText) {
          if (provider === 'opencode' || provider === 'codex') state.text += finalText;
          else state.text = finalText;
        }
        if (antigravityResult && !child.stdin.destroyed) {
          const deniedActions = antigravityResult.denied_actions ?? event.denied_actions;
          const shouldRecover = !finalText?.trim()
            && Array.isArray(deniedActions)
            && deniedActions.length > 0
            && !antigravityRecoverySent
            && !state.error;
          if (shouldRecover) {
            antigravityRecoverySent = true;
            child.stdin.write(createAntigravityStreamInput([
              'A tool action was denied because this is a non-interactive, read-only VersionDock request.',
              'Do not call any more tools. Produce the requested final answer now using only the complete authoritative context already provided in the previous user message.',
            ].join(' ')));
          } else {
            if (!finalText?.trim() && Array.isArray(deniedActions) && deniedActions.length > 0 && !state.error) {
              state.error = t('Antigravity CLI could not complete the request because non-interactive mode denied a required action.');
            }
            child.stdin.end();
          }
        }
      };
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cancellation.dispose();
        const code = (error as NodeJS.ErrnoException).code;
        reject(code === 'ENOENT'
          ? new Error(t('AI CLI executable was not found: {0}', executable))
          : error);
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
          stop();
          return;
        }
        stdout += chunk;
        lineBuffer += chunk;
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });
      child.stderr.on('data', (chunk: string) => {
        outputBytes += Buffer.byteLength(chunk);
        stderr += chunk;
        if (provider === 'opencode') {
          stderrLineBuffer += chunk;
          const lines = stderrLineBuffer.split(/\r?\n/);
          stderrLineBuffer = lines.pop() ?? '';
          for (const line of lines) {
            const providerError = getOpenCodeProviderError(line);
            if (!providerError || state.error) continue;
            state.error = providerError;
            stop();
          }
        }
        if (outputBytes > MAX_CLI_OUTPUT_BYTES) stop();
      });
      child.stdin.on('error', () => undefined);
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cancellation.dispose();
        if (lineBuffer) handleLine(lineBuffer);
        if (provider === 'opencode' && stderrLineBuffer && !state.error) {
          state.error = getOpenCodeProviderError(stderrLineBuffer);
        }
        if (cancellationToken.isCancellationRequested) {
          reject(new Error('Cancelled'));
          return;
        }
        if (timedOut) {
          reject(new Error(t('{0} CLI request timed out after {1} seconds.', provider, Math.round(timeoutMs / 1_000))));
          return;
        }
        if (outputBytes > MAX_CLI_OUTPUT_BYTES) {
          reject(new Error(t('{0} CLI output exceeded the safety limit.', provider)));
          return;
        }
        if (code !== 0 || state.error) {
          reject(new Error((state.error || stderr.trim() || t('{0} CLI exited with code {1}.', provider, code ?? 'unknown')).slice(0, 4_000)));
          return;
        }
        resolve({ stdout, stderr, state });
      });
      if (provider === 'antigravity') child.stdin.write(stdin);
      else child.stdin.end(stdin);
    });
  }

  private buildPrompt(options: AiProviderGenerateOptions, roots: string[], workingRoot: string): string {
    const taskKind = options.taskKind ?? 'json-repair';
    const selectedPaths = Array.from(new Set((options.selectedPaths ?? []).filter(Boolean)));
    return [
      '# VersionDock read-only agent task',
      '',
      'Treat this request as an independent task. Ignore conclusions from earlier tasks and re-read the current repository state when additional context is needed.',
      'Do not edit, create, delete, move, stage, commit, switch, reset, or otherwise mutate files, repositories, configuration, or external systems.',
      'Do not read credential stores or sensitive files such as .env, private keys, access tokens, or cloud credential files, even when they are inside the working root.',
      'The VersionDock-provided change context and selection are authoritative. Do not include unselected changes in the answer.',
      `Task kind: ${taskKind}`,
      `Working root: ${workingRoot}`,
      `Selected repositories:\n${roots.map(root => `- ${root}`).join('\n')}`,
      selectedPaths.length > 0 ? `Selected paths:\n${selectedPaths.map(item => `- ${item}`).join('\n')}` : 'Selected paths: encoded in the authoritative task context below.',
      '',
      '# Active VersionDock instructions',
      options.systemPrompt,
      '',
      '# Authoritative task context',
      options.userMessage,
    ].join('\n');
  }

  private async normalizeRoots(values?: string[]): Promise<string[]> {
    const candidates = (values ?? []).map(value => value.trim()).filter(Boolean);
    if (candidates.length === 0) {
      const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
      candidates.push(...workspaceRoots);
    }
    if (candidates.length === 0) throw new Error(t('Open a workspace before using an AI CLI agent.'));
    const roots: string[] = [];
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      const real = await fs.realpath(resolved).catch(() => resolved);
      if (!roots.includes(real)) roots.push(real);
    }
    return roots;
  }

  private commonRoot(roots: string[]): string {
    let common = roots[0];
    for (const root of roots.slice(1)) {
      while (!isPathInsideOrEqual(common, root)) {
        const parent = path.dirname(common);
        if (parent === common) throw new Error(t('Selected repositories do not share a safe local working root.'));
        common = parent;
      }
    }
    if (common === path.parse(common).root) throw new Error(t('The AI CLI working root cannot be a filesystem root.'));
    return common;
  }

  private async confirmExpandedRoot(workingRoot: string, roots: string[]): Promise<void> {
    if (roots.length < 2) return;
    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => path.resolve(folder.uri.fsPath)) ?? [];
    if (workspaceRoots.some(folder => isPathInsideOrEqual(folder, workingRoot))) return;
    const approvalKey = crypto.createHash('sha256').update(JSON.stringify([workingRoot, ...roots.slice().sort()])).digest('hex');
    const approved = new Set(this.context.globalState.get<string[]>(APPROVED_ROOT_SETS_KEY, []));
    if (approved.has(approvalKey)) return;
    const allow = t('Allow Read Access');
    const selected = await vscode.window.showWarningMessage(
      t('VersionDock AI CLI needs read access to the common parent folder "{0}" for the selected repositories. The agent may be able to read unselected sibling files.', workingRoot),
      { modal: true },
      allow,
    );
    if (selected !== allow) throw new Error('Cancelled');
    approved.add(approvalKey);
    await this.context.globalState.update(APPROVED_ROOT_SETS_KEY, Array.from(approved));
  }

  private enqueueAntigravity<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.antigravityQueues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.antigravityQueues.set(key, tail);
    return previous.then(task).finally(() => {
      release();
      if (this.antigravityQueues.get(key) === tail) this.antigravityQueues.delete(key);
    });
  }

  private antigravityKey(workingRoot: string): string {
    return crypto.createHash('sha256').update(workingRoot).digest('hex');
  }

  private getAntigravitySessions(): Record<string, AntigravityConversation> {
    return this.antigravitySessions;
  }

  private persistAntigravitySessions(): Promise<void> {
    const update = this.antigravityStateQueue.catch(() => undefined).then(() => (
      this.context.globalState.update(ANTIGRAVITY_SESSIONS_KEY, { ...this.antigravitySessions })
    ));
    this.antigravityStateQueue = update.catch(() => undefined);
    return update;
  }

  private async addPendingOpenCodeSession(sessionId: string): Promise<void> {
    if (this.pendingOpenCodeSessions.has(sessionId)) return;
    this.pendingOpenCodeSessions.add(sessionId);
    await this.persistOpenCodeSessions();
  }

  private async deleteOpenCodeSession(executable: string, sessionId: string, cwd: string): Promise<boolean> {
    try {
      await this.runSimple(executable, ['session', 'delete', sessionId], cwd, 30_000);
      this.pendingOpenCodeSessions.delete(sessionId);
      await this.persistOpenCodeSessions();
      return true;
    } catch (error: unknown) {
      this.logger?.warn('AICli', 'Failed to delete VersionDock OpenCode session', { sessionId, error: String(error) });
      return false;
    }
  }

  private persistOpenCodeSessions(): Promise<void> {
    const update = this.openCodeStateQueue.catch(() => undefined).then(() => (
      this.context.globalState.update(OPENCODE_PENDING_SESSIONS_KEY, Array.from(this.pendingOpenCodeSessions))
    ));
    this.openCodeStateQueue = update.catch(() => undefined);
    return update;
  }

  private async cleanupPendingOpenCodeSessions(): Promise<void> {
    if (this.pendingOpenCodeSessions.size === 0) return;
    const config = (await import('./config')).getAiProviderConfig();
    for (const sessionId of Array.from(this.pendingOpenCodeSessions)) {
      await this.deleteOpenCodeSession(config.cliExecutablePaths.opencode, sessionId, this.defaultCwd());
    }
  }

  private defaultCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.tmpdir();
  }

  private runSimple(executable: string, args: string[], cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const code = (error as NodeJS.ErrnoException).code;
        reject(code === 'ENOENT' ? new Error(t('AI CLI executable was not found: {0}', executable)) : error);
      });
      child.once('close', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (timedOut) reject(new Error(t('CLI request timed out.')));
        else if (code === 0) resolve({ stdout, stderr });
        else reject(new Error((stderr.trim() || stdout.trim() || t('CLI exited with code {0}.', code ?? 'unknown')).slice(0, 4_000)));
      });
    });
  }
}
