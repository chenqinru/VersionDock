import { execFile } from 'child_process';

export interface CliResult {
  stdout: string;
  stderr: string;
}

export interface CliOptions {
  cwd: string;
  timeout?: number;
  maxBuffer?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly command: string,
    public readonly args: string[],
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly code?: number | string | null,
  ) {
    super(message);
  }
}

export function execCli(command: string, args: string[], options: CliOptions): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 120_000,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
        windowsHide: true,
        env: options.env,
      },
      (error, stdout, stderr) => {
        const out = stdout?.toString() ?? '';
        const err = stderr?.toString() ?? '';
        if (error) {
          const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
          const exceededBuffer = code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          const detail = err.trim() || (exceededBuffer ? error.message : out.trim()) || error.message;
          reject(new CliError(detail, command, args, out, err, code));
          return;
        }
        resolve({ stdout: out, stderr: err });
      },
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

export function quoteCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(' ');
}
