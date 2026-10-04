/// <reference lib="dom" />

/** Self-contained: serialized into every Webview, including standalone HTML pages. */
export function initializeWebviewScrollbars(): void {
  interface Axis {
    track: HTMLDivElement;
    thumb: HTMLDivElement;
    length: number;
    thumbLength: number;
    maximum: number;
    drag: { pointerId: number; coordinate: number; position: number } | null;
  }
  interface Scroller {
    element: HTMLElement;
    viewport: HTMLDivElement;
    vertical: Axis;
    horizontal: Axis;
    timer: ReturnType<typeof setTimeout> | null;
    active: boolean;
    content: Element | null;
  }
  const root = document.documentElement;
  const scrollers = new Map<HTMLElement, Scroller>();
  const owners = new WeakMap<Element, Scroller>();
  const pressed = new Set<Scroller>();
  const hovered = new Set<Scroller>();
  let focused: Scroller | null = null;
  let layer: HTMLDivElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let mutationObserver: MutationObserver | null = null;
  let frame: number | null = null;
  const resizeTargets = new Map<Element, number>();
  const pendingScan = new Set<Element>();
  const pendingSelf = new Set<Element>();
  const hostWindow = window as Window & {
    acquireVsCodeApi?: () => { postMessage(message: unknown): void };
    __VERSIONDOCK_VSCODE_API__?: { postMessage(message: unknown): void };
  };
  if (!hostWindow.__VERSIONDOCK_VSCODE_API__ && hostWindow.acquireVsCodeApi) {
    hostWindow.__VERSIONDOCK_VSCODE_API__ = hostWindow.acquireVsCodeApi();
  }
  const enabled = () => root.dataset.versiondockScrollbarVisibility !== 'system';
  const observeResize = (element: Element) => {
    const count = resizeTargets.get(element) ?? 0;
    if (count === 0) resizeObserver?.observe(element);
    resizeTargets.set(element, count + 1);
  };
  const unobserveResize = (element: Element) => {
    const count = resizeTargets.get(element) ?? 0;
    if (count <= 1) {
      resizeObserver?.unobserve(element);
      resizeTargets.delete(element);
    } else resizeTargets.set(element, count - 1);
  };
  const isRoot = (element: HTMLElement) => element === document.scrollingElement;
  const clientSize = (element: HTMLElement, vertical: boolean) => isRoot(element)
    ? vertical ? window.innerHeight : window.innerWidth
    : vertical ? element.clientHeight : element.clientWidth;
  const maximum = (element: HTMLElement, vertical: boolean) => Math.max(0,
    (vertical ? element.scrollHeight : element.scrollWidth) - clientSize(element, vertical));
  const position = (element: HTMLElement, vertical: boolean) => vertical ? element.scrollTop
    : getComputedStyle(element).direction === 'rtl' ? maximum(element, false) + element.scrollLeft : element.scrollLeft;
  const setPosition = (element: HTMLElement, vertical: boolean, value: number) => {
    const bounded = Math.max(0, Math.min(maximum(element, vertical), value));
    if (vertical) element.scrollTop = bounded;
    else element.scrollLeft = getComputedStyle(element).direction === 'rtl' ? bounded - maximum(element, false) : bounded;
  };
  const show = (record: Scroller) => {
    const visible = root.dataset.versiondockScrollbarVisibility === 'visible'
      || hovered.has(record) || focused === record || pressed.has(record) || record.active;
    for (const axis of [record.vertical, record.horizontal]) {
      axis.track.style.opacity = visible ? '1' : '0';
      axis.track.style.pointerEvents = visible ? 'auto' : 'none';
      axis.track.toggleAttribute('data-versiondock-scrollbar-active', visible);
      axis.thumb.tabIndex = visible ? 0 : -1;
    }
  };
  const cancelActivity = (record: Scroller) => {
    if (record.timer !== null) clearTimeout(record.timer);
    record.timer = null;
    record.active = false;
  };
  const revealOnScroll = (record: Scroller) => {
    cancelActivity(record);
    record.active = true;
    show(record);
    record.timer = setTimeout(() => {
      record.timer = null;
      record.active = false;
      show(record);
    }, 500);
  };
  const ownerOf = (target: EventTarget | null): Scroller | null => {
    let element = target instanceof Element ? target : null;
    while (element) {
      const record = owners.get(element) ?? (element instanceof HTMLElement ? scrollers.get(element) : undefined);
      if (record) return record;
      element = element.parentElement;
    }
    return null;
  };
  const updateHover = (target: EventTarget | null) => {
    const next = new Set<Scroller>();
    const first = enabled() ? ownerOf(target) : null;
    if (first) {
      next.add(first);
      for (let element = first.element.parentElement; element; element = element.parentElement) {
        const parent = scrollers.get(element);
        if (parent) next.add(parent);
      }
    }
    for (const previous of hovered) {
      if (next.has(previous)) continue;
      hovered.delete(previous);
      if (!pressed.has(previous)) cancelActivity(previous);
      show(previous);
    }
    for (const record of next) {
      if (hovered.has(record)) continue;
      hovered.add(record);
      show(record);
    }
  };
  const updateFocus = (target: EventTarget | null) => {
    const previous = focused;
    focused = enabled() && target instanceof Element && target.matches(':focus-visible') ? ownerOf(target) : null;
    if (previous) show(previous);
    if (focused) show(focused);
  };
  const clientRect = (element: HTMLElement) => {
    if (isRoot(element)) return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight };
    const rect = element.getBoundingClientRect();
    const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
    const left = rect.left + element.clientLeft * scaleX;
    const top = rect.top + element.clientTop * scaleY;
    const width = element.clientWidth * scaleX;
    const height = element.clientHeight * scaleY;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  const update = (record: Scroller) => {
    const { element, viewport } = record;
    viewport.dataset.versiondockScrollbarFor = element.id;
    const content = element.firstElementChild;
    if (content !== record.content) {
      if (record.content) unobserveResize(record.content);
      record.content = content;
      if (content) observeResize(content);
    }
    const style = getComputedStyle(element);
    const rect = clientRect(element);
    const vertical = maximum(element, true) > 1 && (isRoot(element) || /auto|scroll/.test(style.overflowY));
    const horizontal = maximum(element, false) > 1 && (isRoot(element) || /auto|scroll/.test(style.overflowX));
    if ((!vertical && !horizontal) || rect.width <= 0 || rect.height <= 0 || style.visibility === 'hidden') {
      viewport.style.display = 'none';
      return;
    }
    // Clip to all ancestors that clip content, including nested scrolling panels.
    let left = Math.max(0, rect.left);
    let top = Math.max(0, rect.top);
    let right = Math.min(window.innerWidth, rect.right);
    let bottom = Math.min(window.innerHeight, rect.bottom);
    let zIndex = Number.parseInt(style.zIndex, 10) || 0;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = getComputedStyle(ancestor);
      zIndex = Math.max(zIndex, Number.parseInt(ancestorStyle.zIndex, 10) || 0);
      const box = clientRect(ancestor);
      if (/auto|scroll|hidden|clip/.test(ancestorStyle.overflowX)) {
        left = Math.max(left, box.left);
        right = Math.min(right, box.right);
      }
      if (/auto|scroll|hidden|clip/.test(ancestorStyle.overflowY)) {
        top = Math.max(top, box.top);
        bottom = Math.min(bottom, box.bottom);
      }
    }
    if (right <= left || bottom <= top) {
      viewport.style.display = 'none';
      return;
    }
    viewport.style.display = 'block';
    Object.assign(viewport.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
      zIndex: String(zIndex + 1),
      clipPath: `inset(${top - rect.top}px ${rect.right - right}px ${rect.bottom - bottom}px ${left - rect.left}px)` });
    const size = Number.parseFloat(getComputedStyle(root).getPropertyValue('--versiondock-scrollbar-size')) || 10;
    for (const [axis, isVertical, needed] of [
      [record.vertical, true, vertical], [record.horizontal, false, horizontal],
    ] as const) {
      axis.length = Math.max(0, (isVertical ? rect.height : rect.width) - ((isVertical ? horizontal : vertical) ? size : 0));
      axis.maximum = maximum(element, isVertical);
      const content = isVertical ? element.scrollHeight : element.scrollWidth;
      axis.thumbLength = Math.min(axis.length, Math.max(20, axis.length * clientSize(element, isVertical) / Math.max(1, content)));
      const offset = Math.max(0, Math.min(axis.length - axis.thumbLength,
        position(element, isVertical) / Math.max(1, axis.maximum) * (axis.length - axis.thumbLength)));
      axis.track.style.display = needed ? 'block' : 'none';
      if (isVertical) {
        Object.assign(axis.track.style, { top: '0', right: '0', height: `${axis.length}px` });
        Object.assign(axis.thumb.style, { top: `${offset}px`, height: `${axis.thumbLength}px` });
      } else {
        Object.assign(axis.track.style, { left: '0', bottom: '0', width: `${axis.length}px` });
        Object.assign(axis.thumb.style, { left: `${offset}px`, width: `${axis.thumbLength}px` });
      }
      // A global overlay must not draw over a modal, sticky header or another pane.
      const sampleX = isVertical ? rect.right - size / 2 : (left + right) / 2;
      const sampleY = isVertical ? (top + bottom) / 2 : rect.bottom - size / 2;
      const hit = document.elementsFromPoint(sampleX, sampleY).find(node => !layer?.contains(node));
      let obscured = hit ? !element.contains(hit) : true;
      if (isRoot(element) && hit) {
        for (let node: Element | null = hit; node && node !== element; node = node.parentElement) {
          if (getComputedStyle(node).position === 'fixed') { obscured = true; break; }
        }
      }
      if (obscured) axis.track.style.display = 'none';
      axis.thumb.setAttribute('aria-valuemax', String(Math.round(axis.maximum)));
      axis.thumb.setAttribute('aria-valuenow', String(Math.round(position(element, isVertical))));
      if (element.id) axis.thumb.setAttribute('aria-controls', element.id);
      else axis.thumb.removeAttribute('aria-controls');
    }
    show(record);
  };
  const remove = (record: Scroller) => {
    cancelActivity(record);
    unobserveResize(record.element);
    if (record.content) unobserveResize(record.content);
    record.viewport.remove();
    scrollers.delete(record.element);
    pressed.delete(record);
    hovered.delete(record);
    if (focused === record) focused = null;
  };
  const create = (element: HTMLElement) => {
    if (!layer || scrollers.has(element) || element.dataset.versiondockNativeScrollbar === 'hidden') return;
    const viewport = document.createElement('div');
    viewport.setAttribute('data-versiondock-scrollbar-viewport', '');
    if (element.id) viewport.dataset.versiondockScrollbarFor = element.id;
    const axis = (vertical: boolean): Axis => {
      const track = document.createElement('div');
      track.dataset.versiondockOverlayScrollbar = vertical ? 'vertical' : 'horizontal';
      const thumb = document.createElement('div');
      thumb.setAttribute('role', 'scrollbar');
      thumb.setAttribute('aria-orientation', vertical ? 'vertical' : 'horizontal');
      const chinese = root.lang.toLowerCase().startsWith('zh');
      thumb.setAttribute('aria-label', chinese ? vertical ? '垂直滚动条' : '水平滚动条' : vertical ? 'Vertical scrollbar' : 'Horizontal scrollbar');
      thumb.setAttribute('aria-valuemin', '0');
      if (element.id) thumb.setAttribute('aria-controls', element.id);
      track.appendChild(thumb);
      viewport.appendChild(track);
      return { track, thumb, length: 0, thumbLength: 0, maximum: 0, drag: null };
    };
    const record: Scroller = { element, viewport, vertical: axis(true), horizontal: axis(false), timer: null, active: false, content: null };
    scrollers.set(element, record);
    owners.set(viewport, record);
    layer.appendChild(viewport);
    observeResize(element);
    for (const [bar, vertical] of [[record.vertical, true], [record.horizontal, false]] as const) {
      bar.track.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        cancelActivity(record);
        pressed.add(record);
        if (event.target !== bar.thumb) {
          const rect = bar.track.getBoundingClientRect();
          const coordinate = vertical ? event.clientY - rect.top : event.clientX - rect.left;
          setPosition(element, vertical, (coordinate - bar.thumbLength / 2) / Math.max(1, bar.length - bar.thumbLength) * bar.maximum);
        }
        bar.drag = { pointerId: event.pointerId, coordinate: vertical ? event.clientY : event.clientX, position: position(element, vertical) };
        bar.track.setPointerCapture(event.pointerId);
        show(record);
      });
      bar.track.addEventListener('pointermove', event => {
        if (bar.drag?.pointerId !== event.pointerId) return;
        const delta = (vertical ? event.clientY : event.clientX) - bar.drag.coordinate;
        setPosition(element, vertical, bar.drag.position + delta / Math.max(1, bar.length - bar.thumbLength) * bar.maximum);
      });
      const release = (event: PointerEvent) => {
        if (bar.drag?.pointerId !== event.pointerId) return;
        bar.drag = null;
        if (bar.track.hasPointerCapture(event.pointerId)) bar.track.releasePointerCapture(event.pointerId);
        pressed.delete(record);
        cancelActivity(record);
        updateHover(document.elementFromPoint(event.clientX, event.clientY));
        show(record);
      };
      bar.track.addEventListener('pointerup', release);
      bar.track.addEventListener('pointercancel', release);
      bar.track.addEventListener('lostpointercapture', event => {
        if (bar.drag?.pointerId !== event.pointerId) return;
        bar.drag = null;
        pressed.delete(record);
        show(record);
      });
      bar.thumb.addEventListener('keydown', event => {
        let next = position(element, vertical);
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = maximum(element, vertical);
        else if (event.key === 'PageUp') next -= clientSize(element, vertical);
        else if (event.key === 'PageDown') next += clientSize(element, vertical);
        else if (event.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next -= 40;
        else if (event.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next += 40;
        else return;
        event.preventDefault();
        setPosition(element, vertical, next);
      });
      bar.track.addEventListener('wheel', event => {
        if (event.ctrlKey) return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? clientSize(element, vertical) : 1;
        element.scrollBy({ left: (event.shiftKey ? event.deltaY : event.deltaX) * unit,
          top: (event.shiftKey ? 0 : event.deltaY) * unit });
      }, { passive: false });
    }
    update(record);
  };
  const inspect = (element: Element) => {
    if (!(element instanceof HTMLElement) || layer?.contains(element)) return;
    const style = getComputedStyle(element);
    if (isRoot(element) || /auto|scroll/.test(style.overflowX) || /auto|scroll/.test(style.overflowY)) create(element);
  };
  const scan = (subtree: Element) => {
    if (layer?.contains(subtree)) return;
    inspect(subtree);
    subtree.querySelectorAll('*').forEach(inspect);
  };
  const schedule = () => {
    if (!enabled() || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      for (const subtree of pendingScan) if (subtree.isConnected) scan(subtree);
      pendingScan.clear();
      for (const element of pendingSelf) if (element.isConnected) inspect(element);
      pendingSelf.clear();
      for (const record of scrollers.values()) {
        if (!record.element.isConnected || record.element.dataset.versiondockNativeScrollbar === 'hidden') remove(record);
        else update(record);
      }
      const hoverPath = document.querySelectorAll(':hover');
      updateHover(hoverPath.item(hoverPath.length - 1));
      updateFocus(document.activeElement);
    });
  };
  const stop = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pendingScan.clear();
    pendingSelf.clear();
    mutationObserver?.disconnect();
    resizeObserver?.disconnect();
    mutationObserver = null;
    resizeObserver = null;
    for (const record of scrollers.values()) remove(record);
    resizeTargets.clear();
    layer?.remove();
    layer = null;
    hovered.clear();
    focused = null;
    pressed.clear();
  };
  const start = () => {
    if (!enabled() || !document.body) return;
    if (!layer) {
      layer = document.createElement('div');
      layer.setAttribute('data-versiondock-scrollbar-layer', '');
      document.body.appendChild(layer);
      resizeObserver = new ResizeObserver(schedule);
      mutationObserver = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (layer?.contains(mutation.target)) continue;
          if (mutation.type === 'attributes' && mutation.target instanceof Element) {
            if (mutation.attributeName === 'class') pendingScan.add(mutation.target);
            else pendingSelf.add(mutation.target);
          }
          mutation.addedNodes.forEach(added => { if (added instanceof Element) pendingScan.add(added); });
        }
        if (mutations.some(mutation => !layer?.contains(mutation.target))) schedule();
      });
      mutationObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'style', 'id', 'hidden', 'open', 'data-versiondock-native-scrollbar'] });
    }
    pendingScan.add(root);
    schedule();
  };
  window.addEventListener('message', event => {
    if (event.data?.type !== 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE') return;
    const value: unknown = event.data.visibility;
    root.dataset.versiondockScrollbarVisibility = value === 'auto' || value === 'visible' ? value : 'system';
    root.dataset.versiondockScrollbarModernUi = String(event.data.modernUi === true);
    const reduceMotion: unknown = event.data.reduceMotion;
    root.dataset.versiondockScrollbarReduceMotion = reduceMotion === 'on' || reduceMotion === 'off' ? reduceMotion : 'auto';
    if (enabled()) start();
    else stop();
    window.dispatchEvent(new Event('versiondock-scrollbar-appearance-changed'));
  });
  document.addEventListener('pointerover', event => { updateHover(event.target); schedule(); }, true);
  document.addEventListener('pointerout', event => updateHover(event.relatedTarget), true);
  document.addEventListener('focusin', event => { updateFocus(event.target); schedule(); }, true);
  document.addEventListener('focusout', event => updateFocus(event.relatedTarget), true);
  document.addEventListener('input', schedule, true);
  document.addEventListener('load', schedule, true);
  document.addEventListener('scroll', event => {
    if (!enabled()) return;
    const element = event.target instanceof HTMLElement ? event.target : document.scrollingElement;
    const record = element instanceof HTMLElement ? scrollers.get(element) : undefined;
    if (record) revealOnScroll(record);
    schedule();
  }, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('message', schedule);
  window.addEventListener('blur', () => {
    const records = Array.from(pressed);
    pressed.clear();
    updateHover(null);
    updateFocus(null);
    for (const record of records) {
      cancelActivity(record);
      for (const bar of [record.vertical, record.horizontal]) {
        const pointerId = bar.drag?.pointerId;
        bar.drag = null;
        if (pointerId !== undefined && bar.track.hasPointerCapture(pointerId)) bar.track.releasePointerCapture(pointerId);
      }
      show(record);
    }
  });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', start);
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
  hostWindow.__VERSIONDOCK_VSCODE_API__?.postMessage({ type: 'VERSIONDOCK_SCROLLBAR_READY' });
}
