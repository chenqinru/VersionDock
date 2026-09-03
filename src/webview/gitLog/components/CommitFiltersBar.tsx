import React, { useState, useRef, useEffect } from 'react';
import type { CommitFilters } from '../store/logStore';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { Codicon } from '../../shared/Codicon';
import { t, getLocale } from '../../shared/i18n';
import { formatAuthorIdentity } from './AuthorAvatar';
import { readableAccentColor } from '../../shared/branchColors';
import { branchRevisionRef, tagRevisionRef } from '../utils/refs';

export interface AuthorOption {
  name: string;
  email: string;
  value: string;
  count: number;
}

interface RevisionOption {
  value: string;
  label: string;
  kind: 'branch' | 'tag';
}

interface Props {
  filters: CommitFilters;
  branches: BranchInfo[];
  tags: TagInfo[];
  repos: RepoMeta[];
  authorOptions: AuthorOption[];
  onFilterChange: (key: Exclude<keyof CommitFilters, 'repoIds'>, value: string) => void;
  onRepoChange: (repoId: string | null) => void;
  onClear: () => void;
  onFetchAll: () => void;
  repoNamesExpanded?: boolean;
  onToggleRepoNames?: () => void;
  onUndock?: (target: 'editorTab' | 'newWindow' | 'pick') => void;
  hideUndock?: boolean;
  disableBranchFilter?: boolean;
}

export const FILTER_INPUT_STYLE = `
.versiondock-filter-input::placeholder {
  color: var(--vscode-descriptionForeground);
  opacity: 1;
}
[data-filter-picker-btn][data-active="false"]:not(:disabled):hover,
[data-filter-calendar-nav]:hover {
  background: var(--vscode-toolbar-hoverBackground) !important;
}
[data-filter-picker-btn][data-active="true"]:not(:disabled):hover,
[data-filter-dropdown-item][data-selected="true"]:hover,
[data-filter-calendar-day][data-selected="true"]:hover {
  filter: brightness(1.08);
}
[data-filter-dropdown-item][data-selected="false"]:hover,
[data-filter-calendar-day][data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
[data-more-menu-item]:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)) !important;
  color: var(--vscode-menu-selectionForeground, var(--vscode-menu-foreground, var(--vscode-foreground))) !important;
}
`;

export function CommitFiltersBar({ filters, branches, tags, repos, authorOptions, onFilterChange, onRepoChange, onClear, onFetchAll, repoNamesExpanded, onToggleRepoNames, onUndock, hideUndock, disableBranchFilter = false }: Props) {
  const relevantBranches = filters.repoId
    ? branches.filter(b => b.repoId === filters.repoId)
    : branches;
  const relevantTags = filters.repoId
    ? tags.filter(t => t.repoId === filters.repoId)
    : tags;
  const localBranches = relevantBranches.filter(b => !b.isRemote);
  const repoKindById: Record<string, 'git' | 'svn'> = Object.fromEntries(
    repos.map(repo => [repo.id, repo.kind ?? 'git']),
  );
  const branchOptions = Array.from(new Map(localBranches.map(branch => {
    const option: RevisionOption = {
      value: branchRevisionRef(branch, repoKindById[branch.repoId] ?? 'git'),
      label: branch.name,
      kind: 'branch',
    };
    return [option.value, option];
  })).values()).sort((left, right) => left.label.localeCompare(right.label));
  const tagOptions = Array.from(new Map(relevantTags.map(tag => {
    const option: RevisionOption = {
      value: tagRevisionRef(tag.name, repoKindById[tag.repoId] ?? 'git'),
      label: tag.name,
      kind: 'tag',
    };
    return [option.value, option];
  })).values()).sort((left, right) => left.label.localeCompare(right.label));
  const historyFileName = filters.path.split('/').pop() || filters.path;
  const historyLabel = filters.lineRange
    ? t('{0}:lines {1}-{2}', historyFileName, filters.lineRange.start, filters.lineRange.end)
    : historyFileName;

  const hasFilters = !!(filters.text || filters.author || filters.branch || filters.dateFrom || filters.dateTo || filters.repoId || filters.path);

  return (
    <div style={styles.bar}>
      <style>{FILTER_INPUT_STYLE}</style>
      <DebouncedInput
        value={filters.text}
        placeholder={t('Search commits…')}
        icon="search"
        onChange={v => onFilterChange('text', v)}
        style={styles.searchFilter}
        debounceMs={250}
      />

      <AuthorPicker
        value={filters.author}
        options={authorOptions}
        onChange={v => onFilterChange('author', v)}
        style={styles.authorFilter}
      />

      {repos.length > 1 && (
        <RepoPicker
          value={filters.repoId}
          repos={repos}
          onChange={onRepoChange}
          style={styles.repoFilter}
        />
      )}

      <BranchTagPicker
        value={filters.branch}
        branches={branchOptions}
        tags={tagOptions}
        onChange={v => onFilterChange('branch', v)}
        style={styles.branchFilter}
        disabled={disableBranchFilter}
      />

      <DateRangePicker
        from={filters.dateFrom}
        to={filters.dateTo}
        onFromChange={v => onFilterChange('dateFrom', v)}
        onToChange={v => onFilterChange('dateTo', v)}
        style={styles.dateFilter}
      />

      {filters.path && (
        <div style={styles.historyChip} title={filters.path}>
          <Codicon name="history" style={styles.fieldIcon} />
          <span style={styles.historyPrefix}>{t('History:')}</span>
          <span style={styles.historyLabel}>{historyLabel}</span>
          <button
            style={styles.fieldClear}
            onClick={() => onFilterChange('path', '')}
            title={t('Clear history filter')}
            tabIndex={-1}
          >
            <Codicon name="close" style={{ fontSize: '10px' }} />
          </button>
        </div>
      )}

      <div style={styles.rightActions}>
        {hasFilters && (
          <ClearFiltersButton onClick={onClear} />
        )}
        <MoreMenu
          onFetchAll={onFetchAll}
          showRepoNameToggle={repos.length > 1}
          repoNamesExpanded={repoNamesExpanded}
          onToggleRepoNames={onToggleRepoNames}
          onUndock={onUndock}
          hideUndock={hideUndock}
        />
      </div>
    </div>
  );
}

export function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <button data-top-action-btn="" style={styles.clearBtn} onClick={onClick} title={t('Clear all filters')}>
      <Codicon name="clear-all" style={{ fontSize: '15px' }} />
    </button>
  );
}

function MoreMenu({ onFetchAll, showRepoNameToggle, repoNamesExpanded, onToggleRepoNames, onUndock, hideUndock }: {
  onFetchAll: () => void;
  showRepoNameToggle: boolean;
  repoNamesExpanded?: boolean;
  onToggleRepoNames?: () => void;
  onUndock?: (target: 'editorTab' | 'newWindow' | 'pick') => void;
  hideUndock?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOut(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    const onBlur = () => setOpen(false);
    if (open) {
      document.addEventListener('mousedown', onOut);
      window.addEventListener('blur', onBlur);
    }
    return () => {
      document.removeEventListener('mousedown', onOut);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        data-top-action-btn=""
        style={styles.moreBtn}
        onClick={() => setOpen(value => !value)}
        title={t('More actions')}
      >
        <Codicon name="three-bars" style={{ fontSize: '14px' }} />
      </button>
      {open && (
        <div style={styles.moreDropdown}>
          <div
            data-more-menu-item=""
            style={styles.moreItem}
            onClick={() => { onFetchAll(); setOpen(false); }}
          >
            <Codicon name="sync" style={{ fontSize: '13px' }} />
            <span>{t('Fetch and Refresh')}</span>
          </div>
          {showRepoNameToggle && (
            <div
              data-more-menu-item=""
              style={styles.moreItem}
              onClick={() => { onToggleRepoNames?.(); setOpen(false); }}
            >
              <Codicon name={repoNamesExpanded ? 'collapse-all' : 'expand-all'} style={{ fontSize: '13px' }} />
              <span>{t(repoNamesExpanded ? 'Collapse project names' : 'Expand project names')}</span>
            </div>
          )}
          {!hideUndock && (
            <>
              <div style={styles.moreSeparator} />
              <div
                data-more-menu-item=""
                style={styles.moreItem}
                onClick={() => { onUndock?.('pick'); setOpen(false); }}
              >
                <Codicon name="multiple-windows" style={{ fontSize: '13px' }} />
                <span>{t('Undock…')}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AuthorPicker({ value, options, onChange, width, style }: {
  value: string;
  options: AuthorOption[];
  onChange: (v: string) => void;
  width?: number;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const fallbackOption = value ? { name: value, email: '', value, count: 0 } : null;
  const mergedOptions = fallbackOption && !options.some(option => option.value === value || option.name === value || option.email === value)
    ? [fallbackOption, ...options]
    : options;
  const active = mergedOptions.find(option => option.value === value || option.name === value || option.email === value) ?? null;
  const displayValue = active?.name ?? value;
  const normalizedQuery = query.trim().toLowerCase();
  const displayed = normalizedQuery
    ? mergedOptions.filter(option => (
      option.name.toLowerCase().includes(normalizedQuery)
      || option.email.toLowerCase().includes(normalizedQuery)
    ))
    : mergedOptions;

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  useEffect(() => {
    function onOut(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        data-filter-picker-btn=""
        data-active={value ? 'true' : 'false'}
        style={{ ...styles.pickerBtn(!!value), width: width ?? '100%' }}
        onClick={() => setOpen(current => !current)}
        title={active ? formatAuthorIdentity(active.name, active.email) : (value || t('Filter by author'))}
      >
        <Codicon name="person" style={styles.fieldIcon} />
        <span style={value ? styles.pickerLabelActive : styles.pickerLabelPlaceholder}>
          {displayValue || t('Author…')}
        </span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownSearch}>
            <Codicon name="search" style={{ fontSize: '11px', flexShrink: 0 }} />
            <input
              autoFocus
              className="versiondock-filter-input"
              style={styles.dropdownInput}
              placeholder={t('Filter…')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setOpen(false);
                if (event.key === 'Enter' && displayed[0]) {
                  onChange(displayed[0].value);
                  setOpen(false);
                }
              }}
            />
          </div>
          <div style={styles.dropdownList}>
            <div
              data-filter-dropdown-item=""
              data-selected={!value ? 'true' : 'false'}
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>{t('All authors')}</span>
              {!value && <Codicon name="check" style={{ fontSize: '11px', marginLeft: 'auto', flexShrink: 0 }} />}
            </div>
            {displayed.map(option => (
              <div
                key={option.value}
                data-filter-dropdown-item=""
                data-selected={value === option.value ? 'true' : 'false'}
                style={styles.dropdownItem(value === option.value)}
                onClick={() => { onChange(option.value); setOpen(false); }}
                title={formatAuthorIdentity(option.name, option.email)}
              >
                <Codicon name="person" style={{ fontSize: '12px', flexShrink: 0 }} />
                <span style={styles.authorOption}>
                  <span style={styles.authorName}>{option.name}</span>
                  {option.email.trim() && <span style={styles.authorEmail}>{option.email}</span>}
                </span>
                {option.count > 0 && <span style={styles.authorCount}>{option.count}</span>}
                {value === option.value && <Codicon name="check" style={{ fontSize: '11px', flexShrink: 0 }} />}
              </div>
            ))}
            {displayed.length === 0 && (
              <div style={styles.dropdownEmpty}>{t('No authors match')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function DebouncedInput({ value, placeholder, icon, onChange, width, style, debounceMs }: {
  value: string;
  placeholder: string;
  icon: string;
  onChange: (v: string) => void;
  width?: number;
  style?: React.CSSProperties;
  debounceMs: number;
}) {
  const [local, setLocal] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocal(value);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [value]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  function handleImmediateChange(v: string) {
    setLocal(v);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    onChange(v);
  }

  function handleChange(v: string) {
    setLocal(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onChange(v);
    }, debounceMs);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      handleImmediateChange('');
      event.currentTarget.blur();
    }
    if (event.key === 'Enter') {
      handleImmediateChange(local);
    }
  }

  return (
    <div style={{ ...styles.fieldWrap, width, ...style }}>
      <Codicon name={icon} style={styles.fieldIcon} />
      <input
        className="versiondock-filter-input"
        style={styles.fieldInput}
        type="text"
        placeholder={placeholder}
        value={local}
        onChange={event => handleChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      {local && (
        <button style={styles.fieldClear} onClick={() => handleImmediateChange('')} tabIndex={-1}>
          <Codicon name="close" style={{ fontSize: '10px' }} />
        </button>
      )}
    </div>
  );
}

function BranchTagPicker({ value, branches, tags, onChange, width, style, disabled = false }: {
  value: string;
  branches: RevisionOption[];
  tags: RevisionOption[];
  onChange: (v: string) => void;
  width?: number;
  style?: React.CSSProperties;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const q = query.toLowerCase();
  const displayedBranches = q ? branches.filter(option => option.label.toLowerCase().includes(q)) : branches;
  const displayedTags = q ? tags.filter(option => option.label.toLowerCase().includes(q)) : tags;
  const isEmpty = displayedBranches.length === 0 && displayedTags.length === 0;

  const active = [...branches, ...tags].find(option => option.value === value);
  const isTag = active?.kind === 'tag';
  const buttonIcon = isTag ? 'tag' : 'git-branch';

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  useEffect(() => {
    function onOut(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        data-filter-picker-btn=""
        data-active={value ? 'true' : 'false'}
        style={{ ...styles.pickerBtn(!!value), width: width ?? '100%', ...(disabled ? styles.disabledPicker : {}) }}
        onClick={() => { if (!disabled) setOpen(current => !current); }}
        title={disabled ? t('Branch filter is unavailable in compare mode') : (active?.label || value || t('Filter by branch or tag'))}
        disabled={disabled}
      >
        <Codicon name={buttonIcon} style={styles.fieldIcon} />
        <span style={value ? styles.pickerLabelActive : styles.pickerLabelPlaceholder}>
          {active?.label || value || t('Branch / Tag…')}
        </span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', flexShrink: 0 }} />
      </button>

      {open && !disabled && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownSearch}>
            <Codicon name="search" style={{ fontSize: '11px', flexShrink: 0 }} />
            <input
              autoFocus
              className="versiondock-filter-input"
              style={styles.dropdownInput}
              placeholder={t('Filter…')}
              value={query}
              onChange={event => setQuery(event.target.value)}
              onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
            />
          </div>
          <div style={styles.dropdownList}>
            <div
              data-filter-dropdown-item=""
              data-selected={!value ? 'true' : 'false'}
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(''); setOpen(false); }}
            >
              <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>{t('All branches & tags')}</span>
            </div>
            {displayedBranches.length > 0 && (
              <div style={styles.dropdownGroupLabel}>{t('Branches')}</div>
            )}
            {displayedBranches.map(option => (
              <div
                key={`b:${option.value}`}
                data-filter-dropdown-item=""
                data-selected={value === option.value ? 'true' : 'false'}
                style={styles.dropdownItem(value === option.value)}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                <Codicon name="git-branch" style={{ fontSize: '12px', flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{option.label}</span>
                {value === option.value && <Codicon name="check" style={{ fontSize: '11px', marginLeft: 'auto', flexShrink: 0 }} />}
              </div>
            ))}
            {displayedTags.length > 0 && (
              <div style={styles.dropdownGroupLabel}>{t('Tags')}</div>
            )}
            {displayedTags.map(option => (
              <div
                key={`t:${option.value}`}
                data-filter-dropdown-item=""
                data-selected={value === option.value ? 'true' : 'false'}
                style={styles.dropdownItem(value === option.value)}
                onClick={() => { onChange(option.value); setOpen(false); }}
              >
                <Codicon name="tag" style={{ fontSize: '12px', flexShrink: 0 }} />
                <span style={styles.dropdownItemLabel}>{option.label}</span>
                {value === option.value && <Codicon name="check" style={{ fontSize: '11px', marginLeft: 'auto', flexShrink: 0 }} />}
              </div>
            ))}
            {isEmpty && (
              <div style={styles.dropdownEmpty}>{t('No matches')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RepoPicker({ value, repos, onChange, style }: {
  value: string | null;
  repos: RepoMeta[];
  onChange: (repoId: string | null) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onOut(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onOut);
    return () => document.removeEventListener('mousedown', onOut);
  }, [open]);

  const active = repos.find(repo => repo.id === value) ?? null;
  const displayRepoName = (name: string) => name.toUpperCase();

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        data-filter-picker-btn=""
        data-active={value ? 'true' : 'false'}
        style={{ ...styles.pickerBtn(!!value), width: '100%' }}
        onClick={() => setOpen(current => !current)}
        title={active ? displayRepoName(active.name) : t('Filter by repository')}
      >
        {active
          ? <span style={{ ...styles.repoDot, background: active.color }} />
          : <Codicon name="repo" style={styles.fieldIcon} />
        }
        <span style={value ? styles.pickerLabelActive : styles.pickerLabelPlaceholder}>
          {active ? displayRepoName(active.name) : t('Repository…')}
        </span>
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={styles.dropdown}>
          <div style={styles.dropdownList}>
            <div
              data-filter-dropdown-item=""
              data-selected={!value ? 'true' : 'false'}
              style={styles.dropdownItem(!value)}
              onClick={() => { onChange(null); setOpen(false); }}
            >
              <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '12px' }}>{t('All repositories')}</span>
              {!value && <Codicon name="check" style={{ fontSize: '11px', marginLeft: 'auto', flexShrink: 0 }} />}
            </div>
            {repos.map(repo => (
              <div
                key={repo.id}
                data-filter-dropdown-item=""
                data-selected={value === repo.id ? 'true' : 'false'}
                style={styles.dropdownItem(value === repo.id)}
                onClick={() => { onChange(repo.id); setOpen(false); }}
              >
                <span style={{ ...styles.repoDot, background: readableAccentColor(repo.color) }} />
                <span style={styles.dropdownItemLabel}>{displayRepoName(repo.name)}</span>
                {value === repo.id && <Codicon name="check" style={{ fontSize: '11px', marginLeft: 'auto', flexShrink: 0 }} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function getLocalizedWeekdays(locale: string): string[] {
  try {
    const baseSunday = new Date(2021, 7, 1);
    const isZh = locale.toLowerCase().startsWith('zh');
    const formatter = new Intl.DateTimeFormat(locale, { weekday: isZh ? 'narrow' : 'short' });
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(baseSunday);
      d.setDate(baseSunday.getDate() + i);
      return formatter.format(d);
    });
  } catch {
    return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  }
}

function formatYearMonth(year: number, month: number, locale: string): string {
  try {
    const date = new Date(year, month, 1);
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short' }).format(date);
  } catch {
    return `${year}-${String(month + 1).padStart(2, '0')}`;
  }
}

function toYMD(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseYMD(value: string): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00`);
  return isNaN(date.getTime()) ? null : date;
}

function CalendarMonth({ year, month, from, to, hovered, onDay, onHover, weekdays }: {
  year: number;
  month: number;
  from: Date | null;
  to: Date | null;
  hovered: Date | null;
  onDay: (date: Date) => void;
  onHover: (date: Date | null) => void;
  weekdays: string[];
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<Date | null> = [];
  for (let index = 0; index < firstDay; index++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));

  const rangeEnd = hovered ?? to;

  return (
    <div style={calStyles.month}>
      <div style={calStyles.grid}>
        {weekdays.map((day, index) => (
          <div key={`${day}-${index}`} style={calStyles.dayHeader}>{day}</div>
        ))}
        {cells.map((date, index) => {
          if (!date) return <div key={`empty-${index}`} />;
          const ymd = toYMD(date);
          const isFrom = from ? toYMD(from) === ymd : false;
          const isTo = to ? toYMD(to) === ymd : false;
          const isHovered = hovered ? toYMD(hovered) === ymd : false;
          const lo = from && rangeEnd ? (from <= rangeEnd ? from : rangeEnd) : null;
          const hi = from && rangeEnd ? (from <= rangeEnd ? rangeEnd : from) : null;
          const inRange = !!(lo && hi && date > lo && date < hi);
          const isEdge = isFrom || isTo || isHovered;
          return (
            <div
              key={ymd}
              data-filter-calendar-day=""
              data-selected={isEdge || inRange ? 'true' : 'false'}
              style={calStyles.day(isEdge, inRange)}
              onClick={() => onDay(date)}
              onMouseEnter={() => onHover(date)}
              onMouseLeave={() => onHover(null)}
            >
              {date.getDate()}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DateRangePicker({ from, to, onFromChange, onToChange, style }: {
  from: string;
  to: string;
  onFromChange: (v: string) => void;
  onToChange: (v: string) => void;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState<Date | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [isDual, setIsDual] = useState(true);

  const locale = getLocale();
  const weekdays = getLocalizedWeekdays(locale);

  const today = new Date();
  const fromDate = parseYMD(from);
  const toDate = parseYMD(to);
  const initLeft = fromDate ?? new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const initRight = toDate ?? new Date(today.getFullYear(), today.getMonth(), 1);
  const [leftYM, setLeftYM] = useState({ year: initLeft.getFullYear(), month: initLeft.getMonth() });
  const [rightYM, setRightYM] = useState({ year: initRight.getFullYear(), month: initRight.getMonth() });
  const [singleYM, setSingleYM] = useState({
    year: (toDate ?? fromDate ?? today).getFullYear(),
    month: (toDate ?? fromDate ?? today).getMonth(),
  });

  useEffect(() => {
    if (!open) return;
    const width = wrapRef.current?.clientWidth ?? 340;
    setIsDual(width >= 310);
    const now = new Date();
    const curFrom = parseYMD(from);
    const curTo = parseYMD(to);
    const left = curFrom ?? new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const right = curTo ?? new Date(now.getFullYear(), now.getMonth(), 1);
    const activeSingle = curTo ?? curFrom ?? now;
    setLeftYM({ year: left.getFullYear(), month: left.getMonth() });
    setRightYM({ year: right.getFullYear(), month: right.getMonth() });
    setSingleYM({ year: activeSingle.getFullYear(), month: activeSingle.getMonth() });
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    function onOut(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    const onBlur = () => setOpen(false);
    document.addEventListener('mousedown', onOut);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onOut);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  function handleDay(date: Date) {
    const ymd = toYMD(date);
    if (!from || (from && to)) {
      onFromChange(ymd);
      onToChange('');
      return;
    }
    const start = parseYMD(from);
    if (start && date < start) {
      onFromChange(ymd);
      onToChange(from);
    } else {
      onToChange(ymd);
    }
    setOpen(false);
  }

  function shiftLeft(delta: -1 | 1) {
    setLeftYM(previous => shiftMonth(previous, delta));
  }

  function shiftRight(delta: -1 | 1) {
    setRightYM(previous => shiftMonth(previous, delta));
  }

  function shiftSingle(delta: -1 | 1) {
    setSingleYM(previous => shiftMonth(previous, delta));
  }

  const hasRange = !!(from || to);
  const label = from && to ? `${from}  →  ${to}` : from ? `${from}  →  ...` : null;

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      <button
        data-filter-picker-btn=""
        data-active={hasRange ? 'true' : 'false'}
        style={{ ...styles.pickerBtn(hasRange), width: '100%' }}
        onClick={() => setOpen(current => !current)}
        title={label ?? t('From YYYY-MM-DD')}
      >
        <Codicon name="calendar" style={styles.fieldIcon} />
        {label
          ? <span style={styles.pickerLabelActive}>{label}</span>
          : <span style={styles.pickerLabelPlaceholder}>{t('From → To')}</span>}
        {hasRange && (
          <span
            style={{ ...styles.fieldClear, marginLeft: 2 }}
            onClick={event => {
              event.stopPropagation();
              onFromChange('');
              onToChange('');
            }}
          >
            <Codicon name="close" style={{ fontSize: '10px' }} />
          </span>
        )}
        <Codicon name={open ? 'chevron-up' : 'chevron-down'} style={{ fontSize: '10px', flexShrink: 0 }} />
      </button>

      {open && (
        <div style={isDual ? calStyles.dualPopup : calStyles.singlePopup}>
          {isDual ? (
            <>
              <div style={calStyles.calCol}>
                <div style={calStyles.navRow}>
                  <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftLeft(-1)} title={t('Previous month')}>
                    <Codicon name="chevron-left" style={{ fontSize: '12px' }} />
                  </button>
                  <span style={calStyles.navLabel}>{formatYearMonth(leftYM.year, leftYM.month, locale)}</span>
                  <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftLeft(1)} title={t('Next month')}>
                    <Codicon name="chevron-right" style={{ fontSize: '12px' }} />
                  </button>
                </div>
                <CalendarMonth
                  year={leftYM.year}
                  month={leftYM.month}
                  from={fromDate}
                  to={toDate}
                  hovered={hovered}
                  onDay={handleDay}
                  onHover={setHovered}
                  weekdays={weekdays}
                />
              </div>

              <div style={calStyles.divider} />

              <div style={calStyles.calCol}>
                <div style={calStyles.navRow}>
                  <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftRight(-1)} title={t('Previous month')}>
                    <Codicon name="chevron-left" style={{ fontSize: '12px' }} />
                  </button>
                  <span style={calStyles.navLabel}>{formatYearMonth(rightYM.year, rightYM.month, locale)}</span>
                  <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftRight(1)} title={t('Next month')}>
                    <Codicon name="chevron-right" style={{ fontSize: '12px' }} />
                  </button>
                </div>
                <CalendarMonth
                  year={rightYM.year}
                  month={rightYM.month}
                  from={fromDate}
                  to={toDate}
                  hovered={hovered}
                  onDay={handleDay}
                  onHover={setHovered}
                  weekdays={weekdays}
                />
              </div>
            </>
          ) : (
            <>
              <div style={calStyles.navRow}>
                <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftSingle(-1)} title={t('Previous month')}>
                  <Codicon name="chevron-left" style={{ fontSize: '12px' }} />
                </button>
                <span style={calStyles.navLabel}>{formatYearMonth(singleYM.year, singleYM.month, locale)}</span>
                <button data-filter-calendar-nav="" style={calStyles.navBtn} onClick={() => shiftSingle(1)} title={t('Next month')}>
                  <Codicon name="chevron-right" style={{ fontSize: '12px' }} />
                </button>
              </div>
              <CalendarMonth
                year={singleYM.year}
                month={singleYM.month}
                from={fromDate}
                to={toDate}
                hovered={hovered}
                onDay={handleDay}
                onHover={setHovered}
                weekdays={weekdays}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function shiftMonth(previous: { year: number; month: number }, delta: -1 | 1) {
  let month = previous.month + delta;
  let year = previous.year;
  if (month < 0) {
    month = 11;
    year--;
  }
  if (month > 11) {
    month = 0;
    year++;
  }
  return { year, month };
}

const calStyles = {
  dualPopup: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: '2px',
    width: '100%',
    zIndex: 300,
    background: 'var(--vscode-dropdown-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)))',
    borderRadius: '4px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    boxSizing: 'border-box' as const,
    display: 'flex',
    flexDirection: 'row' as const,
    padding: '8px',
  },
  singlePopup: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: '2px',
    width: '100%',
    zIndex: 300,
    background: 'var(--vscode-dropdown-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border, rgba(128,128,128,0.35)))',
    borderRadius: '4px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
    boxSizing: 'border-box' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '8px',
    gap: '4px',
  },
  calCol: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    flex: 1,
    minWidth: 0,
  },
  divider: {
    width: '1px',
    background: 'var(--vscode-panel-border)',
    margin: '0 8px',
    alignSelf: 'stretch',
  },
  navRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '2px',
  },
  navBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    borderRadius: '3px',
  } as React.CSSProperties,
  navLabel: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  month: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  monthTitle: {
    display: 'none',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(7, 1fr)',
    gap: '1px',
  },
  dayHeader: {
    fontSize: '10px',
    textAlign: 'center' as const,
    color: 'var(--vscode-descriptionForeground)',
    padding: '2px 0',
    fontWeight: 600,
  },
  day: (isEdge: boolean, inRange: boolean): React.CSSProperties => ({
    fontSize: '11px',
    textAlign: 'center',
    padding: '3px 1px',
    borderRadius: '3px',
    cursor: 'pointer',
    userSelect: 'none',
    background: isEdge
      ? 'var(--vscode-list-activeSelectionBackground)'
      : inRange
        ? 'var(--vscode-list-inactiveSelectionBackground)'
        : 'transparent',
    color: isEdge
      ? 'var(--vscode-list-activeSelectionForeground)'
      : 'var(--vscode-foreground)',
    fontWeight: isEdge ? 700 : 'normal',
  }),
};

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'nowrap' as const,
    gap: '6px',
    padding: '6px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    flexShrink: 0,
    minHeight: '38px',
    boxSizing: 'border-box' as const,
  },
  rightActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    marginLeft: 'auto',
  } as React.CSSProperties,
  searchFilter: {
    flex: '1.2 1 180px',
    minWidth: '130px',
  } as React.CSSProperties,
  authorFilter: {
    flex: '1 1 150px',
    minWidth: '100px',
  } as React.CSSProperties,
  repoFilter: {
    flex: '1 1 140px',
    minWidth: '100px',
  } as React.CSSProperties,
  branchFilter: {
    flex: '1.1 1 160px',
    minWidth: '110px',
  } as React.CSSProperties,
  dateFilter: {
    flex: '1.5 1 220px',
    minWidth: '160px',
  } as React.CSSProperties,
  fieldWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  fieldIcon: {
    fontSize: '13px',
    flexShrink: 0,
    color: 'var(--vscode-descriptionForeground)',
    lineHeight: 1,
  } as React.CSSProperties,
  fieldInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    flex: 1,
    minWidth: 0,
    padding: 0,
  } as React.CSSProperties,
  fieldClear: {
    background: 'transparent',
    border: 'none',
    padding: '1px',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    display: 'flex',
    alignItems: 'center',
    lineHeight: 1,
    flexShrink: 0,
  } as React.CSSProperties,
  pickerBtn: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    padding: '0 8px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'var(--vscode-input-background)',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '12px',
    fontWeight: 'normal',
    boxSizing: 'border-box',
  }),
  disabledPicker: {
    opacity: 0.55,
    cursor: 'default',
  } as React.CSSProperties,
  pickerLabelActive: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    color: 'var(--vscode-input-foreground)',
  },
  pickerLabelPlaceholder: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    fontWeight: 'normal',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'left' as const,
  },
  dropdown: {
    position: 'absolute' as const,
    top: '100%',
    left: 0,
    marginTop: '2px',
    zIndex: 200,
    background: 'var(--vscode-dropdown-background, var(--vscode-input-background))',
    border: '1px solid var(--vscode-dropdown-border, var(--vscode-input-border))',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    width: '100%',
    boxSizing: 'border-box' as const,
    overflow: 'hidden',
  },
  dropdownSearch: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '5px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  dropdownInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    flex: 1,
    padding: 0,
  } as React.CSSProperties,
  dropdownList: {
    overflowY: 'auto' as const,
    maxHeight: '200px',
    padding: '3px 0',
  },
  dropdownItem: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px 10px',
    cursor: 'pointer',
    fontSize: '12px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  dropdownItemLabel: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  authorOption: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1px',
  } as React.CSSProperties,
  authorName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  authorEmail: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  authorCount: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
    minWidth: '18px',
    textAlign: 'right' as const,
  } as React.CSSProperties,
  dropdownEmpty: {
    padding: '6px 10px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    fontStyle: 'italic',
  },
  dropdownGroupLabel: {
    padding: '4px 10px 2px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  dateRange: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  dateInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    width: '108px',
    padding: 0,
  } as React.CSSProperties,
  dateSep: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    userSelect: 'none' as const,
    padding: '0 2px',
  },
  historyChip: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    height: '26px',
    maxWidth: '260px',
    padding: '0 6px 0 8px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    boxSizing: 'border-box' as const,
    color: 'var(--vscode-foreground)',
    fontSize: '12px',
    flexShrink: 1,
  } as React.CSSProperties,
  historyPrefix: {
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
  } as React.CSSProperties,
  historyLabel: {
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  repoDot: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    flexShrink: 0,
    display: 'inline-block',
  } as React.CSSProperties,
  clearBtn: {
    height: '26px',
    width: '26px',
    padding: '0',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-errorForeground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  moreBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '26px',
    height: '26px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-descriptionForeground)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    flexShrink: 0,
  } as React.CSSProperties,
  moreDropdown: {
    position: 'absolute' as const,
    top: '100%',
    right: 0,
    marginTop: '2px',
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    minWidth: '140px',
    zIndex: 1000,
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  } as React.CSSProperties,
  moreItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground, var(--vscode-foreground))',
    whiteSpace: 'nowrap' as const,
    position: 'relative' as const,
  } as React.CSSProperties,
  moreSeparator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
    margin: '4px 0',
  } as React.CSSProperties,
};
