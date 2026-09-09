import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { matchSpeedSearchItem } from './matchUtils';

export interface UseSpeedSearchOptions<T> {
  items: readonly T[];
  getItemKey: (item: T) => string;
  getItemPath: (item: T) => string;
  getItemName?: (item: T) => string;
  containerRef?: React.RefObject<HTMLElement | null>;
  onActiveChange?: (item: T | null, index: number) => void;
  onEnsureVisible?: (item: T) => void;
  /** 当搜索激活且有匹配项时，传入所有匹配项需要展开的父级路径，以便外层组件临时展开折叠项 */
  onExpandParents?: (matchedItems: T[]) => void;
  /** 当搜索关闭或清空时，通知外层组件恢复搜索前的折叠状态 */
  onRestoreCollapsed?: () => void;
  /** 是否启用全局键入监听（默认为 true） */
  enabled?: boolean;
}

const EMPTY_MATCHES: never[] = [];

export function useSpeedSearch<T>({
  items,
  getItemKey,
  getItemPath,
  getItemName,
  containerRef,
  onActiveChange,
  onEnsureVisible,
  onExpandParents,
  onRestoreCollapsed,
  enabled = true,
}: UseSpeedSearchOptions<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const hadExpandedRef = useRef(false);
  const lastExpandedSignatureRef = useRef<string | null>(null);
  const lastActiveKeyRef = useRef<string | null>(null);

  // 使用 Latest Ref 避免外层传入的匿名回调引起依赖抖动
  const getItemKeyRef = useRef(getItemKey);
  getItemKeyRef.current = getItemKey;

  const getItemPathRef = useRef(getItemPath);
  getItemPathRef.current = getItemPath;

  const getItemNameRef = useRef(getItemName);
  getItemNameRef.current = getItemName;

  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  const onEnsureVisibleRef = useRef(onEnsureVisible);
  onEnsureVisibleRef.current = onEnsureVisible;

  const onExpandParentsRef = useRef(onExpandParents);
  onExpandParentsRef.current = onExpandParents;

  const onRestoreCollapsedRef = useRef(onRestoreCollapsed);
  onRestoreCollapsedRef.current = onRestoreCollapsed;

  // 计算所有匹配项，保持原始物理先后顺序。只依赖 items 和 query
  const matches = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return EMPTY_MATCHES as T[];

    const result: T[] = [];
    const getPath = getItemPathRef.current;
    const getName = getItemNameRef.current;

    for (const item of items) {
      const path = getPath(item);
      const name = getName ? getName(item) : (path.split('/').pop() ?? path);
      const { matched } = matchSpeedSearchItem(path, name, trimmed);
      if (matched) {
        result.push(item);
      }
    }
    return result;
  }, [items, query]);

  const activeItem = useMemo(() => {
    if (activeIndex >= 0 && activeIndex < matches.length) {
      return matches[activeIndex];
    }
    return null;
  }, [matches, activeIndex]);

  const activeKey = useMemo(() => {
    return activeItem ? getItemKeyRef.current(activeItem) : null;
  }, [activeItem]);

  const matchedKeysSet = useMemo(() => {
    if (matches.length === 0) return new Set<string>();
    const set = new Set<string>();
    const getKey = getItemKeyRef.current;
    for (const m of matches) {
      set.add(getKey(m));
    }
    return set;
  }, [matches]);

  // 当 query 或 matches 改变时，更新 activeIndex。仅在实际需要改变时触发更新
  useEffect(() => {
    if (matches.length === 0) {
      setActiveIndex((prev) => (prev === -1 ? prev : -1));
    } else {
      setActiveIndex((prev) => {
        if (prev >= 0 && prev < matches.length) {
          return prev;
        }
        return 0;
      });
    }
  }, [matches]);

  // 临时展开处理：当有匹配项时通知外层展开所有包含匹配项的父级（仅当匹配条目的唯一签名改变时触发，杜绝死循环）
  useEffect(() => {
    if (isOpen && matches.length > 0 && onExpandParentsRef.current) {
      const getKey = getItemKeyRef.current;
      const signature = matches.map((m) => getKey(m)).join(';');
      if (lastExpandedSignatureRef.current !== signature) {
        lastExpandedSignatureRef.current = signature;
        onExpandParentsRef.current(matches);
        hadExpandedRef.current = true;
      }
    } else if ((!isOpen || matches.length === 0) && hadExpandedRef.current && onRestoreCollapsedRef.current) {
      lastExpandedSignatureRef.current = null;
      onRestoreCollapsedRef.current();
      hadExpandedRef.current = false;
    }
  }, [isOpen, matches]);

  // 自动滚动定位当前活跃匹配项。仅当 activeKey 真正改变时触发
  useEffect(() => {
    const currentKey = activeItem ? getItemKeyRef.current(activeItem) : null;
    if (currentKey === lastActiveKeyRef.current) {
      return;
    }
    lastActiveKeyRef.current = currentKey;

    if (activeItem) {
      onActiveChangeRef.current?.(activeItem, activeIndex);
      onEnsureVisibleRef.current?.(activeItem);

      // DOM 滚动定位
      requestAnimationFrame(() => {
        const root = containerRef?.current ?? document;
        if (currentKey) {
            const targetEl = root.querySelector(`[data-speed-search-key="${CSS.escape(currentKey)}"]`);
            if (targetEl) {
              targetEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
            }
        }
      });
    } else {
      // 只有之前有激活项、现在被置空时才通知
      onActiveChangeRef.current?.(null, -1);
    }
  }, [activeItem, activeIndex, containerRef]);

  const openSearch = useCallback((initialQuery = '') => {
    setIsOpen(true);
    setQuery(initialQuery);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
  }, []);

  const closeSearch = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setActiveIndex((prev) => (prev === -1 ? prev : -1));
    lastExpandedSignatureRef.current = null;
    if (hadExpandedRef.current && onRestoreCollapsedRef.current) {
      onRestoreCollapsedRef.current();
      hadExpandedRef.current = false;
    }
  }, []);

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIndex((prev) => (prev + 1) % matches.length);
  }, [matches.length]);

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIndex((prev) => (prev - 1 + matches.length) % matches.length);
  }, [matches.length]);

  // 键盘直接打字监听
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. 优先检测 Cmd+F / Ctrl+F 主动打开/聚焦查找框（不受 defaultPrevented / isComposing 影响）
      const isFindShortcut =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F' || e.code === 'KeyF');

      if (isFindShortcut) {
        e.preventDefault();
        e.stopPropagation();
        openSearch();
        return;
      }

      // 如果正在中文输入法合成中，或者事件已被阻止，不进行后续单字符唤起
      if (e.isComposing || e.defaultPrevented) return;

      // 如果焦点处于可输入控件中，不拦截
      const activeEl = document.activeElement;
      const tagName = activeEl?.tagName?.toLowerCase();
      const isInput =
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        activeEl?.getAttribute('contenteditable') === 'true';

      if (isInput) {
        // 如果是在自己的 speedSearch input 里，只处理 Esc
        if (activeEl === inputRef.current) {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closeSearch();
          }
        }
        return;
      }

      // 如果当前焦点在按钮上，空格或回车用于点击按钮，不拦截
      if (tagName === 'button' && (e.key === ' ' || e.key === 'Enter')) {
        return;
      }

      // 如果已经开启，按 Esc 关闭，或使用上下键/回车导航
      if (isOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeSearch();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) prevMatch();
          else nextMatch();
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopPropagation();
          nextMatch();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          prevMatch();
          return;
        }
      }

      // 如果带有修饰键，不作为字符输入
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }

      // 如果当前界面有打开的上下文菜单，不拦截
      if (document.querySelector('.ctx-menu:not(.hidden), .context-menu, [role="menu"]')) {
        return;
      }

      // 直接键入单字符唤起（字母、数字、标点符号）
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // 排除空格（空格常用于勾选 checkbox 或折叠展开或按钮点击）
        if (e.key === ' ') return;

        e.preventDefault();
        e.stopPropagation();
        openSearch(e.key);
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [enabled, isOpen, openSearch, closeSearch, nextMatch, prevMatch]);

  const isMatched = useCallback(
    (key: string) => {
      return matchedKeysSet.has(key);
    },
    [matchedKeysSet],
  );

  const isActive = useCallback(
    (key: string) => {
      return activeKey === key;
    },
    [activeKey],
  );

  return {
    isOpen,
    query,
    setQuery,
    openSearch,
    closeSearch,
    matches,
    activeItem,
    activeIndex,
    activeKey,
    nextMatch,
    prevMatch,
    isMatched,
    isActive,
    inputRef,
  };
}

export type UseSpeedSearchResult<T = unknown> = ReturnType<typeof useSpeedSearch<T>>;

