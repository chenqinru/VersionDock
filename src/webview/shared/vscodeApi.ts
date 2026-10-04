declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
};

let _api: ReturnType<typeof acquireVsCodeApi> | undefined;

export function getVsCodeApi(): ReturnType<typeof acquireVsCodeApi> {
  if (!_api) {
    const hostWindow = window as Window & { __VERSIONDOCK_VSCODE_API__?: ReturnType<typeof acquireVsCodeApi> };
    _api = hostWindow.__VERSIONDOCK_VSCODE_API__ ?? acquireVsCodeApi();
    hostWindow.__VERSIONDOCK_VSCODE_API__ = _api;
  }
  return _api;
}
