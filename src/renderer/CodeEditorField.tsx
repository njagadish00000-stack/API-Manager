/**
 * Code editor field with the mandated toolbar (§13 request-body controls):
 *   zoom out · zoom % · zoom in · reset · word wrap · search · replace · format
 *
 * Backed by Monaco (line numbers, syntax highlight, bracket matching,
 * auto-indent, undo/redo). Search/replace use Monaco's built-in find widgets
 * (Ctrl+F / Ctrl+H). JSON/JS/CSS/HTML formatting uses language workers, with
 * offline core formatters as fallbacks for JSON/XML/GraphQL.
 */
import React, { useRef, useState } from 'react';
import { MonacoEditor, type MonacoEditorHandle } from './MonacoEditor';
import { useApp } from './state';
import { zoomIn, zoomOut, zoomPct, clampZoom } from '../core/response/responseFormat';
import { formatJson } from '../core/jsonx/jsonUtils';
import { formatXml } from '../core/xmlx/xmlUtils';
import { prettifyGraphQL } from '../core/graphqlx/graphql';

export interface CodeEditorFieldProps {
  value: string;
  onChange?: (v: string) => void;
  language?: string;
  readOnly?: boolean;
  minHeight?: number;
  /** Zoom factor (1 = 100%). When omitted, the shared request-editor preference is used. */
  zoom?: number;
  wrap?: boolean;
  onZoom?: (z: number) => void;
  onWrap?: (wrapped: boolean) => void;
  showToolbar?: boolean;
  fontSizeBase?: number;
  placeholder?: string;
}

function formatCode(text: string, language: string): string {
  if (language === 'json') {
    const r = formatJson(text, 2);
    if (r.ok) return r.result;
  }
  if (language === 'xml') {
    const r = formatXml(text);
    if (r.ok) return r.result;
  }
  if (language === 'graphql') {
    const [query, ...rest] = text.split(/^--- variables ---/m);
    let formatted: string;
    try { formatted = prettifyGraphQL(query.trimEnd()); } catch { formatted = query; }
    if (rest.length) return `${formatted}\n\n--- variables ---\n${rest.join('--- variables ---')}`;
    return formatted;
  }
  return text;
}

export function CodeEditorField(props: CodeEditorFieldProps): React.ReactElement {
  const s = useApp();
  const editorRef = useRef<MonacoEditorHandle>(null);
  const zoom = clampZoom(props.zoom ?? s.settings?.editor.requestZoom ?? 1);
  const wrap = props.wrap ?? s.settings?.editor.wordWrap ?? false;
  const [toast, setToast] = useState('');
  const flash = (msg: string): void => { setToast(msg); setTimeout(() => setToast(''), 1400); };

  const setZoom = (z: number): void => { if (props.onZoom) props.onZoom(z); else flash(`${zoomPct(z)}`); };
  const baseFont = props.fontSizeBase ?? s.settings?.editor.fontSize ?? 13;

  const doFormat = (): void => {
    const ed = editorRef.current;
    if (!ed) return;
    const language = props.language ?? 'plaintext';
    // Worker-backed formatting for json/css/html/javascript first
    const ran = ed.format();
    let value = ed.getValue();
    if (language === 'json' || language === 'xml' || language === 'graphql') {
      const formatted = formatCode(value, language);
      if (formatted && formatted !== value) { value = formatted; props.onChange?.(formatted); }
    }
    if (ran || value !== (props.value ?? '')) flash('Formatted');
    else flash('Nothing to format');
  };

  return (
    <div className="code-field">
      {props.showToolbar !== false && (
        <div className="editor-toolbar" title="Request body controls">
          <button type="button" className="btn xs" title="Zoom out (Ctrl+-)" onClick={() => setZoom(zoomOut(zoom))}>−</button>
          <button type="button" className="btn xs zoom-pct" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>{zoomPct(zoom)}</button>
          <button type="button" className="btn xs" title="Zoom in (Ctrl+=)" onClick={() => setZoom(zoomIn(zoom))}>＋</button>
          <button type="button" className="btn xs" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>Reset</button>
          <span className="et-sep" />
          <button type="button" className={`btn xs ${wrap ? 'active' : ''}`} title="Toggle word wrap (Alt+Z)"
            onClick={() => props.onWrap?.(!wrap)}>{wrap ? 'Wrap: ON' : 'Wrap: OFF'}</button>
          <span className="et-sep" />
          <button type="button" className="btn xs" title="Find (Ctrl+F)" onClick={() => editorRef.current?.find()}>🔍 Find</button>
          <button type="button" className="btn xs" title="Find and replace (Ctrl+H)" onClick={() => editorRef.current?.replace()}>⇄ Replace</button>
          <button type="button" className="btn xs" title="Format document (Shift+Alt+F)" onClick={doFormat}>✨ Format</button>
          <span className="spacer" />
          {toast && <span className="et-toast">{toast}</span>}
        </div>
      )}
      <MonacoEditor
        ref={editorRef}
        value={props.value}
        onChange={props.onChange}
        language={props.language}
        readOnly={props.readOnly}
        minHeight={props.minHeight ?? 200}
        fontSize={Math.round(baseFont * zoom)}
        wordWrap={wrap}
        placeholder={props.placeholder}
      />
    </div>
  );
}
