import type { VersionDockLogger } from '../utils/Logger';

export class RemoteApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteApiError';
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit,
  logger: VersionDockLogger,
  scope: string,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: init.signal ?? controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${scope} request timed out after 30 seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const parsed = JSON.parse(body) as { message?: unknown; error?: unknown; error_description?: unknown };
      const candidate = parsed.message ?? parsed.error_description ?? parsed.error;
      if (typeof candidate === 'string') detail = candidate;
    } catch {
      // Do not surface arbitrary response bodies because they may contain sensitive data.
    }
    const suffix = detail ? `: ${detail.slice(0, 500)}` : '';
    throw new RemoteApiError(response.status, response.statusText, `${scope} request failed (${response.status})${suffix}`);
  }

  if (!body.trim()) return undefined as T;
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    logger.error(scope, 'Remote API returned invalid JSON', error, { url, status: response.status });
    throw new Error(`${scope} returned invalid JSON.`);
  }
}

export function normalizeHost(value: string, defaultHost = 'https://gitlab.com'): string {
  const raw = value.trim() || defaultHost;
  const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Remote host must use HTTP or HTTPS.');
  }
  parsed.hash = '';
  parsed.search = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

export function isSameHost(uri: URL, configuredHost: string): boolean {
  try {
    return normalizeHost(uri.origin) === normalizeHost(configuredHost);
  } catch {
    return false;
  }
}

export function pageUrl(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export function encodePath(value: string): string {
  // GitLab accepts a namespaced project path as the `:id` parameter only
  // when the slash separators remain URL-encoded (for example,
  // `group%2Fsubgroup%2Fproject`). Do not turn `%2F` back into `/` here.
  return encodeURIComponent(value);
}
