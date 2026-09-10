/**
 * Monaco-backed code editor (§10 request editor / §13 body controls).
 *
 * Exposes an imperative handle for the surrounding toolbar:
 *   format() · find() · replace() · zoom(delta|reset) · setWordWrap()
 * and a `formatAsJson()` fallback used when a language has no formatter worker.
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { setupMonaco, monaco } from './monaco';

export interface MonacoEditorHandle {
  format: () => boolean;
  find: () => void;
  replace: () => void;
  setFontSize: (px: number) => void;
  setWordWrap: (on: boolean) => void;
  focus: () => void;
  getValue: () => string;
}

export interface MonacoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  minHeight?: number;
  fontSize?: number;
  wordWrap?: boolean;
  lineNumbers?: boolean;
  minimap?: boolean;
  tabSize?: number;
  placeholder?: string;
}

export const MonacoEditor = forwardRef<MonacoEditorHandle, MonacoEditorProps>(function MonacoEditor(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<monaco.editor.ITextModel | null>(null);
  // latest-prop refs avoid recreating the editor on every keystroke
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const m = setupMonaco();
    const currentTheme = document.documentElement.getAttribute('data-theme') === 'light' ? 'am-light' : 'am-dark';
    const editor = m.editor.create(containerRef.current!, {
      value: props.value ?? '',
      language: props.language ?? 'plaintext',
      theme: currentTheme,
      automaticLayout: true,
      fontSize: props.fontSize ?? 13,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      wordWrap: props.wordWrap ? 'on' : 'off',
      lineNumbers: props.lineNumbers === false ? 'off' : 'on',
      minimap: { enabled: !!props.minimap },
      scrollBeyondLastLine: false,
      tabSize: props.tabSize ?? 2,
      insertSpaces: true,
      autoIndent: 'advanced',
      matchBrackets: 'always',
      autoClosingBrackets: 'always',
      autoClosingQuotes: 'always',
      bracketPairColorization: { enabled: true },
      renderWhitespace: 'none',
      smoothScrolling: true,
      readOnly: !!props.readOnly,
      domReadOnly: !!props.readOnly,
      padding: { top: 8, bottom: 8 },
      fixedOverflowWidgets: true,
      find: { addExtraSpaceOnTop: false, autoFindInSelection: 'never' },
    });
    editorRef.current = editor;
    modelRef.current = editor.getModel();

    const sub = editor.onDidChangeModelContent(() => {
      propsRef.current.onChange?.(editor.getValue());
    });

    // follow the app theme (settings/top-level toggles)
    const observer = new MutationObserver(() => {
      const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'am-light' : 'am-dark';
      m.editor.setTheme(t);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    return (): void => {
      observer.disconnect();
      sub.dispose();
      editor.getModel()?.dispose();
      editor.dispose();
      editorRef.current = null;
      modelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // external value updates (e.g. switching tabs / applying cURL import)
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    if (ed.getValue() !== props.value) ed.setValue(props.value ?? '');
  }, [props.value]);

  useEffect(() => {
    const model = modelRef.current;
    if (model) monaco.editor.setModelLanguage(model, props.language ?? 'plaintext');
  }, [props.language]);

  useEffect(() => { editorRef.current?.updateOptions({ readOnly: !!props.readOnly, domReadOnly: !!props.readOnly }); }, [props.readOnly]);
  useEffect(() => { editorRef.current?.updateOptions({ wordWrap: props.wordWrap ? 'on' : 'off' }); }, [props.wordWrap]);
  useEffect(() => { editorRef.current?.updateOptions({ lineNumbers: props.lineNumbers === false ? 'off' : 'on' }); }, [props.lineNumbers]);
  useEffect(() => { if (props.fontSize) editorRef.current?.updateOptions({ fontSize: props.fontSize }); }, [props.fontSize]);
  useEffect(() => { editorRef.current?.updateOptions({ minimap: { enabled: !!props.minimap } }); }, [props.minimap]);

  useImperativeHandle(ref, (): MonacoEditorHandle => ({
    format: () => {
      const ed = editorRef.current;
      const lang = propsRef.current.language ?? 'plaintext';
      if (!ed) return false; {
        const action = ed.getAction('editor.action.formatDocument');
        if (action) {
          void action.run();
          // workers format JSON/CSS/HTML/TS/JS; verify a change happened is unnecessary
          return true;
        }
      }
      // last-resort JSON pretty-print
      if (lang === 'json' || lang === 'plaintext') {
        try {
          const parsed = JSON.parse(ed.getValue());
          ed.setValue(JSON.stringify(parsed, null, propsRef.current.tabSize ?? 2));
          return true;
        } catch { /* not JSON */ }
      }
      return false;
    },
    find: () => { void editorRef.current?.getAction('actions.find')?.run(); editorRef.current?.focus(); },
    replace: () => { void editorRef.current?.getAction('editor.action.startFindReplaceAction')?.run(); editorRef.current?.focus(); },
    setFontSize: (px) => editorRef.current?.updateOptions({ fontSize: Math.max(8, Math.min(32, px)) }),
    setWordWrap: (on) => editorRef.current?.updateOptions({ wordWrap: on ? 'on' : 'off' }),
    focus: () => editorRef.current?.focus(),
    getValue: () => editorRef.current?.getValue() ?? '',
  }), []);

  return (
    <div
      ref={containerRef}
      className="monaco-host"
      style={{ minHeight: props.minHeight ?? 220, height: '100%', width: '100%' }}
      data-placeholder={props.placeholder}
    />
  );
});
