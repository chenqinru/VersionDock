import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Codicon } from '../shared/Codicon';
import { t } from '../shared/i18n';
import type {
  CodeReviewFinding,
  CodeReviewPhase,
  CodeReviewReport,
  CodeReviewSeverity,
  CodeReviewToHostMsg,
  HostToCodeReviewMsg,
} from '../shared/msgTypes';
import { getVsCodeApi } from '../shared/vscodeApi';

type ViewState = 'running' | 'completed' | 'cancelled' | 'error';

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html,body,#root { width: 100%; min-height: 100%; margin: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
  button { font: inherit; }
  .review-shell { min-height: 100%; display: flex; flex-direction: column; background: var(--vscode-editor-background); }
  .review-header { min-height: 68px; display: flex; align-items: center; gap: 14px; padding: 18px 24px 15px; border-bottom: 1px solid var(--vscode-panel-border); flex-shrink: 0; }
  .review-orb { width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; color: #fff; background: linear-gradient(135deg,#7657ff,#2f8fff); flex-shrink: 0; }
  .review-heading { min-width: 0; flex: 1; }
  .review-title { font-size: 18px; font-weight: 700; letter-spacing: -.01em; }
  .review-subtitle { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .review-actions { display: flex; align-items: center; gap: 8px; }
  .review-action { position: relative; isolation: isolate; overflow: hidden; height: 28px; display: inline-flex; align-items: center; gap: 7px; padding: 0 11px; border: none; border-radius: 6px; cursor: pointer; background: linear-gradient(125deg,#7657ff,#2f8fff); color: #fff; font-size: 12px; font-weight: 600; box-shadow: none; transition: filter 140ms ease,transform 140ms ease; }
  .review-action > * { position: relative; z-index: 2; }
  .review-action::after { content: ''; position: absolute; pointer-events: none; opacity: 0; z-index: 1; top: -55%; left: -28%; width: 10%; height: 210%; background: linear-gradient(90deg,transparent,rgba(255,255,255,.96),transparent); box-shadow: 0 0 5px rgba(222,239,255,.7); }
  .review-action:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .review-action:hover::after { animation: review-button-sweep 880ms cubic-bezier(.22,.7,.22,1) both; }
  .review-action:active { filter: brightness(.98); transform: translateY(0); }
  .review-action:focus-visible,.finding-location:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .review-notice { position: relative; min-height: 35px; display: flex; align-items: center; gap: 8px; padding: 0 24px; border-bottom: 1px solid var(--vscode-panel-border); background: color-mix(in srgb,#6d63ff 5%,var(--vscode-editor-background)); overflow: hidden; flex-shrink: 0; font-size: 12px; }
  .review-notice[data-active='true']::after { content: ''; position: absolute; left: 0; bottom: 0; width: 26%; height: 1px; background: linear-gradient(90deg,transparent,#7c5cff,#2f9bff,transparent); animation: review-status-scan 1.7s ease-in-out infinite; }
  .notice-icon { color: #6f73ff; flex-shrink: 0; }
  .notice-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .notice-provider { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
  .review-workspace { width: min(1080px,100%); margin: 0 auto; padding: 24px clamp(18px,4vw,54px) 56px; }
  .stage-rail { position: relative; width: min(720px,100%); display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); margin: 0 auto 28px; }
  .stage-rail::before { content: ''; position: absolute; top: 4px; left: 16.666%; right: 16.666%; height: 1px; background: var(--vscode-panel-border); }
  .stage { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; position: relative; z-index: 1; text-align: center; }
  .stage-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-panel-border); box-shadow: 0 0 0 5px var(--vscode-editor-background); flex-shrink: 0; transition: transform 180ms ease,background 180ms ease; }
  .stage[data-active='true'] { color: var(--vscode-foreground); }
  .stage[data-active='true'] .stage-dot { background: #2f8fff; transform: scale(1.25); }
  .stage[data-done='true'] .stage-dot { background: #7657ff; }
  .stage-label { white-space: nowrap; }
  .thinking { min-height: 260px; display: grid; place-items: center; text-align: center; color: var(--vscode-descriptionForeground); }
  .thinking-core { display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .thinking-lines { width: 130px; display: grid; gap: 6px; }
  .thinking-lines i { display: block; height: 2px; border-radius: 2px; background: linear-gradient(90deg,transparent,#7657ff,#2f8fff,transparent); animation: review-line 1.4s ease-in-out infinite; }
  .thinking-lines i:nth-child(2) { width: 78%; animation-delay: 150ms; }
  .thinking-lines i:nth-child(3) { width: 58%; animation-delay: 300ms; }
  .thinking-meta { font-size: 11px; opacity: .78; }
  .summary { padding-bottom: 22px; border-bottom: 1px solid var(--vscode-panel-border); animation: review-enter 220ms ease-out both; }
  .summary-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .verdict { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .verdict[data-verdict='pass'] { color: var(--vscode-testing-iconPassed,#55c8a9); }
  .verdict[data-verdict='warning'] { color: var(--vscode-editorWarning-foreground,#cca700); }
  .verdict[data-verdict='block'] { color: var(--vscode-errorForeground,#f14c4c); }
  .summary-counts { display: flex; gap: 8px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .summary-text { margin: 10px 0 0; font-size: 15px; line-height: 1.65; }
  .truncate-warning,.stale-warning { margin-top: 12px; display: flex; align-items: center; gap: 6px; color: var(--vscode-editorWarning-foreground,#cca700); font-size: 11px; }
  .findings { margin-top: 8px; }
  .finding { position: relative; padding: 22px 0 22px 18px; border-bottom: 1px solid color-mix(in srgb,var(--vscode-panel-border) 78%,transparent); animation: review-enter 200ms ease-out both; }
  .finding::before { content: ''; position: absolute; left: 0; top: 25px; bottom: 25px; width: 3px; border-radius: 2px; background: var(--severity-color); }
  .finding-head { display: flex; align-items: flex-start; gap: 10px; }
  .severity { flex-shrink: 0; padding: 2px 6px; border-radius: 3px; color: var(--severity-color); background: color-mix(in srgb,var(--severity-color) 12%,transparent); font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .finding-title { font-size: 14px; font-weight: 650; line-height: 1.45; }
  .finding-location { margin: 9px 0 14px; padding: 0; display: inline-flex; align-items: center; gap: 6px; border: none; background: transparent; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 11px; }
  .finding-location:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .finding-grid { display: grid; grid-template-columns: 92px minmax(0,1fr); gap: 8px 14px; max-width: 900px; font-size: 12px; line-height: 1.58; }
  .finding-key { color: var(--vscode-descriptionForeground); }
  .finding-value { white-space: pre-wrap; }
  .cursor { display: inline-block; width: 1.5px; height: 1em; margin-left: 2px; vertical-align: -.1em; background: #7657ff; animation: review-cursor .75s steps(1,end) infinite; }
  .empty,.error-state { min-height: 280px; display: grid; place-items: center; text-align: center; }
  .empty-inner,.error-inner { max-width: 560px; }
  .empty-icon { color: var(--vscode-testing-iconPassed,#55c8a9); font-size: 30px; }
  .empty h2,.error-state h2 { margin: 12px 0 8px; font-size: 18px; }
  .empty p,.error-state p { margin: 0; color: var(--vscode-descriptionForeground); line-height: 1.6; }
  @keyframes review-status-scan { from { transform:translateX(-110%); } to { transform:translateX(410%); } }
  @keyframes review-button-sweep { 0% { transform:translate3d(0,0,0) skewX(-22deg); opacity:0; } 22% { opacity:.35; } 48% { opacity:1; } 100% { transform:translate3d(1550%,0,0) skewX(-22deg); opacity:0; } }
  @keyframes review-line { 0%,100% { opacity:.25; transform:scaleX(.72); } 50% { opacity:1; transform:scaleX(1); } }
  @keyframes review-enter { from { opacity:0; transform:translateY(7px); } to { opacity:1; transform:translateY(0); } }
  @keyframes review-cursor { 0%,48% { opacity:1; } 49%,100% { opacity:0; } }
  @media (max-width: 650px) { .review-header,.review-notice { padding-inline:14px; } .review-workspace { padding-inline:16px; } .review-action span,.notice-provider { display:none; } .finding-grid { grid-template-columns:1fr; gap:4px; } .finding-key { margin-top:6px; } .stage-label { display:none; } }
  @media (prefers-reduced-motion: reduce) {
    .review-action,.stage-dot { transition:none !important; }
    .review-action:hover { transform:none; }
    .review-action:hover::after,.summary,.finding { animation:none !important; }
  }
`;

const severityColor: Record<CodeReviewSeverity, string> = {
  critical: 'var(--vscode-errorForeground,#f14c4c)',
  high: 'var(--vscode-editorError-foreground,#f14c4c)',
  medium: 'var(--vscode-editorWarning-foreground,#cca700)',
  low: 'var(--vscode-editorInfo-foreground,#3794ff)',
};

function send(message: CodeReviewToHostMsg): void { getVsCodeApi().postMessage(message); }
function delay(ms: number): Promise<void> { return new Promise(resolve => window.setTimeout(resolve, ms)); }

function emptyFinding(finding: CodeReviewFinding): CodeReviewFinding {
  return { ...finding, title: '', evidence: '', impact: '', suggestion: '' };
}

function App() {
  const [viewState, setViewState] = useState<ViewState>('running');
  const [phase, setPhase] = useState<CodeReviewPhase>('scanning');
  const [detail, setDetail] = useState(t('Preparing AI Code Review…'));
  const [fileCount, setFileCount] = useState(0);
  const [repositoryCount, setRepositoryCount] = useState(0);
  const [streamCharCount, setStreamCharCount] = useState(0);
  const [provider, setProvider] = useState('');
  const [report, setReport] = useState<CodeReviewReport>();
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [staleFinding, setStaleFinding] = useState<CodeReviewFinding>();
  const typingRun = useRef(0);

  useEffect(() => {
    const typingController = typingRun;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const listener = (event: MessageEvent<HostToCodeReviewMsg>) => {
      const message = event.data;
      if (message.type === 'CODE_REVIEW_PHASE') {
        setViewState('running');
        setPhase(message.phase);
        setDetail(message.detail);
        if (message.fileCount !== undefined) setFileCount(message.fileCount);
        if (message.repositoryCount !== undefined) setRepositoryCount(message.repositoryCount);
        if (message.streamCharCount !== undefined) setStreamCharCount(message.streamCharCount);
        if (message.truncated !== undefined) setTruncated(message.truncated);
        setError('');
        setStaleFinding(undefined);
      } else if (message.type === 'CODE_REVIEW_RESULT') {
        setViewState('completed');
        setPhase('completed');
        setDetail(t('Review completed'));
        setTruncated(message.truncated);
        setProvider([message.provider, message.model].filter(Boolean).join(' · '));
        void typeReport(message.report);
      } else if (message.type === 'CODE_REVIEW_CANCELLED') {
        typingRun.current++;
        setViewState('cancelled');
        setDetail(t('Review stopped'));
      } else if (message.type === 'CODE_REVIEW_ERROR') {
        typingRun.current++;
        setViewState('error');
        setPhase('error');
        setError(message.error);
        setDetail(t('AI Code Review failed'));
      } else if (message.type === 'CODE_REVIEW_STALE') {
        setStaleFinding(message.finding);
      }
    };
    window.addEventListener('message', listener);
    send({ type: 'CODE_REVIEW_READY' });
    return () => { typingController.current++; window.removeEventListener('message', listener); style.remove(); };
  }, []);

  async function typeReport(next: CodeReviewReport) {
    const run = ++typingRun.current;
    setReport({ ...next, summary: '', findings: next.findings.map(emptyFinding) });
    const typeField = async (value: string, update: (visible: string) => void) => {
      const step = Math.max(1, Math.ceil(value.length / 180));
      for (let length = step; length <= value.length + step; length += step) {
        if (typingRun.current !== run) return false;
        update(value.slice(0, Math.min(length, value.length)));
        await delay(8);
      }
      return true;
    };
    if (!await typeField(next.summary, value => setReport(current => current ? { ...current, summary: value } : current))) return;
    for (let index = 0; index < next.findings.length; index++) {
      for (const field of ['title', 'evidence', 'impact', 'suggestion'] as const) {
        const ok = await typeField(next.findings[index][field], value => setReport(current => current ? {
          ...current,
          findings: current.findings.map((finding, findingIndex) => findingIndex === index ? { ...finding, [field]: value } : finding),
        } : current));
        if (!ok) return;
      }
    }
  }

  const running = viewState === 'running';
  const stageIndex = phase === 'scanning' ? 0 : phase === 'analyzing' ? 1 : 2;
  const counts = useMemo(() => {
    const result: Partial<Record<CodeReviewSeverity, number>> = {};
    for (const finding of report?.findings ?? []) result[finding.severity] = (result[finding.severity] ?? 0) + 1;
    return result;
  }, [report]);

  const action = () => running ? send({ type: 'CODE_REVIEW_CANCEL' }) : send({ type: 'CODE_REVIEW_RERUN' });

  return (
    <main className="review-shell" data-running={running ? 'true' : 'false'}>
      <header className="review-header">
        <div className="review-orb" aria-hidden="true"><Codicon name="search-sparkle" style={{ fontSize: 19 }} /></div>
        <div className="review-heading">
          <div className="review-title">{t('AI Code Review')}</div>
          <div className="review-subtitle">
            {fileCount > 0 ? t('Reviewing {0} change source(s) across {1} repository/repositories', fileCount, repositoryCount) : t('Review selected changes with AI')}
          </div>
        </div>
        <div className="review-actions">
          <button className="review-action" onClick={action}>
            <Codicon name={running ? 'stop-circle' : 'refresh'} />
            <span>{running ? t('Stop') : t('Review again')}</span>
          </button>
        </div>
      </header>
      <div className="review-notice" data-active={running ? 'true' : 'false'} role="status" aria-live="polite">
        <Codicon
          className="notice-icon"
          name={viewState === 'error' ? 'error' : viewState === 'cancelled' ? 'debug-stop' : running ? 'loading~spin' : 'check'}
          style={viewState === 'error' ? { color: 'var(--vscode-errorForeground)' } : undefined}
        />
        <span className="notice-text">{detail}</span>
        {provider && <span className="notice-provider">{provider}</span>}
      </div>
      <section className="review-workspace">
        <div className="stage-rail" aria-label={t('Review progress')}>
          {[t('Scan changes'), t('Analyze risks'), t('Validate findings')].map((label, index) => (
            <div className="stage" key={label} data-active={running && index === stageIndex ? 'true' : 'false'} data-done={!running || index < stageIndex ? 'true' : 'false'}>
              <span className="stage-dot" /><span className="stage-label">{label}</span>
            </div>
          ))}
        </div>

        {running && (
          <div className="thinking">
            <div className="thinking-core">
              <div className="thinking-lines" aria-hidden="true"><i /><i /><i /></div>
              <div>{detail}</div>
              <div className="thinking-meta">
                {fileCount > 0 ? t('Reviewing {0} change source(s) across {1} repository/repositories', fileCount, repositoryCount) : t('Reading selected diffs and building code anchors')}
                {streamCharCount > 0 ? ` · ${t('AI response activity: {0} characters', streamCharCount)}` : ''}
              </div>
            </div>
          </div>
        )}

        {viewState === 'error' && (
          <div className="error-state"><div className="error-inner"><Codicon name="error" style={{ color: 'var(--vscode-errorForeground)', fontSize: 28 }} /><h2>{t('AI Code Review failed')}</h2><p>{error}</p></div></div>
        )}
        {viewState === 'cancelled' && (
          <div className="error-state"><div className="error-inner"><Codicon name="debug-stop" style={{ fontSize: 28 }} /><h2>{t('Review stopped')}</h2><p>{t('Run the review again when you are ready.')}</p></div></div>
        )}

        {viewState === 'completed' && report && (
          <>
            <section className="summary">
              <div className="summary-top">
                <span className="verdict" data-verdict={report.verdict}>{t(report.verdict === 'pass' ? 'Pass' : report.verdict === 'warning' ? 'Needs attention' : 'Changes requested')}</span>
                <span className="summary-counts">
                  {(['critical','high','medium','low'] as CodeReviewSeverity[]).filter(key => counts[key]).map(key => <span key={key}>{t(key)} {counts[key]}</span>)}
                </span>
              </div>
              <p className="summary-text">{report.summary}<span className="cursor" aria-hidden="true" /></p>
              {truncated && <div className="truncate-warning"><Codicon name="warning" />{t('Some oversized changes were truncated. The review covers visible evidence only.')}</div>}
              {staleFinding && <div className="stale-warning"><Codicon name="history" />{t('The reviewed diff has changed. Run the review again before opening this location.')}</div>}
            </section>
            {report.findings.length === 0 ? (
              <div className="empty"><div className="empty-inner"><Codicon name="pass-filled" className="empty-icon" /><h2>{t('No actionable issues found')}</h2><p>{t('The visible selected changes passed this AI review. This does not replace tests or human review.')}</p></div></div>
            ) : (
              <section className="findings" aria-label={t('Code review findings')}>
                {report.findings.map((finding, index) => (
                  <article className="finding" key={finding.id} style={{ '--severity-color': severityColor[finding.severity], animationDelay: `${Math.min(index * 45, 250)}ms` } as React.CSSProperties}>
                    <div className="finding-head"><span className="severity">{t(finding.severity)}</span><span className="finding-title">{finding.title || ' '}</span></div>
                    <button className="finding-location" onClick={() => { setStaleFinding(undefined); send({ type: 'CODE_REVIEW_OPEN_DIFF', finding }); }}>
                      <Codicon name="go-to-file" />
                      <span>{finding.repoName} · {finding.filePath}{finding.newLine ? `:${finding.newLine}` : finding.oldLine ? `:${finding.oldLine}` : ''} · {t(finding.source === 'staged' ? 'Staged' : 'Working tree')}</span>
                    </button>
                    <div className="finding-grid">
                      <span className="finding-key">{t('Evidence')}</span><span className="finding-value">{finding.evidence || ' '}</span>
                      <span className="finding-key">{t('Impact')}</span><span className="finding-value">{finding.impact || ' '}</span>
                      <span className="finding-key">{t('Suggestion')}</span><span className="finding-value">{finding.suggestion || ' '}</span>
                    </div>
                  </article>
                ))}
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}

window.addEventListener('error', event => send({ type: 'CODE_REVIEW_WEBVIEW_ERROR', message: event.message, stack: event.error?.stack }));
window.addEventListener('unhandledrejection', event => send({ type: 'CODE_REVIEW_WEBVIEW_ERROR', message: String(event.reason), stack: event.reason?.stack }));

createRoot(document.getElementById('root')!).render(<App />);
