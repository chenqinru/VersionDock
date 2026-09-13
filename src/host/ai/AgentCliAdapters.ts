import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { AiCliProvider } from './types';

export type AgentCliInvocationOptions = {
  model: string;
  prompt: string;
  workingRoot: string;
  repoRootPaths: string[];
  outputSchema?: Record<string, unknown>;
  conversationId?: string;
  operationId?: string;
};

export type PreparedAgentCliInvocation = {
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  cleanup?: () => Promise<void>;
};

export interface AgentCliAdapter {
  readonly provider: AiCliProvider;
  readonly capabilityChecks: string[][];
  supports(helpOutput: string): boolean;
  prepare(options: AgentCliInvocationOptions): Promise<PreparedAgentCliInvocation>;
}

export function createAntigravityStreamInput(prompt: string): string {
  return `${JSON.stringify({
    event: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  })}\n`;
}

export function createOpenCodeSessionTitle(operationId: string): string {
  return `VersionDock:${operationId}`;
}

function normalizeOpenCodeModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('/')) return `opencode/${trimmed}`;
  const separator = trimmed.indexOf('/');
  if (separator === 0 || separator === trimmed.length - 1) {
    throw new Error('OpenCode model must use the provider/model format.');
  }
  return trimmed;
}

export class ClaudeCliAdapter implements AgentCliAdapter {
  readonly provider = 'claude' as const;
  readonly capabilityChecks = [['--version'], ['--help']];

  supports(output: string): boolean {
    return ['--print', '--no-session-persistence', '--permission-mode', '--tools', '--output-format', '--json-schema']
      .every(option => output.includes(option));
  }

  async prepare(options: AgentCliInvocationOptions): Promise<PreparedAgentCliInvocation> {
    const args = [
      '--print',
      '--no-session-persistence',
      '--permission-mode',
      'plan',
      '--tools',
      'Read,Glob,Grep',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ];
    if (options.model) args.push('--model', options.model);
    for (const root of options.repoRootPaths) if (root !== options.workingRoot) args.push('--add-dir', root);
    if (options.outputSchema) args.push('--json-schema', JSON.stringify(options.outputSchema));
    return { args };
  }
}

export class CodexCliAdapter implements AgentCliAdapter {
  readonly provider = 'codex' as const;
  readonly capabilityChecks = [['--version'], ['exec', '--help']];

  supports(output: string): boolean {
    return ['--ephemeral', '--sandbox', '--output-schema', '--json', '--cd', '--skip-git-repo-check']
      .every(option => output.includes(option));
  }

  async prepare(options: AgentCliInvocationOptions): Promise<PreparedAgentCliInvocation> {
    const args = [
      'exec',
      '--ephemeral',
      '--json',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--cd',
      options.workingRoot,
    ];
    if (options.model) args.push('--model', options.model);
    let tempDir: string | undefined;
    if (options.outputSchema) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'versiondock-ai-schema-'));
      try {
        const schemaPath = path.join(tempDir, 'output-schema.json');
        await fs.writeFile(schemaPath, JSON.stringify(options.outputSchema), 'utf8');
        args.push('--output-schema', schemaPath);
      } catch (error: unknown) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }
    args.push('-');
    return {
      args,
      cleanup: tempDir
        ? () => fs.rm(tempDir, { recursive: true, force: true }).then(() => undefined)
        : undefined,
    };
  }
}

export class AntigravityCliAdapter implements AgentCliAdapter {
  readonly provider = 'antigravity' as const;
  readonly capabilityChecks = [['--version'], ['--help']];

  supports(output: string): boolean {
    return ['--input-format', '--output-format', '--mode', '--sandbox', '--json-schema', '--conversation']
      .every(option => output.includes(option));
  }

  async prepare(options: AgentCliInvocationOptions): Promise<PreparedAgentCliInvocation> {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox'];
    if (options.model) args.push('--model', options.model);
    for (const root of options.repoRootPaths) if (root !== options.workingRoot) args.push('--add-dir', root);
    if (options.outputSchema) args.push('--json-schema', JSON.stringify(options.outputSchema));
    if (options.conversationId) args.push('--conversation', options.conversationId);
    const prompt = [
      '# Antigravity headless tool constraints',
      'Do not call run_command or any terminal, browser, network, subagent, task, schedule, editing, or writing tool.',
      'This non-interactive integration cannot approve permission prompts. If more source context is necessary, use only view_file, grep_search, find_by_name, or list_dir within the selected repositories.',
      'The VersionDock-provided Git/SVN status, diff, history, commit, and conflict context is authoritative and sufficient for the requested result. Do not run Git commands to verify it or infer additional conventions.',
      'If any tool is unavailable or denied, immediately produce the requested final answer from the supplied context without requesting permission.',
      '',
      options.prompt,
    ].join('\n');
    return {
      args,
      stdin: createAntigravityStreamInput(prompt),
    };
  }
}

export class OpenCodeCliAdapter implements AgentCliAdapter {
  readonly provider = 'opencode' as const;
  readonly capabilityChecks = [
    ['--version'],
    ['run', '--help'],
    ['session', 'list', '--help'],
    ['session', 'delete', '--help'],
  ];

  supports(output: string): boolean {
    return ['session delete', '--format', '--dir', '--title', '--agent', '--print-logs', '--log-level', '--max-count']
      .every(option => output.includes(option));
  }

  async prepare(options: AgentCliInvocationOptions): Promise<PreparedAgentCliInvocation> {
    const args = [
      'run',
      '--print-logs',
      '--log-level',
      'ERROR',
      '--format',
      'json',
      '--dir',
      options.workingRoot,
      '--title',
      createOpenCodeSessionTitle(options.operationId ?? 'request'),
      '--agent',
      'versiondock-readonly',
    ];
    const model = normalizeOpenCodeModel(options.model);
    if (model) args.push('--model', model);
    let existingConfig: Record<string, unknown> = {};
    const existingConfigText = process.env.OPENCODE_CONFIG_CONTENT?.trim();
    if (existingConfigText) {
      const parsed = JSON.parse(existingConfigText) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('OPENCODE_CONFIG_CONTENT must contain a JSON object.');
      }
      existingConfig = parsed as Record<string, unknown>;
    }
    const existingAgents = existingConfig.agent && typeof existingConfig.agent === 'object' && !Array.isArray(existingConfig.agent)
      ? existingConfig.agent as Record<string, unknown>
      : {};
    return {
      args,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          ...existingConfig,
          agent: {
            ...existingAgents,
            'versiondock-readonly': {
              description: 'VersionDock read-only repository analysis',
              mode: 'primary',
              permission: {
                '*': 'deny',
                read: {
                  '*': 'allow',
                  '*.env': 'deny',
                  '*.env.*': 'deny',
                  '*.pem': 'deny',
                  '*.key': 'deny',
                },
                glob: 'allow',
                grep: 'allow',
                list: 'allow',
              },
            },
          },
        }),
      },
    };
  }
}

const ADAPTERS: Record<AiCliProvider, AgentCliAdapter> = {
  claude: new ClaudeCliAdapter(),
  codex: new CodexCliAdapter(),
  antigravity: new AntigravityCliAdapter(),
  opencode: new OpenCodeCliAdapter(),
};

export function getAgentCliAdapter(provider: AiCliProvider): AgentCliAdapter {
  return ADAPTERS[provider];
}
