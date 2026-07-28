type Target = 'log' | 'commit';

const logHandlers: Array<(event: MessageEvent) => void> = [];
const commitHandlers: Array<(event: MessageEvent) => void> = [];

const originalAdd = EventTarget.prototype.addEventListener.bind(window);
const originalRemove = EventTarget.prototype.removeEventListener.bind(window);
const wrappedHandlers = new WeakMap<object, (event: MessageEvent) => void>();

window.addEventListener = function(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | AddEventListenerOptions,
): void {
  if (type !== 'message' || !listener) {
    return originalAdd(type, listener, options as boolean | undefined);
  }
  // Match native addEventListener semantics: adding the same listener twice
  // for the same message channel must not create duplicate subscriptions.
  if (wrappedHandlers.has(listener as object)) return;
  const handler = typeof listener === 'function'
    ? listener
    : (event: Event) => listener.handleEvent(event);
  wrappedHandlers.set(listener as object, handler as (event: MessageEvent) => void);
  logHandlers.push(handler as (event: MessageEvent) => void);
  commitHandlers.push(handler as (event: MessageEvent) => void);
};

window.removeEventListener = function(
  type: string,
  listener: EventListenerOrEventListenerObject | null,
  options?: boolean | EventListenerOptions,
): void {
  if (type !== 'message' || !listener) {
    return originalRemove(type, listener, options as boolean | undefined);
  }
  const handler = wrappedHandlers.get(listener as object);
  if (!handler) return;
  wrappedHandlers.delete(listener as object);
  const removeFrom = (handlers: Array<(event: MessageEvent) => void>) => {
    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      if (handlers[index] === handler) handlers.splice(index, 1);
    }
  };
  removeFrom(logHandlers);
  removeFrom(commitHandlers);
};

originalAdd('message', (event: Event) => {
  const message = event as MessageEvent;
  const envelope = message.data as { target?: Target; msg?: unknown } | null;
  if (!envelope?.target || !envelope.msg) return;

  const synthetic = new MessageEvent('message', { data: envelope.msg });
  const handlers = envelope.target === 'log' ? logHandlers : commitHandlers;
  handlers.slice().forEach(handler => handler(synthetic));
});
