/**
 * Shared UI primitives: toast host, modal, key/value editor, tree, code
 * viewer with syntax highlight, KV editing helpers, chart wrapper.
 */
import React, { createElement, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyValue } from '../shared/types';
import { uid } from '../shared/ids';
import { useApp } from './state';

// ---------------------------------------------------------------------------
// Toasts
export function ToastHost(): React.ReactElement {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind === 'ok' ? 'ok' : t.kind === 'err' ? 'err' : t.kind === 'warn' ? 'warn' : ''}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal
export function Modal(props: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }): React.ReactElement {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal" style={props.wide ? { width: 920 } : undefined}>
        <div className="m-head">
          <span>{props.title}</span><span className="spacer" />
          <button className="icon-btn" onClick={props.onClose}>✕</button>
        </div>
        <div className="m-body">{props.children}</div>
        {props.footer && <div className="m-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmButton(props: { label: string; onConfirm: () => void; className?: string; confirmText?: string }): React.ReactElement {
  const [armed, setArmed] = useState(false);
  return (
    <button
      className={props.className ?? 'btn danger sm'}
      onClick={() => { if (armed) { props.onConfirm(); setArmed(false); } else { setArmed(true); setTimeout(() => setArmed(false), 3000); } }}
    >{armed ? (props.confirmText ?? 'Confirm?') : props.label}</button>
  );
}

// ---------------------------------------------------------------------------
// Key/value editor
export function KVEditor(props: { items: KeyValue[]; onChange: (items: KeyValue[]) => void; keyHint?: string; valueHint?: string; allowDesc?: boolean }): React.ReactElement {
  const items = props.items;
  const update = (idx: number, patch: Partial<KeyValue>): void => {
    const next = items.map((it, i) => (i === idx ? { ...it, ...patch } : it));
    props.onChange(next);
  };
  const remove = (idx: number): void => props.onChange(items.filter((_, i) => i !== idx));
  const add = (): void => props.onChange([...items, { id: uid(), key: '', value: '', enabled: true }]);
  return (
    <div>
      <div className="kv-row" style={{ color: 'var(--fg2)', fontSize: 11 }}>
        <span /><span>{props.keyHint ?? 'KEY'}</span><span>{props.valueHint ?? 'VALUE'}</span><span />
      </div>
      {items.map((it, i) => (
        <div key={it.id}>
          <div className="kv-row">
            <input type="checkbox" checked={it.enabled} onChange={(e) => update(i, { enabled: e.target.checked })} />
            <input className="input sm" placeholder={props.keyHint ?? 'Key'} value={it.key} onChange={(e) => update(i, { key: e.target.value })} />
            <input className="input sm" placeholder={props.valueHint ?? 'Value'} value={it.value} onChange={(e) => update(i, { value: e.target.value })} />
            <span />
            <button className="icon-btn" onClick={() => remove(i)}>✕</button>
          </div>
          {props.allowDesc && (
            <div className="kv-row"><span /><div className="desc">
              <input className="input sm" style={{ width: '100%' }} placeholder="Description" value={it.description ?? ''} onChange={(e) => update(i, { description: e.target.value })} />
            </div></div>
          )}
        </div>
      ))}
      <button className="btn sm" onClick={add}>+ Add</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree
export interface TreeNode<V = unknown> { id: string; label: React.ReactNode; icon?: React.ReactNode; children?: TreeNode<V>[]; value?: V; meta?: React.ReactNode }

export function Tree<V>(props: {
  nodes: TreeNode<V>[];
  selected?: string | null;
  onSelect?: (n: TreeNode<V>) => void;
  onContext?: (n: TreeNode<V>, e: React.MouseEvent) => void;
  depth?: number;
  /** Controlled expansion (persisted across restarts). Expanded = present in set. */
  expandedIds?: Set<string>;
  onToggle?: (id: string, expanded: boolean) => void;
  /** When provided, nodes with children default to expanded instead of collapsed. */
  defaultExpanded?: boolean;
}): React.ReactElement {
  const [internalCollapsed, setInternalCollapsed] = useState<Set<string>>(new Set());
  const depth = props.depth ?? 0;
  const isExpanded = (id: string): boolean => {
    if (props.expandedIds) return props.expandedIds.has(id);
    if (internalCollapsed.has(id)) return false;
    return props.defaultExpanded ?? true;
  };
  const toggle = (id: string): void => {
    const next = !isExpanded(id);
    if (props.onToggle) props.onToggle(id, next);
    else setInternalCollapsed((c) => { const n = new Set(c); if (next) n.delete(id); else n.add(id); return n; });
  };
  return (
    <div>
      {props.nodes.map((n) => (
        <div key={n.id}>
          <div className={`tree-item ${props.selected === n.id ? 'sel' : ''}`}
            onClick={() => { if (n.children?.length) toggle(n.id); props.onSelect?.(n); }}
            onContextMenu={(e) => props.onContext?.(n, e)}>
            {n.children?.length ? <span style={{ width: 12, display: 'inline-block', flexShrink: 0, color: 'var(--muted)' }}>{isExpanded(n.id) ? '▾' : '▸'}</span> : <span style={{ width: 12, display: 'inline-block' }} />}
            {n.icon}
            <span className="ti-label">{n.label}</span>
            {n.meta}
          </div>
          {n.children && isExpanded(n.id) && (
            <div className="tree-child">
              <Tree {...props} depth={depth + 1} nodes={n.children} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context menu
export interface CtxItem { label: string; danger?: boolean; onClick: () => void; sep?: boolean }
export function useContextMenu(): { ctx: React.ReactElement | null; open: (e: React.MouseEvent, items: CtxItem[]) => void } {
  const [state, setState] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  useEffect(() => {
    if (!state) return;
    const close = (): void => setState(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [state]);
  const open = (e: React.MouseEvent, items: CtxItem[]): void => {
    e.preventDefault(); e.stopPropagation();
    setState({ x: e.clientX, y: e.clientY, items });
  };
  const ctx = state ? (
    <div className="ctx-menu" style={{ left: state.x, top: state.y }}>
      {state.items.map((it, i) => (
        <div key={i} className={`ci ${it.danger ? 'danger' : ''}`} onClick={() => { it.onClick(); setState(null); }}>{it.label}</div>
      ))}
    </div>
  ) : null;
  return { ctx, open };
}

// ---------------------------------------------------------------------------
// JSON syntax highlighting read-only view
import { markSearch } from './responseExport';
export * from './responseExport';

/** Download helper used by response "Save as..." actions (no server round-trips, fully offline). */
export function saveBlob(name: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function JsonView(props: {
  text: string;
  nowrap?: boolean;
  wrap?: boolean;
  maxHeight?: number;
  search?: string;
  searchOpts?: import('./responseExport').SearchOptions;
}): React.ReactElement {
  const wrap = props.wrap ?? (props.nowrap === undefined ? true : !props.nowrap);
  const html = useMemo(() => {
    const t = props.text;
    let out = '';
    try {
      const parsed = JSON.parse(t) as unknown;
      out = JSON.stringify(parsed, null, 2);
    } catch { out = t; }
    return markSearch(highlightJson(out), props.search ?? '', props.searchOpts ?? {});
  }, [props.text, props.search, props.searchOpts]);
  return (
    <pre className={`resp-body ${wrap ? 'wrap' : 'nowrap'}`} style={props.maxHeight ? { maxHeight: props.maxHeight, overflow: 'auto' } : undefined}
      dangerouslySetInnerHTML={{ __html: html }} />
  );
}

export function highlightJson(json: string): string {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g, (m) => {
      if (/^"/.test(m)) {
        return /:$/.test(m) ? `<span class="json-k">${m}</span>` : `<span class="json-s">${m}</span>`;
      }
      if (/^(true|false|null)$/.test(m)) return `<span class="json-b">${m}</span>`;
      return `<span class="json-n">${m}</span>`;
    });
}

// ---------------------------------------------------------------------------
// Code editor (textarea-based; Monaco correctness decisions documented in README)
export function CodeArea(props: { value: string; onChange?: (v: string) => void; language?: string; minRows?: number; placeholder?: string; readOnly?: boolean; nowrap?: boolean }): React.ReactElement {
  const rows = Math.max(props.minRows ?? 3, Math.min(40, (props.value.match(/\n/g)?.length ?? 0) + 1));
  return (
    <textarea
      className="input mono"
      rows={rows}
      wrap={props.nowrap ? 'off' : 'soft'}
      value={props.value}
      readOnly={props.readOnly}
      placeholder={props.placeholder}
      spellCheck={false}
      onChange={(e) => props.onChange?.(e.target.value)}
      onKeyDown={(e) => {
        const ta = e.currentTarget;
        if (e.key === 'Tab') {
          e.preventDefault();
          const { selectionStart: s, selectionEnd: en } = ta;
          const next = props.value.slice(0, s) + '  ' + props.value.slice(en);
          props.onChange?.(next);
          requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = s + 2; });
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Sub tabs
export interface SubTab { id: string; label: React.ReactNode; count?: number }
export function SubTabs(props: { tabs: SubTab[]; active: string; onChange: (id: string) => void }): React.ReactElement {
  return (
    <div className="subtabbar">
      {props.tabs.map((t) => (
        <div key={t.id} className={`st ${props.active === t.id ? 'active' : ''}`} onClick={() => props.onChange(t.id)}>
          {t.label}{typeof t.count === 'number' && t.count > 0 ? <span className="count">{t.count}</span> : null}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart.js canvas binding
export function Chart(props: { config: unknown; height?: number; deps?: unknown[] }): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const inst = useRef<{ destroy: () => void } | null>(null);
  useEffect(() => {
    let disposed = false;
    void import('chart.js/auto').then((mod) => {
      if (disposed || !ref.current) return;
      inst.current?.destroy();
      const ChartCtor = (mod as { default: new (ctx: HTMLCanvasElement, c: unknown) => { destroy: () => void } }).default;
      inst.current = new ChartCtor(ref.current, props.config);
    });
    return () => { disposed = true; inst.current?.destroy(); inst.current = null; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, props.deps ?? [JSON.stringify(props.config)]);
  return <canvas ref={ref} height={props.height ?? 220} />;
}

// ---------------------------------------------------------------------------
// Env selector
export function EnvSelect(): React.ReactElement {
  const envs = useApp((s) => s.environments);
  const active = useApp((s) => s.activeEnvironmentId);
  const setActive = useApp((s) => s.setActiveEnvironment);
  const refreshEnv = useApp((s) => s.refreshEnvironments);
  return (
    <select className="input sm" style={{ width: 150 }} value={active ?? ''} onChange={(e) => { void setActive(e.target.value || null); }}>
      <option value="">No Environment</option>
      {envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>
  );
}

export function prettyPath(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return url; }
}
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
export function ts(s?: string): string {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}
export { uid };
export const h = createElement;
