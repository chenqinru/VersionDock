import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';

function emitter() {
  const listeners = new Set();
  return {
    event: listener => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: value => { for (const listener of [...listeners]) listener(value); },
    get size() { return listeners.size; },
  };
}

const configChanges = emitter();
let visibility = 'system';
let modernUi = true;
let reduceMotion = 'off';
const vscode = {
  workspace: {
    getConfiguration: section => ({ get: key => section === 'workbench'
      ? key === 'experimental.modernUI' ? modernUi : reduceMotion : visibility }),
    onDidChangeConfiguration: configChanges.event,
  },
  Disposable: { from: (...values) => ({ dispose: () => values.forEach(value => value.dispose()) }) },
};
const bundle = await build({
  entryPoints: ['src/host/utils/webviewScrollbars.ts'],
  bundle: true, write: false, platform: 'node', format: 'cjs',
  target: 'node18', minify: true, external: ['vscode'],
});
const hostContext = createContext({ module: { exports: {} }, require: id => {
  assert.equal(id, 'vscode');
  return vscode;
} });
runInContext(bundle.outputFiles[0].text, hostContext);
const { getWebviewScrollbarHead, registerWebviewScrollbars } = hostContext.module.exports;

function owner(isView) {
  const incoming = emitter();
  const disposed = emitter();
  const shown = emitter();
  const sent = [];
  const view = {
    visible: true,
    webview: {
      postMessage: message => { sent.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: incoming.event,
    },
    onDidDispose: disposed.event,
    [isView ? 'onDidChangeVisibility' : 'onDidChangeViewState']: shown.event,
  };
  return { view, incoming, disposed, shown, sent };
}

// A loading or recreated page must receive the latest setting when it becomes ready.
for (const isView of [true, false]) {
  const page = owner(isView);
  const registration = registerWebviewScrollbars(page.view);
  visibility = 'auto';
  page.incoming.fire({ type: 'VERSIONDOCK_SCROLLBAR_READY' });
  assert.equal(page.sent.at(-1).visibility, 'auto');
  visibility = 'visible';
  configChanges.fire({ affectsConfiguration: name => name === 'versiondock.scrollbarVisibility' });
  assert.equal(page.sent.at(-1).visibility, 'visible');
  assert.equal(page.sent.at(-1).modernUi, true);
  modernUi = false;
  configChanges.fire({ affectsConfiguration: name => name === 'workbench.experimental.modernUI' });
  assert.equal(page.sent.at(-1).modernUi, false);
  reduceMotion = 'on';
  configChanges.fire({ affectsConfiguration: name => name === 'workbench.reduceMotion' });
  assert.equal(page.sent.at(-1).reduceMotion, 'on');
  modernUi = true;
  reduceMotion = 'off';
  const count = page.sent.length;
  configChanges.fire({ affectsConfiguration: () => false });
  page.incoming.fire({ type: 'APP_READY' });
  assert.equal(page.sent.length, count, 'Unrelated events must not trigger updates');
  visibility = 'system';
  page.shown.fire();
  assert.equal(page.sent.at(-1).visibility, 'system', 'Revealing a retained page resynchronizes policy');
  page.disposed.fire();
  assert.equal(configChanges.size, 0);
  assert.equal(page.incoming.size, 0);
  assert.equal(page.shown.size, 0);
  assert.equal(page.disposed.size, 0);
  registration.dispose();
}

// Exercise the serialized production bootstrap: no module closures or duplicate API acquisition.
const browserEvents = new Map();
const documentEvents = new Map();
const root = { dataset: {} };
const messages = [];
const api = { postMessage: message => messages.push(message), getState: () => ({ saved: true }), setState() {} };
let acquisitions = 0;
const browserWindow = {
  addEventListener: (type, listener) => {
    const previous = browserEvents.get(type);
    browserEvents.set(type, event => { previous?.(event); listener(event); });
  },
  dispatchEvent() {},
  acquireVsCodeApi: () => { assert.equal(++acquisitions, 1); return api; },
};
const document = {
  documentElement: root,
  addEventListener: (type, listener) => documentEvents.set(type, listener),
  activeElement: null,
};
const context = createContext({
  window: browserWindow, document, setTimeout, clearTimeout, Event: class {},
  requestAnimationFrame: () => 1,
  cancelAnimationFrame() {},
});
for (const mode of ['system', 'auto', 'visible', 'invalid']) {
  visibility = mode;
  const head = getWebviewScrollbarHead('test-nonce');
  const script = head.match(/<script nonce="test-nonce">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  runInContext(script, context);
  assert.equal(root.dataset.versiondockScrollbarVisibility, mode === 'invalid' ? 'system' : mode);
}
assert.equal(acquisitions, 1);
assert.equal(messages.length, 4);
assert.ok(messages.every(message => message.type === 'VERSIONDOCK_SCROLLBAR_READY'));
browserEvents.get('message')({ data: { type: 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE', visibility: 'visible' } });
assert.equal(root.dataset.versiondockScrollbarVisibility, 'visible');
browserEvents.get('message')({ data: { type: 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE', visibility: 'invalid' } });
assert.equal(root.dataset.versiondockScrollbarVisibility, 'system');

// Forced modes can start before body construction; system mode leaves no overlay lifecycle.
browserEvents.get('message')({ data: { type: 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE', visibility: 'auto', modernUi: true, reduceMotion: 'on' } });
assert.equal(root.dataset.versiondockScrollbarModernUi, 'true');
assert.equal(root.dataset.versiondockScrollbarReduceMotion, 'on');
browserEvents.get('message')({ data: { type: 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE', visibility: 'system', modernUi: false, reduceMotion: 'off' } });
assert.equal(root.dataset.versiondockScrollbarVisibility, 'system');
assert.equal(root.dataset.versiondockScrollbarModernUi, 'false');
assert.ok(documentEvents.has('DOMContentLoaded'));

const apiBundle = await build({
  entryPoints: ['src/webview/shared/vscodeApi.ts'], write: false,
  platform: 'browser', format: 'iife', globalName: 'appApi', target: 'es2020', minify: true,
});
runInContext(apiBundle.outputFiles[0].text, context);
assert.equal(context.appApi.getVsCodeApi(), api);
assert.equal(context.appApi.getVsCodeApi().getState().saved, true);
assert.equal(acquisitions, 1, 'App must reuse the bootstrap API, preserving its state methods');

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const setting = manifest.contributes.configuration.flatMap(section => Object.entries(section.properties))
  .find(([key]) => key === 'versiondock.scrollbarVisibility')?.[1];
assert.deepEqual(setting.enum, ['system', 'auto', 'visible']);
assert.equal(setting.default, 'system');
for (const name of ['package.nls.json', 'package.nls.zh-cn.json']) {
  const translations = JSON.parse(await readFile(name, 'utf8'));
  for (const key of [setting.description, ...setting.enumDescriptions]) assert.ok(translations[key.slice(1, -1)], `${name}: ${key}`);
}
console.log('Scrollbar configuration, panel lifecycle, production bootstrap and shared API checks passed.');
