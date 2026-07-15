import * as vscode from 'vscode';
import type { BlameLine } from '../git/BlameService';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { t } from '../utils/l10n';

const GHOST_MAX_SUMMARY_LEN = 72;
const CONTEXT_KEY = 'versiondock.annotationsVisible';
const CONFIG_SECTION = 'versiondock';
const GIT_ANNOTATIONS_ENABLED = 'gitAnnotations.enabled';
const GIT_GHOST_TEXT_ENABLED = 'gitGhostText.enabled';
const NOT_COMMITTED_LABEL_FALLBACK_LENGTH = 13;

// 16-slot palette. Dynamic annotation decoration types carry the rendered label
// in `before.contentText`; this is more reliable than per-line render overrides.
const NUM_PALETTE = 16;
const PALETTE_HUES = Array.from({ length: NUM_PALETTE }, (_, i) => Math.round(i * 360 / NUM_PALETTE));

function formatRelativeDate(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffMonths = Math.floor(diffDays / 30.44);
  const diffYears = Math.floor(diffDays / 365.25);

  if (diffYears >= 1) return diffYears === 1 ? t('{0} year ago', diffYears) : t('{0} years ago', diffYears);
  if (diffMonths >= 1) return diffMonths === 1 ? t('{0} month ago', diffMonths) : t('{0} months ago', diffMonths);
  if (diffDays >= 1) return diffDays === 1 ? t('{0} day ago', diffDays) : t('{0} days ago', diffDays);
  if (diffHours >= 1) return diffHours === 1 ? t('{0} hour ago', diffHours) : t('{0} hours ago', diffHours);
  if (diffMins >= 1) return diffMins === 1 ? t('{0} minute ago', diffMins) : t('{0} minutes ago', diffMins);
  return t('just now');
}

function formatDateFull(date: Date): string {
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateDMY(date: Date): string {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${d}/${m}/${date.getFullYear()}`;
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function abbreviateAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1][0]}.`;
  return parts[0].slice(0, 14);
}

function blameLabel(l: BlameLine): string {
  return `${formatDateDMY(l.date)}  ${abbreviateAuthor(l.author)}`;
}

function annotationText(label: string, widthCh: number): string {
  return (label || ' ').padEnd(widthCh, ' ');
}

function hashPaletteIndex(hash: string): number {
  const hexPrefix = hash.match(/^[0-9a-f]{6}/i)?.[0];
  if (hexPrefix) return parseInt(hexPrefix, 16) % NUM_PALETTE;

  let value = 0;
  for (const ch of hash) {
    value = (value * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return value % NUM_PALETTE;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, '\\$&');
}

const BEFORE_TEXT_DECORATION =
  'none; display: inline-block; box-sizing: border-box; overflow: hidden; white-space: pre; line-height: inherit; vertical-align: top; box-shadow: inset -1px 0 0 rgba(127,127,127,0.55);';
const ANNOTATION_RANGE_BEHAVIOR = vscode.DecorationRangeBehavior.ClosedClosed;

export class FileAnnotationController implements vscode.Disposable {
  // Ghost text: end-of-line hint on the active cursor line
  private readonly ghostType: vscode.TextEditorDecorationType;

  private readonly annotatedUris = new Set<string>();
  private readonly codeLensLines = new Map<string, Set<number>>();
  // Tracks the last rendered blame per URI, with line numbers adjusted for unsaved edits.
  private readonly adjustedBlame = new Map<string, { lines: BlameLine[]; repoId: string }>();
  private readonly annotationRepoIds = new Map<string, string>();
  private readonly manuallyClosedUris = new Set<string>();
  private readonly annotationTypes = new Map<string, vscode.TextEditorDecorationType>();
  private readonly editorAnnotationTypeKeys = new Map<string, Set<string>>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: WorkspaceGitManager,
    private readonly logPanel: GitLogPanelProvider,
  ) {
    this.ghostType = vscode.window.createTextEditorDecorationType({
      after: {
        color: new vscode.ThemeColor('editorLineNumber.foreground'),
        margin: '0 0 0 3em',
      },
      // ClosedClosed: do not expand the range when the user types at its endpoints,
      // so the ghost text stays on the correct line after pressing Enter.
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => {
        this.maybeAutoOpenAnnotations(e.textEditor);
        this.updateGhostText(e.textEditor);
      }),

      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor) return;
        this.maybeAutoOpenAnnotations(editor);
        this.updateGhostText(editor);
        this.updateContextKey(editor);
        if (this.annotatedUris.has(editor.document.uri.toString())) {
          this.applyBlameDecorations(editor);
        }
      }),

      vscode.workspace.onDidSaveTextDocument(doc => {
        this.manager.getServicesForFile(doc.uri.fsPath).forEach(repo => repo.invalidateBlame(doc.uri.fsPath));
        const uriStr = doc.uri.toString();
        for (const editor of vscode.window.visibleTextEditors) {
          if (editor.document.uri.toString() !== uriStr) continue;
          this.updateGhostText(editor);
          if (this.annotatedUris.has(uriStr)) {
            this.applyBlameDecorations(editor);
          }
        }
      }),

      vscode.workspace.onDidChangeTextDocument(e => {
        const uriStr = e.document.uri.toString();
        if (!this.annotatedUris.has(uriStr)) return;
        const current = this.adjustedBlame.get(uriStr);
        if (!current) return;

        const hasLineChanges = e.contentChanges.some(c =>
          c.text.includes('\n') || c.range.end.line !== c.range.start.line
        );
        const touchesLineStart = e.contentChanges.some(c =>
          c.range.start.character === 0 || c.range.end.character === 0
        );
        if (!hasLineChanges && !touchesLineStart) return;

        const nextLines = hasLineChanges
          ? this.shiftBlameLinesForChanges(current.lines, e.contentChanges)
          : current.lines;

        if (hasLineChanges) {
          this.adjustedBlame.set(uriStr, { lines: nextLines, repoId: current.repoId });
          const currentCodeLensLines = this.codeLensLines.get(uriStr);
          if (currentCodeLensLines) {
            this.codeLensLines.set(uriStr, this.shiftLineSetForChanges(currentCodeLensLines, e.contentChanges));
          }
        }

        const editor = vscode.window.visibleTextEditors.find(
          ed => ed.document.uri.toString() === uriStr,
        );
        if (editor) this.renderBlame(editor, nextLines, current.repoId);
      }),

      vscode.workspace.onDidChangeConfiguration(e => {
        const annotationsChanged = e.affectsConfiguration(`${CONFIG_SECTION}.${GIT_ANNOTATIONS_ENABLED}`);
        const ghostTextChanged = e.affectsConfiguration(`${CONFIG_SECTION}.${GIT_GHOST_TEXT_ENABLED}`);

        if (annotationsChanged) {
          if (this.areGitAnnotationsEnabled()) {
            this.manuallyClosedUris.clear();
            this.autoOpenVisibleAnnotations();
          } else {
            this.disableAllAnnotations();
          }
        }

        if (ghostTextChanged) {
          for (const editor of vscode.window.visibleTextEditors) {
            if (this.isGitGhostTextEnabled()) this.updateGhostText(editor);
            else editor.setDecorations(this.ghostType, []);
          }
        }
      }),

      this.manager.onReposChange(() => this.autoOpenVisibleAnnotations()),
    );

    setTimeout(() => this.autoOpenVisibleAnnotations(), 0);
  }

  async openAnnotations(editor: vscode.TextEditor): Promise<void> {
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor, false);
      return;
    }

    const repo = await this.manager.resolveServiceForFile(editor.document.uri.fsPath, 'prompt', {
      title: t('Select Git or SVN Repository'),
      placeHolder: t('Select which repository annotations to show…'),
      notFoundMessage: t('The selected file is not inside a Git or SVN repository.'),
    });
    if (!repo) return;

    this.annotationRepoIds.set(editor.document.uri.toString(), repo.repoId);
    this.manuallyClosedUris.delete(editor.document.uri.toString());
    this.annotatedUris.add(editor.document.uri.toString());
    await this.applyBlameDecorations(editor);
    this.updateContextKey(editor);
  }

  closeAnnotations(editor: vscode.TextEditor, manual = true): void {
    const uriStr = editor.document.uri.toString();
    if (manual) this.manuallyClosedUris.add(uriStr);
    this.annotatedUris.delete(uriStr);
    this.adjustedBlame.delete(uriStr);
    this.annotationRepoIds.delete(uriStr);
    this.codeLensLines.delete(uriStr);
    this.clearAnnotationDecorations(editor);
    this.updateContextKey(editor);
  }

  private clearAnnotationDecorations(editor: vscode.TextEditor): void {
    const uriStr = editor.document.uri.toString();
    const keys = this.editorAnnotationTypeKeys.get(uriStr);
    if (keys) {
      for (const key of keys) {
        const type = this.annotationTypes.get(key);
        if (type) editor.setDecorations(type, []);
      }
      this.editorAnnotationTypeKeys.delete(uriStr);
    }
  }

  private disableAllAnnotations(): void {
    this.annotatedUris.clear();
    this.adjustedBlame.clear();
    this.codeLensLines.clear();
    this.manuallyClosedUris.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      this.clearAnnotationDecorations(editor);
      this.updateContextKey(editor);
    }
  }

  private autoOpenVisibleAnnotations(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.maybeAutoOpenAnnotations(editor);
    }
  }

  private maybeAutoOpenAnnotations(editor: vscode.TextEditor): void {
    if (!this.areGitAnnotationsEnabled()) return;
    if (editor.document.uri.scheme !== 'file') return;
    const uriStr = editor.document.uri.toString();
    if (this.annotatedUris.has(uriStr) || this.manuallyClosedUris.has(uriStr)) return;
    const repo = this.manager.getServiceForFile(editor.document.uri.fsPath);
    if (!repo) return;

    this.annotationRepoIds.set(uriStr, repo.repoId);
    this.annotatedUris.add(uriStr);
    void this.applyBlameDecorations(editor);
    this.updateContextKey(editor);
  }

  navigateToCommit(hash: string, repoId: string): void {
    this.logPanel.selectCommit(hash, repoId);
  }

  updateGhostText(editor: vscode.TextEditor): void {
    if (!this.isGitGhostTextEnabled()) {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    if (editor.document.uri.scheme !== 'file') {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    const filePath = editor.document.uri.fsPath;
    const uriStr = editor.document.uri.toString();
    const repoId = this.annotationRepoIds.get(uriStr);
    const repo = repoId ? this.manager.getRepo(repoId) : this.manager.getServiceForFile(filePath);
    if (!repo) {
      editor.setDecorations(this.ghostType, []);
      return;
    }

    const cursor = editor.selection.active;

    repo.getBlame(filePath).then(blameLines => {
      if (!this.isGitGhostTextEnabled()) {
        editor.setDecorations(this.ghostType, []);
        return;
      }
      if (vscode.window.activeTextEditor !== editor) return;
      if (!editor.selection.active.isEqual(cursor)) return;

      const blameLine = blameLines.find(l => l.lineNumber === cursor.line);
      if (!blameLine || blameLine.isUncommitted) {
        editor.setDecorations(this.ghostType, []);
        return;
      }

      const summary = truncate(blameLine.summary, GHOST_MAX_SUMMARY_LEN);
      const text = `${blameLine.author}, ${formatRelativeDate(blameLine.date)} · ${summary}`;
      const endOfLine = editor.document.lineAt(cursor.line).text.length;
      const range = new vscode.Range(cursor.line, endOfLine, cursor.line, endOfLine);

      editor.setDecorations(this.ghostType, [{
        range,
        renderOptions: { after: { contentText: `  ${text}` } },
      }]);
    }).catch(() => {
      editor.setDecorations(this.ghostType, []);
    });
  }

  private async applyBlameDecorations(editor: vscode.TextEditor): Promise<void> {
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor, false);
      return;
    }

    if (editor.document.uri.scheme !== 'file') return;

    const filePath = editor.document.uri.fsPath;
    const uriStr = editor.document.uri.toString();
    const repoId = this.annotationRepoIds.get(uriStr);
    const repo = repoId ? this.manager.getRepo(repoId) : this.manager.getServiceForFile(filePath);
    if (!repo) return;

    try {
      const [blameLines, codeLensLines] = await Promise.all([
        repo.getBlame(filePath),
        this.getCodeLensLines(editor.document),
      ]);
      const displayBlameLines = blameLines.length > 0 ? blameLines : this.uncommittedBlameForDocument(editor.document);
      if (!this.annotatedUris.has(uriStr)) return;
      this.annotationRepoIds.set(uriStr, repo.repoId);
      this.codeLensLines.set(uriStr, codeLensLines);
      this.adjustedBlame.set(uriStr, { lines: [...displayBlameLines], repoId: repo.repoId });
      this.renderBlame(editor, displayBlameLines, repo.repoId);
    } catch {
      // Leave the editor usable even if blame or CodeLens providers fail.
    }
  }

  private shiftLineSetForChanges(
    lines: Set<number>,
    changes: readonly vscode.TextDocumentContentChangeEvent[],
  ): Set<number> {
    let result = new Set(lines);
    const sorted = [...changes].sort((a, b) => b.range.start.line - a.range.start.line);

    for (const change of sorted) {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const insertedNewlines = (change.text.match(/\n/g) ?? []).length;
      const removedLines = endLine - startLine;
      const delta = insertedNewlines - removedLines;

      if (removedLines > 0) {
        result = new Set([...result].filter(line => line <= startLine || line > endLine));
      }

      if (delta !== 0) {
        result = new Set([...result].map(line => line > endLine ? line + delta : line));
      }
    }

    return result;
  }

  private async getCodeLensLines(document: vscode.TextDocument): Promise<Set<number>> {
    try {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider',
        document.uri,
      );
      return new Set((lenses ?? []).map(lens => lens.range.start.line));
    } catch {
      return new Set();
    }
  }

  private uncommittedBlameForDocument(document: vscode.TextDocument): BlameLine[] {
    return Array.from({ length: document.lineCount }, (_, lineNumber) => ({
      lineNumber,
      hash: '0000000000000000000000000000000000000000',
      author: t('Not committed'),
      date: new Date(),
      summary: t('Not committed'),
      isUncommitted: true,
    }));
  }

  // Adjusts stored blame line numbers to reflect content changes made since the last git blame.
  // Processes changes bottom-to-top to avoid double-shifting when multiple changes fire at once.
  private shiftBlameLinesForChanges(
    blameLines: BlameLine[],
    changes: readonly vscode.TextDocumentContentChangeEvent[],
  ): BlameLine[] {
    let result = blameLines.map(l => ({ ...l }));
    const sorted = [...changes].sort((a, b) => b.range.start.line - a.range.start.line);

    for (const change of sorted) {
      const startLine = change.range.start.line;
      const endLine = change.range.end.line;
      const insertedNewlines = (change.text.match(/\n/g) ?? []).length;
      const removedLines = endLine - startLine;
      const delta = insertedNewlines - removedLines;

      // Drop blame entries for lines that were entirely removed by this change
      // (lines strictly between startLine and endLine that no longer exist).
      if (removedLines > 0) {
        result = result.filter(l => l.lineNumber <= startLine || l.lineNumber > endLine);
      }

      // Shift all surviving lines after the change by the net line delta.
      if (delta !== 0) {
        for (const bl of result) {
          if (bl.lineNumber > endLine) bl.lineNumber += delta;
        }
      }
    }

    return result;
  }

  private getAnnotationType(label: string, widthCh: number, paletteIndex: number | 'uncommitted' | 'placeholder', extendsCodeLens: boolean): vscode.TextEditorDecorationType {
    const key = `${paletteIndex}:${extendsCodeLens ? 'codelens' : 'normal'}:${widthCh}:${label}`;
    const existing = this.annotationTypes.get(key);
    if (existing) return existing;

    const before: vscode.ThemableDecorationAttachmentRenderOptions = {
      contentText: annotationText(label, widthCh),
      margin: '0 1ch 0 0',
      textDecoration: BEFORE_TEXT_DECORATION,
      width: `${widthCh}ch`,
      height: '100%',
    };

    const options: vscode.DecorationRenderOptions = {
      before,
      rangeBehavior: ANNOTATION_RANGE_BEHAVIOR,
    };

    if (paletteIndex === 'uncommitted') {
      options.dark = { before: { color: 'rgba(160,160,160,0.9)' } };
      options.light = { before: { color: 'rgba(100,100,100,0.9)' } };
    } else if (paletteIndex !== 'placeholder') {
      const hue = PALETTE_HUES[paletteIndex];
      options.dark = {
        before: {
          backgroundColor: `hsla(${hue}, 70%, 65%, 0.18)`,
          color: 'rgba(180,180,180,0.95)',
        },
      };
      options.light = {
        before: {
          backgroundColor: `hsla(${hue}, 65%, 38%, 0.14)`,
          color: 'rgba(80,80,80,0.95)',
        },
      };
    }

    const type = vscode.window.createTextEditorDecorationType(options);
    this.annotationTypes.set(key, type);
    return type;
  }

  private renderBlame(editor: vscode.TextEditor, blameLines: BlameLine[], repoId: string): void {
    const uriStr = editor.document.uri.toString();
    if (!this.areGitAnnotationsEnabled()) {
      this.closeAnnotations(editor);
      return;
    }
    if (!this.annotatedUris.has(uriStr)) return;
    const codeLensLines = this.codeLensLines.get(uriStr) ?? new Set<number>();

    // Give every before attachment the same explicit width. Character-count padding
    // is not stable enough here: the translated "Not committed" label and
    // date/author labels can measure
    // a little differently and shift indentation guides on modified lines.
    const notCommittedLabel = t('Not committed');
    const maxLabelLen = blameLines
      .filter(l => !l.isUncommitted)
      .reduce((max, l) => Math.max(max, blameLabel(l).length), Math.max(notCommittedLabel.length, NOT_COMMITTED_LABEL_FALLBACK_LENGTH));
    const annotationWidthCh = maxLabelLen + 1; // +1 visual gap before border

    this.clearAnnotationDecorations(editor);

    const decorationGroups = new Map<string, { type: vscode.TextEditorDecorationType; ranges: vscode.DecorationOptions[] }>();
    const addDecoration = (
      lineNumber: number,
      label: string,
      paletteIndex: number | 'uncommitted' | 'placeholder',
      hoverMessage?: vscode.MarkdownString,
    ) => {
      const extendsCodeLens = codeLensLines.has(lineNumber);
      const type = this.getAnnotationType(label, annotationWidthCh, paletteIndex, extendsCodeLens);
      const key = `${paletteIndex}:${extendsCodeLens ? 'codelens' : 'normal'}:${annotationWidthCh}:${label}`;
      const group = decorationGroups.get(key) ?? { type, ranges: [] };
      group.ranges.push({ range: new vscode.Range(lineNumber, 0, lineNumber, 0), hoverMessage });
      decorationGroups.set(key, group);
    };

    for (const l of blameLines) {
      if (!l.isUncommitted) continue;
      addDecoration(l.lineNumber, notCommittedLabel, 'uncommitted');
    }

    for (const l of blameLines) {
      if (l.isUncommitted) continue;
      addDecoration(l.lineNumber, blameLabel(l), hashPaletteIndex(l.hash), this.buildHoverMessage(l, repoId));
    }

    // New/unsaved lines get the same measured before attachment, with no visible text.
    const blameLineNumbers = new Set(blameLines.map(l => l.lineNumber));
    for (let i = 0; i < editor.document.lineCount; i++) {
      if (!blameLineNumbers.has(i)) {
        addDecoration(i, '', 'placeholder');
      }
    }

    const uriTypeKeys = new Set<string>();
    for (const [key, group] of decorationGroups) {
      editor.setDecorations(group.type, group.ranges);
      uriTypeKeys.add(key);
    }
    this.editorAnnotationTypeKeys.set(uriStr, uriTypeKeys);
  }

  private buildHoverMessage(line: BlameLine, repoId: string): vscode.MarkdownString {
    const args = encodeURIComponent(JSON.stringify([line.hash, repoId]));
    const commandUri = `command:versiondock.navigateToAnnotationCommit?${args}`;

    const md = new vscode.MarkdownString(
      `**${escapeMarkdown(line.author)}** — ${formatDateFull(line.date)}\n\n` +
      `\`${line.hash.slice(0, 7)}\` ${escapeMarkdown(line.summary)}\n\n` +
      `[$(history) ${t('Open in Git Log')}](${commandUri})`
    );
    md.isTrusted = true;
    md.supportThemeIcons = true;
    return md;
  }

  private areGitAnnotationsEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(GIT_ANNOTATIONS_ENABLED, true);
  }

  private isGitGhostTextEnabled(): boolean {
    return vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>(GIT_GHOST_TEXT_ENABLED, true);
  }

  private updateContextKey(editor: vscode.TextEditor): void {
    vscode.commands.executeCommand(
      'setContext',
      CONTEXT_KEY,
      this.areGitAnnotationsEnabled() && this.annotatedUris.has(editor.document.uri.toString()),
    );
  }

  dispose(): void {
    this.ghostType.dispose();
    this.annotationTypes.forEach(t => t.dispose());
    this.annotationTypes.clear();
    this.disposables.forEach(d => d.dispose());
  }
}
