import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RepoMeta, RepoStatus } from '../../shared/types';
import type { UnpushedCommit } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { AiCommitComposerIcon } from '../../shared/AiCommitComposerIcon';
import { t } from '../../shared/i18n';
import { baseNameFromPath } from '../../shared/pathUtils';
import { nativeCheckboxBorderStyle } from '../../shared/nativeCheckboxStyle';
import { readableAccentColor } from '../../shared/branchColors';
import { CommitMessageHistoryModal } from './CommitMessageHistoryModal';

interface Props {
  message: string;
  messageHistory: string[];
  messageHistoryLoading: boolean;
  repoStatuses: RepoStatus[];
  repoMetas: RepoMeta[];
  amendFlags: Record<string, boolean>;
  unpushedMap: Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>;
  loading: boolean;
  changesViewMode?: 'simplified' | 'changelists' | 'vscode';
  defaultCommitAction?: 'commit' | 'commitAndPush';
  defaultSaveAction?: 'stash' | 'shelve';
  vscodeSelectedRepos?: Set<string>;
  getSelectedFilesForRepo: (repoId: string) => string[];
  onDeselectRepo: (repoId: string) => void;
  onMessageChange: (msg: string) => void;
  onAmendToggle: (repoId: string) => void;
  onCommit: () => void;
  onCommitAndPush: () => void;
  onShelve: () => void;
  onStash: () => void;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onAutopilot: () => void;
  onStopAutopilot: () => void;
  onOpenComposer: () => void;
  onOpenCodeReview: () => void;
  generatingMessage: boolean;
  noVerify?: boolean;
  onNoVerifyChange?: (v: boolean) => void;
}

interface DropdownButtonItem { icon: string; label: string; onSelect: () => void; }
interface DropdownButtonProps {
  enabled: boolean;
  icon: string;
  label: string;
  title?: string;
  disabledTitle?: string;
  variant: 'primary' | 'secondary';
  fullWidth?: boolean;
  dropdownAlign?: 'left' | 'right';
  items: DropdownButtonItem[];
  onMainClick: () => void;
}

const MIN_TEXTAREA_HEIGHT = 52;
const COMMIT_TEXTAREA_HEIGHT_KEY = 'versiondock:commit-message-textarea-height';

function getMaxTextareaHeight(): number {
  return Math.max(MIN_TEXTAREA_HEIGHT, Math.floor(window.innerHeight / 2));
}

function loadPersistedTextareaHeight(): number | null {
  try {
    const raw = localStorage.getItem(COMMIT_TEXTAREA_HEIGHT_KEY);
    if (raw === null) return null;
    const stored = Number(raw);
    if (!Number.isFinite(stored)) return null;
    return Math.min(getMaxTextareaHeight(), Math.max(MIN_TEXTAREA_HEIGHT, stored));
  } catch {
    return null;
  }
}

function persistTextareaHeight(height: number): void {
  try {
    localStorage.setItem(COMMIT_TEXTAREA_HEIGHT_KEY, String(height));
  } catch {
    // The webview may not allow localStorage; in-memory state still works.
  }
}

function DropdownButton({ enabled, icon, label, title, disabledTitle, variant, fullWidth, dropdownAlign = 'left', items, onMainClick }: DropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const [hoverMain, setHoverMain] = useState(false);
  const [hoverChevron, setHoverChevron] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;

  useEffect(() => {
    if (!open) return;
    const outsideHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const blurHandler = () => setOpen(false);
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') setOpen(false);
    };
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    return () => {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
    };
  }, [open]);

  const bg = variant === 'primary'
    ? 'var(--vscode-button-background)'
    : 'var(--vscode-button-secondaryBackground, rgba(100,100,100,0.2))';
  const bgHover = variant === 'primary'
    ? 'var(--vscode-button-hoverBackground)'
    : 'var(--vscode-button-secondaryHoverBackground, rgba(100,100,100,0.35))';
  const fg = variant === 'primary'
    ? 'var(--vscode-button-foreground)'
    : 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))';

  const childStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: bg,
    color: fg,
    border: 'none',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '13px',
    fontFamily: 'var(--vscode-font-family)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    padding: 0,
    outline: 'none',
  };

  const dropItemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '5px 12px', fontSize: '12px', cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
  };

  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', ...(fullWidth ? { width: '100%' } : {}), opacity: enabled ? 1 : 0.4 }}>
      <div style={{
        display: 'flex', flex: fullWidth ? 1 : undefined, ...(fullWidth ? { width: '100%' } : {}),
        border: '1px solid var(--vscode-button-border)',
        borderRadius: '4px',
        overflow: 'hidden',
        backgroundColor: bg,
      }}>
        <button
          style={{ ...childStyle, flex: fullWidth ? 1 : undefined, gap: '6px', padding: '5px 12px', backgroundColor: hoverMain && enabled ? bgHover : bg }}
          disabled={!enabled}
          title={enabled ? (title ?? label) : (disabledTitle ?? '')}
          onClick={() => { if (enabled) onMainClick(); }}
          onMouseEnter={() => setHoverMain(true)}
          onMouseLeave={() => setHoverMain(false)}
        >
          <Codicon name={icon} style={{ fontSize: '14px', flexShrink: 0 }} />
          <span>{label}</span>
        </button>
        {hasItems && (
          <>
            <div style={{ width: '1px', alignSelf: 'stretch', padding: '4px 0', flexShrink: 0, display: 'flex', backgroundColor: 'inherit' }}>
              <div
                style={{
                  flex: 1,
                  backgroundColor: variant === 'primary'
                    ? 'var(--vscode-button-foreground)'
                    : 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
                  opacity: 0.3,
                }}
              />
            </div>
            <button
              style={{ ...childStyle, padding: '5px 7px', backgroundColor: hoverChevron && enabled ? bgHover : bg }}
              disabled={!enabled}
              title={t('More Actions...')}
              onClick={() => { if (enabled) setOpen(o => !o); }}
              onMouseEnter={() => setHoverChevron(true)}
              onMouseLeave={() => setHoverChevron(false)}
            >
              <Codicon name="chevron-down" style={{ fontSize: '12px' }} />
            </button>
          </>
        )}
      </div>
      {open && hasItems && (
        <div style={{
          position: 'absolute', bottom: 'calc(100% + 4px)', ...(dropdownAlign === 'right' ? { right: 0 } : { left: 0 }),
          background: 'var(--vscode-menu-background, var(--vscode-sideBar-background))',
          border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
          borderRadius: '4px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          zIndex: 9999, minWidth: '150px', padding: '3px 0',
        }}>
          {items.map(item => (
            <DropItem key={item.label} icon={item.icon} label={item.label} itemStyle={dropItemStyle} onSelect={() => { item.onSelect(); setOpen(false); }} />
          ))}
        </div>
      )}
    </div>
  );
}

function DropItem({ icon, label, itemStyle, onSelect }: { icon: string; label: string; itemStyle: React.CSSProperties; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{ ...itemStyle, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <Codicon name={icon} style={{ fontSize: '13px', flexShrink: 0 }} />
      {label}
    </div>
  );
}

export function UnifiedCommitForm({
  message, messageHistory, messageHistoryLoading, repoStatuses, repoMetas, amendFlags, unpushedMap,
  loading, changesViewMode, defaultCommitAction = 'commit', defaultSaveAction = 'stash', vscodeSelectedRepos, getSelectedFilesForRepo, onDeselectRepo, onMessageChange, onAmendToggle, onCommit, onCommitAndPush, onShelve, onStash,
  onAutopilot, onStopAutopilot, onOpenComposer, onOpenCodeReview, generatingMessage, noVerify = false, onNoVerifyChange,
}: Props) {
  const metaMap = new Map(repoMetas.map(m => [m.id, m]));

  // In vscode mode count staged files; otherwise count selected files
  const commitTargets = repoStatuses.map(r => {
    const meta = metaMap.get(r.repoId);
    const selectedCount = changesViewMode === 'vscode'
      ? (
        vscodeSelectedRepos === undefined || vscodeSelectedRepos.has(r.repoId)
          ? (meta?.kind === 'svn' ? r.stagedFiles.length + r.unstagedFiles.length : r.stagedFiles.length)
          : 0
      )
      : getSelectedFilesForRepo(r.repoId).length;
    return { ...r, selectedCount };
  }).filter(r => r.selectedCount > 0);

  const canCommit = message.trim().length > 0 && commitTargets.length > 0 && !loading;
  const multiRepo = repoStatuses.length > 1;
  const hasGitRepos = repoStatuses.some(r => metaMap.get(r.repoId)?.kind !== 'svn');
  const hasGitCommitTargets = commitTargets.some(r => metaMap.get(r.repoId)?.kind !== 'svn');
  const showGitActions = commitTargets.length > 0 ? hasGitCommitTargets : hasGitRepos;
  const primaryCommitAction = showGitActions ? defaultCommitAction : 'commit';
  const primarySaveAction = defaultSaveAction;

  const commitLabel = t('Commit');
  const pushLabel = t('Commit & Push');
  const amendTarget = commitTargets.length === 1 ? commitTargets[0] : null;
  const amendRepoId = amendTarget?.repoId;
  const unpushed = amendRepoId ? unpushedMap[amendRepoId] : undefined;
  const showAmend = amendTarget !== null
    && metaMap.get(amendTarget.repoId)?.kind !== 'svn'
    && (
      (amendTarget.branch.aheadBehind?.ahead ?? 0) > 0
      || (
        !amendTarget.branch.upstream
        && !!unpushed
        && !unpushed.loading
        && !unpushed.error
        && unpushed.commits.length > 0
      )
    );
  const amend = amendFlags[amendRepoId ?? ''] ?? false;

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyIndexRef = useRef(-1);
  const historyDraftRef = useRef(message);
  const messageRef = useRef(message);
  const appliedHistoryMessageRef = useRef<string | null>(null);
  const [manualTextareaHeight, setManualTextareaHeight] = useState<number | null>(loadPersistedTextareaHeight);
  const manualTextareaHeightRef = useRef<number | null>(manualTextareaHeight);
  const resizeDragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [resizingTextarea, setResizingTextarea] = useState(false);
  const [messageHistoryOpen, setMessageHistoryOpen] = useState(false);

  messageRef.current = message;

  const updateManualTextareaHeight = useCallback((height: number) => {
    const nextHeight = Math.min(getMaxTextareaHeight(), Math.max(MIN_TEXTAREA_HEIGHT, height));
    manualTextareaHeightRef.current = nextHeight;
    persistTextareaHeight(nextHeight);
    setManualTextareaHeight(nextHeight);
  }, []);

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const manualHeight = manualTextareaHeightRef.current;
    if (manualHeight !== null) {
      updateManualTextareaHeight(manualHeight);
      el.style.overflow = 'auto';
      return;
    }
    el.style.height = 'auto';
    const maxHeight = getMaxTextareaHeight();
    if (el.scrollHeight > maxHeight) {
      el.style.height = `${maxHeight}px`;
      el.style.overflow = 'auto';
    } else {
      el.style.height = `${el.scrollHeight}px`;
      el.style.overflow = 'hidden';
    }
  }, [updateManualTextareaHeight]);

  const startTextareaResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = textareaRef.current;
    if (!el) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeDragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: el.getBoundingClientRect().height,
    };
    setResizingTextarea(true);
  };

  const moveTextareaResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    updateManualTextareaHeight(drag.startHeight + drag.startY - e.clientY);
  };

  const finishTextareaResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    resizeDragRef.current = null;
    setResizingTextarea(false);
  };

  useEffect(() => { resizeTextarea(); }, [message, resizeTextarea]);

  useEffect(() => {
    if (appliedHistoryMessageRef.current === message) {
      appliedHistoryMessageRef.current = null;
      return;
    }
    historyIndexRef.current = -1;
    historyDraftRef.current = message;
  }, [message]);

  useEffect(() => {
    historyIndexRef.current = -1;
    historyDraftRef.current = messageRef.current;
    appliedHistoryMessageRef.current = null;
  }, [messageHistory]);

  const applyMessageFromHistory = useCallback((nextMessage: string) => {
    historyIndexRef.current = -1;
    historyDraftRef.current = nextMessage;
    appliedHistoryMessageRef.current = null;
    onMessageChange(nextMessage);
    setMessageHistoryOpen(false);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextMessage.length, nextMessage.length);
    });
  }, [onMessageChange]);

  useEffect(() => {
    window.addEventListener('resize', resizeTextarea);
    return () => window.removeEventListener('resize', resizeTextarea);
  }, [resizeTextarea]);

  useEffect(() => {
    const id = 'gs-commit-textarea-effects';
    let s = document.getElementById(id) as HTMLStyleElement | null;
    if (!s) {
      s = document.createElement('style');
      s.id = id;
      document.head.appendChild(s);
    }
    s.textContent = `
      @keyframes gs-ai-marquee-run { to { stroke-dashoffset: -100; } }
      @keyframes gs-ai-textarea-breathe {
        0%, 100% { opacity: 0.6; }
        50% { opacity: 0.35; }
      }
      .gs-ai-marquee-border {
        position: absolute;
        inset: 0;
        z-index: 2;
        width: 100%;
        height: 100%;
        overflow: visible;
        border-radius: 3px;
        pointer-events: none;
        box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent);
      }
      .gs-ai-marquee-track {
        x: 0.5px;
        y: 0.5px;
        width: calc(100% - 1px);
        height: calc(100% - 1px);
        rx: 2.5px;
        ry: 2.5px;
        fill: none;
        stroke: url(#gs-ai-marquee-gradient);
        stroke-width: 1px;
        stroke-linecap: round;
        stroke-dasharray: 22 78;
        animation: gs-ai-marquee-run 1.45s linear infinite;
      }
      .gs-commit-textarea[data-generating='true'] {
        position: relative;
        z-index: 1;
        border-color: transparent !important;
        background-clip: padding-box !important;
        animation: gs-ai-textarea-breathe 1.2s ease-in-out infinite;
      }
      .gs-commit-textarea::-webkit-scrollbar {
        width: 6px;
        background: var(--vscode-input-background);
      }
      .gs-commit-textarea::-webkit-scrollbar-track {
        background: var(--vscode-input-background);
        border-radius: 0 3px 3px 0;
      }
      .gs-commit-textarea::-webkit-scrollbar-corner {
        background: var(--vscode-input-background);
      }
      .gs-commit-textarea::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background);
        background-clip: padding-box;
        border: 1px solid var(--vscode-input-background);
        border-radius: 3px;
      }
      .gs-commit-textarea::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
    `;
  }, []);

  return (
    <div style={styles.container}>
      <div
        style={styles.resizeHandle(resizingTextarea)}
        title={t('Drag to resize the commit message area')}
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={startTextareaResize}
        onPointerMove={moveTextareaResize}
        onPointerUp={finishTextareaResize}
        onPointerCancel={finishTextareaResize}
      >
        <span style={styles.resizeGrip(resizingTextarea)} />
      </div>

      {/* Commit targets summary (multi-repo only) */}
      {multiRepo && (
        <div style={styles.targets}>
          {commitTargets.length === 0 ? (
            <span style={styles.noTargets}>{t('No files selected')}</span>
          ) : (
            commitTargets.map(r => {
              const meta = metaMap.get(r.repoId);
              const color = readableAccentColor(meta?.color ?? '#4ec9b0');
              const rawName = meta?.name ?? baseNameFromPath(r.repoId) ?? r.repoId;
              const repoStatus = repoStatuses.find(rs => rs.repoId === r.repoId);
              const wtBranch = meta?.isWorktree && repoStatus
                ? (repoStatus.branch?.detachedTag ?? repoStatus.branch?.detachedHash ?? repoStatus.branch?.name)
                : undefined;
              const displayName = wtBranch
                ? `${baseNameFromPath(meta?.mainWorktreePath) ?? rawName} (${wtBranch})`
                : rawName;
              return (
                <span key={r.repoId} style={styles.targetPill(color)}>
                  <button
                    data-action-btn=""
                    style={styles.pillRemove(color)}
                    title={t('Remove {0} from commit', displayName)}
                    onClick={() => onDeselectRepo(r.repoId)}
                  >
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
                  {displayName}
                  <span style={styles.pillCount}>{r.selectedCount}</span>
                </span>
              );
            })
          )}
        </div>
      )}

      {/* Commit options and shortcut actions */}
      <div style={styles.commitOptionsRow}>
        {showAmend && (
          <label style={styles.amendLabel} title={t('Modify the last commit instead of creating a new one. Rewrites history — avoid on shared branches.')}>
            <input
              type="checkbox"
              checked={amend}
              onChange={() => onAmendToggle(amendRepoId!)}
              style={{ ...nativeCheckboxBorderStyle(), marginRight: '4px' }}
            />
            {t('Amend last commit')}
          </label>
        )}
        {showGitActions && (
          <label style={styles.amendLabel} title={t('Bypass Git pre-commit hooks')}>
            <input
              type="checkbox"
              checked={noVerify}
              onChange={(e) => onNoVerifyChange?.(e.target.checked)}
              style={{ ...nativeCheckboxBorderStyle(), marginRight: '4px' }}
            />
            {t('Bypass hooks (--no-verify)')}
          </label>
        )}
        <div style={styles.commitOptionActions}>
          <button
            data-action-btn=""
            style={styles.commitOptionButton(commitTargets.length === 0 || loading)}
            disabled={commitTargets.length === 0 || loading}
            aria-label={t('AI Review')}
            title={t('Review selected changes with AI')}
            onClick={onOpenCodeReview}
          >
            <Codicon name="search-sparkle" style={{ fontSize: 15 }} />
          </button>
          <button
            data-action-btn=""
            style={styles.commitOptionButton(commitTargets.length === 0 || loading)}
            disabled={commitTargets.length === 0 || loading}
            aria-label={t('AI Split')}
            title={t('Split selected changes into meaningful commits with AI')}
            onClick={onOpenComposer}
          >
            <AiCommitComposerIcon />
          </button>
          <button
            data-action-btn=""
            style={styles.commitOptionButton(loading || generatingMessage)}
            disabled={loading || generatingMessage}
            aria-label={t('Commit message history')}
            title={t('View commit message history')}
            onClick={() => setMessageHistoryOpen(true)}
          >
            <Codicon name="history" style={{ fontSize: 15 }} />
          </button>
        </div>
      </div>

      {/* Message textarea — auto-height until manually resized */}
      <div style={styles.textareaWrap}>
        {generatingMessage && (
          <svg className="gs-ai-marquee-border" aria-hidden="true" focusable="false">
            <defs>
              <linearGradient id="gs-ai-marquee-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--vscode-charts-blue, #3794ff)" />
                <stop offset="55%" stopColor="var(--vscode-charts-purple, #a371f7)" />
                <stop offset="100%" stopColor="var(--vscode-charts-blue, #3794ff)" />
              </linearGradient>
            </defs>
            <rect className="gs-ai-marquee-track" pathLength="100" />
          </svg>
        )}
        <textarea
          ref={textareaRef}
          className="gs-commit-textarea"
          data-generating={generatingMessage ? 'true' : 'false'}
          style={{
            ...styles.textarea(generatingMessage),
            ...(manualTextareaHeight === null ? {} : {
              height: `${manualTextareaHeight}px`,
              overflow: 'auto',
            }),
            scrollbarWidth: 'thin',
            scrollbarColor: `var(--vscode-scrollbarSlider-background) var(--vscode-input-background)`,
            scrollbarGutter: 'stable',
          } as React.CSSProperties}
          value={message}
          onChange={(e) => {
            historyIndexRef.current = -1;
            historyDraftRef.current = e.target.value;
            appliedHistoryMessageRef.current = null;
            onMessageChange(e.target.value);
          }}
          onPointerDown={() => {
            if (historyIndexRef.current < 0) return;
            historyIndexRef.current = -1;
            historyDraftRef.current = message;
          }}
          placeholder={generatingMessage ? t('Generating commit message…') : t('Commit message (Cmd+Enter to commit)')}
          readOnly={generatingMessage}
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && canCommit) {
              e.preventDefault();
              if (primaryCommitAction === 'commitAndPush') onCommitAndPush(); else onCommit();
              return;
            }

            if (
              (e.key === 'ArrowUp' || e.key === 'ArrowDown')
              && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
              && !e.nativeEvent.isComposing
            ) {
              const textarea = e.currentTarget;
              const historyActive = historyIndexRef.current >= 0;
              const selectionCollapsed = textarea.selectionStart === textarea.selectionEnd;
              const caretOnFirstLine = selectionCollapsed && textarea.value.lastIndexOf('\n', textarea.selectionStart - 1) < 0;

              if (e.key === 'ArrowUp' && (historyActive || caretOnFirstLine)) {
                if (!historyActive) historyDraftRef.current = message;
                let nextIndex = historyIndexRef.current + 1;
                while (nextIndex < messageHistory.length && messageHistory[nextIndex] === message) nextIndex += 1;
                if (nextIndex < messageHistory.length) {
                  e.preventDefault();
                  historyIndexRef.current = nextIndex;
                  const nextMessage = messageHistory[nextIndex];
                  appliedHistoryMessageRef.current = nextMessage;
                  onMessageChange(nextMessage);
                  requestAnimationFrame(() => textareaRef.current?.setSelectionRange(0, 0));
                } else if (historyActive) {
                  e.preventDefault();
                }
                return;
              }

              if (e.key === 'ArrowDown' && historyActive) {
                e.preventDefault();
                let nextIndex = historyIndexRef.current - 1;
                while (nextIndex >= 0 && messageHistory[nextIndex] === message) nextIndex -= 1;
                if (nextIndex >= 0) {
                  historyIndexRef.current = nextIndex;
                  const nextMessage = messageHistory[nextIndex];
                  appliedHistoryMessageRef.current = nextMessage;
                  onMessageChange(nextMessage);
                  requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (el) el.setSelectionRange(el.value.length, el.value.length);
                  });
                } else {
                  historyIndexRef.current = -1;
                  const draft = historyDraftRef.current;
                  appliedHistoryMessageRef.current = draft;
                  onMessageChange(draft);
                  requestAnimationFrame(() => {
                    const el = textareaRef.current;
                    if (el) el.setSelectionRange(el.value.length, el.value.length);
                  });
                }
                return;
              }
            }
          }}
        />
        <button
          data-action-btn=""
          style={styles.autopilotBtn(generatingMessage, commitTargets.length === 0 || loading)}
          onClick={generatingMessage ? onStopAutopilot : onAutopilot}
          disabled={!generatingMessage && (commitTargets.length === 0 || loading)}
          title={generatingMessage
            ? t('Stop generating commit message')
            : commitTargets.length === 0
              ? t('No changes to generate a commit message from.')
              : t('Generate commit message with AI')}
        >
          <Codicon name={generatingMessage ? 'stop-circle' : 'sparkle'} style={{ fontSize: '16px' }} />
        </button>
      </div>

      {/* Save and commit actions */}
      <div style={styles.actionsRow}>
        <div style={styles.leftActions}>
          {showGitActions && (
            <DropdownButton
              variant="secondary"
              enabled={!!message.trim() && commitTargets.length > 0}
              icon={primarySaveAction === 'stash' ? 'save' : 'archive'}
              label={primarySaveAction === 'stash' ? t('Stash') : t('Shelve')}
              title={t('Shelve or stash changes')}
              disabledTitle={t('Enter a commit message first')}
              items={primarySaveAction === 'stash'
                ? [
                    { icon: 'save',    label: t('Stash Changes'),  onSelect: onStash  },
                    { icon: 'archive', label: t('Shelve Changes'), onSelect: onShelve },
                  ]
                : [
                    { icon: 'archive', label: t('Shelve Changes'), onSelect: onShelve },
                    { icon: 'save',    label: t('Stash Changes'),  onSelect: onStash  },
                  ]
              }
              onMainClick={primarySaveAction === 'stash' ? onStash : onShelve}
            />
          )}
        </div>

        <div style={styles.rightActions}>
          <DropdownButton
            variant="primary"
            fullWidth
            dropdownAlign="right"
            enabled={canCommit}
            icon={primaryCommitAction === 'commitAndPush' ? 'cloud-upload' : 'check'}
            label={primaryCommitAction === 'commitAndPush' ? pushLabel : commitLabel}
            title={primaryCommitAction === 'commitAndPush' ? t('Commit & Push (Cmd+Enter)') : t('Commit (Cmd+Enter)')}
            disabledTitle={hasGitRepos ? t('Stage files and write a message first') : t('Select files and write a message first')}
            items={!showGitActions ? [] : primaryCommitAction === 'commitAndPush'
              ? [
                  { icon: 'cloud-upload', label: pushLabel,   onSelect: onCommitAndPush },
                  { icon: 'check',        label: commitLabel, onSelect: onCommit        },
                ]
              : [
                  { icon: 'check',        label: commitLabel, onSelect: onCommit        },
                  { icon: 'cloud-upload', label: pushLabel,   onSelect: onCommitAndPush },
                ]
            }
            onMainClick={primaryCommitAction === 'commitAndPush' ? onCommitAndPush : onCommit}
          />
        </div>
      </div>

      {messageHistoryOpen && (
        <CommitMessageHistoryModal
          messages={messageHistory}
          loading={messageHistoryLoading}
          onSelect={applyMessageFromHistory}
          onClose={() => setMessageHistoryOpen(false)}
        />
      )}

    </div>
  );
}

const styles = {
  container: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  },
  resizeHandle: (active: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: '-4px',
    left: 0,
    right: 0,
    height: '9px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'ns-resize',
    touchAction: 'none',
    zIndex: 2,
    background: active ? 'color-mix(in srgb, var(--vscode-focusBorder) 12%, transparent)' : 'transparent',
  }),
  resizeGrip: (active: boolean): React.CSSProperties => ({
    width: '32px',
    height: '2px',
    borderRadius: '2px',
    background: active ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)',
    opacity: 1,
    pointerEvents: 'none',
  }),
  targets: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    minHeight: '20px',
  },
  noTargets: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  },
  targetPill: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    padding: '1px 7px 1px 4px',
    borderRadius: '10px',
    fontSize: '11px',
    lineHeight: '16px',
    background: color + '28',
    color,
    border: `1px solid ${color}60`,
  }),
  pillCount: {
    background: 'rgba(255,255,255,0.15)',
    borderRadius: '7px',
    padding: '0 3px',
    fontSize: '10px',
    minWidth: '14px',
    height: '14px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  pillRemove: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    color,
    cursor: 'pointer',
    padding: '0',
    margin: '0',
    flexShrink: 0,
    lineHeight: 1,
    width: '12px',
    height: '12px',
  }),
  textareaWrap: {
    position: 'relative' as const,
    isolation: 'isolate' as const,
  },
  textarea: (generating: boolean): React.CSSProperties => ({
    display: 'block',
    width: '100%',
    resize: 'none' as const,
    overflow: 'hidden',   // overridden dynamically by resizeTextarea
    minHeight: '52px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    border: generating
      ? '1px solid transparent'
      : '1px solid var(--vscode-input-border, transparent)',
    borderRadius: '3px',
    padding: '5px 28px 5px 7px',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    lineHeight: '1.5',
    outline: 'none',
    boxSizing: 'border-box' as const,
    backgroundClip: 'padding-box',
    cursor: generating ? 'default' : 'text',
  }),
  autopilotBtn: (generating: boolean, disabled: boolean): React.CSSProperties => ({
    position: 'absolute' as const,
    top: '4px',
    right: '4px',
    background: 'transparent',
    border: 'none',
    cursor: disabled && !generating ? 'not-allowed' : 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: disabled && !generating ? 0.35 : 1,
    padding: '2px',
    display: 'flex',
    alignItems: 'center',
    lineHeight: 1,
    zIndex: 2,
  }),
  actionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  },
  leftActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  },
  commitOptionsRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '22px',
  } as React.CSSProperties,
  commitOptionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  } as React.CSSProperties,
  commitOptionButton: (disabled: boolean): React.CSSProperties => ({
    width: '22px',
    height: '22px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
    border: 'none',
    borderRadius: '4px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    boxShadow: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.35 : 1,
    flexShrink: 0,
  }),
  rightActions: {
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  stashBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 8px',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    border: '1px solid var(--vscode-button-border, rgba(128,128,128,0.35))',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    fontFamily: 'var(--vscode-font-family)',
  } as React.CSSProperties,
  amendLabel: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    userSelect: 'none' as const,
  } as React.CSSProperties,
};
