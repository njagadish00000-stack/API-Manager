/**
 * Global developer console drawer (§38): request/response/script/network logs.
 * Combines persisted backend console entries (console.list) with live bridge
 * events (ws/sse/mqtt frames, mock logs, script console output).
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { call, onEvent } from './bridge';
import { useApp } from './state';
import { fmtMs, ts } from './components';

interface ConsoleRow {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  source: string;
  message: string;
}

const LEVELS = ['all', 'info', 'warn', 'error', 'debug'] as const;

export function ConsoleDrawer(): React.ReactElement | null {
  const s = useApp();
  const [rows, setRows] = useState<ConsoleRow[]>([]);
  const [filter, setFilter] = useState<(typeof LEVELS)[number]>('all');
  const [query, setQuery] = useState('');
  const [timestamps, setTimestamps] = useState(true);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const seq = useRef(0);

  const push = (level: ConsoleRow['level'], source: string, message: string): void => {
    setRows((r) => [...r.slice(-1999), { id: `live-${seq.current++}`, ts: new Date().toISOString(), level, source, message }]);
  };

  useEffect(() => {
    if (!s.consoleOpen) return;
    void call<{ items?: unknown[] } | unknown[]>('console.list', { limit: 300 }).then((r) => {
      const items = Array.isArray(r) ? r : (r.items ?? []);
      const mapped: ConsoleRow[] = items.map((x: unknown, i: number) => {
        const e = x as { timestamp?: string; level?: string; source?: string; message?: string; args?: unknown[] };
        return {
          id: `hist-${i}`,
          ts: e.timestamp ?? new Date().toISOString(),
          level: (e.level as ConsoleRow['level']) ?? 'info',
          source: e.source ?? 'app',
          message: e.message ?? (e.args ? JSON.stringify(e.args) : JSON.stringify(e)),
        };
      });
      setRows(mapped);
    }).catch(() => undefined);
  }, [s.consoleOpen]);

  useEffect(() => {
    const offs = [
      onEvent((ev) => {
        if (ev.type === 'console.log') {
          const p = ev.payload as { level?: string; source?: string; message?: string; args?: unknown[]; timestamp?: string };
          push((p.level as ConsoleRow['level']) ?? 'info', p.source ?? 'script', p.message ?? (p.args ? p.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') : ''));
        } else if (ev.type === 'ws.message') {
          const p = ev.payload as { direction: string; data: string; ts: string };
          push('debug', `ws ${p.direction}`, p.data);
        } else if (ev.type === 'sse.frame') {
          const p = ev.payload as { event?: string; data: string };
          push('debug', 'sse', `${p.event ?? 'message'}: ${p.data}`);
        } else if (ev.type === 'mqtt.message') {
          const p = ev.payload as { topic: string; payload: string };
          push('debug', 'mqtt', `${p.topic} → ${p.payload}`);
        } else if (ev.type === 'mock.log') {
          const p = ev.payload as { method?: string; url?: string; status?: number };
          push('info', 'mock', `${p.method ?? ''} ${p.url ?? ''} → ${p.status ?? ''}`);
        } else if (ev.type === 'capture.exchange') {
          const p = ev.payload as { method?: string; url?: string; status?: number };
          push('info', 'capture', `${p.method ?? ''} ${p.url ?? ''} → ${p.status ?? ''}`);
        } else if (ev.type === 'request.progress') {
          const p = ev.payload as { phase: string; detail?: string; opId?: string };
          if (['done', 'server'].includes(p.phase)) push('debug', 'http', `${p.phase}${p.detail ? ` · ${p.detail}` : ''} (${fmtMs(0)})`);
        }
      }),
    ];
    return (): void => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    if (s.consoleOpen && bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [rows, s.consoleOpen]);

  const shown = useMemo(() => rows.filter((r) => {
    if (filter !== 'all' && r.level !== filter) return false;
    if (query && !`${r.source} ${r.message}`.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  }), [rows, filter, query]);

  if (!s.consoleOpen) return null;

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault();
    const move = (ev: MouseEvent): void => s.setConsoleHeight(window.innerHeight - ev.clientY - 26);
    const up = (): void => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); void s.flushSession(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const copyAll = (): void => {
    const text = shown.map((r) => `${r.ts} [${r.level}] ${r.source}: ${r.message}`).join('\n');
    void navigator.clipboard.writeText(text).then(() => s.toast('ok', `Copied ${shown.length} log lines`));
  };

  return (
    <div className="console-drawer" style={{ height: s.consoleHeight }}>
      <div className="cd-resize" onMouseDown={startResize} title="Drag to resize" />
      <div className="cd-head">
        <b style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>Console</b>
        <span className="dim" style={{ fontSize: 11.5 }}>{shown.length} / {rows.length}</span>
        <select className="input sm" style={{ width: 110 }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          {LEVELS.map((l) => <option key={l} value={l}>{l === 'all' ? 'All levels' : l}</option>)}
        </select>
        <input className="input sm" style={{ width: 220 }} placeholder="Filter logs…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="checkbox" style={{ fontSize: 11.5 }}><input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> timestamps</label>
        <span className="spacer" />
        <button className="btn xs" onClick={copyAll}>Copy</button>
        <button className="btn xs" onClick={() => { void call('console.clear', {}).catch(() => undefined); setRows([]); }}>Clear</button>
        <button className="btn xs" onClick={() => s.setConsoleOpen(false)}>✕</button>
      </div>
      <div className="cd-body mono" ref={bodyRef}>
        {shown.length === 0 && <div className="muted" style={{ padding: 10 }}>No log entries yet. Send a request or use console.log(…) in scripts.</div>}
        {shown.map((r) => (
          <div key={r.id} className={`cd-line cd-${r.level}`}>
            {timestamps && <span className="cd-ts">{ts(r.ts)}</span>}
            <span className="cd-src">{r.source}</span>
            <span className="cd-msg">{r.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
