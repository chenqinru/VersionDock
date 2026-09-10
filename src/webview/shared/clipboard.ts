import { getVsCodeApi } from './vscodeApi';

const pendingReadCallbacks = new Map<string, (text: string) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (data && data.type === 'COMMIT_READ_CLIPBOARD_RESULT' && typeof data.requestId === 'string') {
      const callback = pendingReadCallbacks.get(data.requestId);
      if (callback) {
        pendingReadCallbacks.delete(data.requestId);
        callback(typeof data.text === 'string' ? data.text : '');
      }
    }
  });
}

/**
 * 写入剪贴板文本（双重保障：Webview Navigator API + VSCode Host）
 */
export async function writeClipboardText(text: string): Promise<void> {
  // 1. 尝试 Web 剪贴板 API
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // 忽略异常，继续通知 Host 处理
  }

  // 2. 同时通知 VSCode Host 写入，确保在各类沙箱权限限制下依然可靠
  try {
    getVsCodeApi().postMessage({
      type: 'COMMIT_WRITE_CLIPBOARD',
      text,
    });
  } catch {
    // ignore
  }
}

/**
 * 读取剪贴板文本（双重保障：优先 Webview Navigator API，失败时 fallback 到 VSCode Host）
 */
export async function readClipboardText(): Promise<string> {
  // 1. 尝试 Web 剪贴板 API
  try {
    if (navigator?.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      if (typeof text === 'string') {
        return text;
      }
    }
  } catch {
    // Webview 权限受限或不支持时 fallback
  }

  // 2. Fallback 通过 VSCode Host (vscode.env.clipboard.readText) 获取
  return new Promise<string>((resolve) => {
    const requestId = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => {
      if (pendingReadCallbacks.has(requestId)) {
        pendingReadCallbacks.delete(requestId);
        resolve('');
      }
    }, 1500);

    pendingReadCallbacks.set(requestId, (text) => {
      clearTimeout(timer);
      resolve(text);
    });

    try {
      getVsCodeApi().postMessage({
        type: 'COMMIT_READ_CLIPBOARD',
        requestId,
      });
    } catch {
      clearTimeout(timer);
      pendingReadCallbacks.delete(requestId);
      resolve('');
    }
  });
}
