import { useRef, useCallback, useEffect } from 'react';

/**
 * Drag-to-resize hook for a panel adjacent to a resize handle.
 * Returns a ref to attach to the panel and a mousedown handler for the handle.
 *
 * @param direction  'right' = dragging handle resizes the panel on its left
 *                   'left'  = dragging handle resizes the panel on its right
 * @param initial    Initial pixel width
 * @param min        Minimum pixel width
 * @param max        Maximum pixel width
 */
export function useResize(
  direction: 'right' | 'left',
  initial: number,
  min: number,
  max: number,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const widthRef = useRef(initial);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const setWidth = useCallback((width: number) => {
    const next = Math.min(max, Math.max(min, width));
    widthRef.current = next;
    if (panelRef.current) {
      panelRef.current.style.width = `${next}px`;
      panelRef.current.style.flex = 'none';
    }
  }, [max, min]);

  // Restore persisted width on mount
  useEffect(() => {
    setWidth(widthRef.current);
    return () => dragCleanupRef.current?.();
  }, [setWidth]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragCleanupRef.current?.();
    const startX = e.clientX;
    const startWidth = panelRef.current?.offsetWidth ?? widthRef.current;

    const onMove = (ev: MouseEvent) => {
      const delta = direction === 'right' ? ev.clientX - startX : startX - ev.clientX;
      setWidth(startWidth + delta);
    };

    const cleanup = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', cleanup);
      window.removeEventListener('blur', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', cleanup);
    window.addEventListener('blur', cleanup);
    dragCleanupRef.current = cleanup;
  }, [direction, setWidth]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const directionDelta = e.key === 'ArrowRight' ? 10 : -10;
    setWidth(widthRef.current + (direction === 'right' ? directionDelta : -directionDelta));
  }, [direction, setWidth]);

  return { panelRef, onMouseDown, onKeyDown };
}
