type I18nValue = string | number | boolean;

interface I18nBootstrap {
  locale: string;
  bundle: Record<string, string>;
}

declare global {
  interface Window {
    __VERSIONDOCK_I18N__?: I18nBootstrap;
  }
}

function format(template: string, args?: Array<I18nValue> | Record<string, I18nValue>): string {
  if (!args) return template;
  if (Array.isArray(args)) {
    return template.replace(/\{(\d+)\}/g, (match, index) => {
      const value = args[Number(index)];
      return value === undefined ? match : String(value);
    });
  }
  return template.replace(/\{([^}]+)\}/g, (match, key) => {
    const value = args[key];
    return value === undefined ? match : String(value);
  });
}

export function getLocale(): string {
  return window.__VERSIONDOCK_I18N__?.locale ?? 'en';
}

export function t(message: string, ...args: Array<I18nValue>): string;
export function t(message: string, args: Record<string, I18nValue>): string;
export function t(message: string, ...args: Array<I18nValue> | [Record<string, I18nValue>]): string {
  const rawArgs = args.length === 1 && !Array.isArray(args[0]) && typeof args[0] === 'object'
    ? args[0]
    : args;
  const template = window.__VERSIONDOCK_I18N__?.bundle?.[message] ?? message;
  return format(template, rawArgs as Array<I18nValue> | Record<string, I18nValue>);
}
