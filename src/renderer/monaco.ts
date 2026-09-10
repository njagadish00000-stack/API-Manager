/**
 * Monaco editor bootstrap — fully offline.
 *
 * Workers are bundled INLINE (base64 Blob workers) so the editor works
 * identically from:
 *   - Electron loading the renderer over file://
 *   - the local hub serving the renderer over http://127.0.0.1
 * No CDN, no external asset paths.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/editor/editor.all.js';
// language services (workers)
import 'monaco-editor/esm/vs/language/json/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/css/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/html/monaco.contribution.js';
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js';
// basic textmate-free languages: xml, graphql, shell, powershell, ini, yaml, markdown…
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution.js';

import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker&inline';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker&inline';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker&inline';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker&inline';

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      switch (label) {
        case 'json': return new JsonWorker();
        case 'css': case 'scss': case 'less': return new CssWorker();
        case 'html': case 'handlebars': case 'razor': return new HtmlWorker();
        case 'typescript': case 'javascript': return new TsWorker();
        default: return new EditorWorker();
      }
    },
  };

  // Dark theme aligned with the app palette (see styles.css)
  monaco.editor.defineTheme('am-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6b7280', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c084fc' },
      { token: 'string', foreground: '86efac' },
      { token: 'number', foreground: 'fbbf24' },
    ],
    colors: {
      'editor.background': '#0f111500',
      'editorGutter.background': '#0f111500',
      'editor.lineHighlightBackground': '#1a1d24',
      'editorLineNumber.foreground': '#4b5563',
      'editorLineNumber.activeForeground': '#9ca3af',
      'editorIndentGuide.background': '#232730',
      'editorCursor.foreground': '#60a5fa',
      'editor.selectionBackground': '#26405f80',
      'editor.findMatchBackground': '#b45309aa',
      'editor.findMatchHighlightBackground': '#a1620766',
      'editorWidget.background': '#161a21',
      'editorWidget.border': '#2a303c',
      'editorSuggestWidget.background': '#161a21',
      'editorSuggestWidget.selectedBackground': '#1f2733',
      'input.background': '#0f1115',
      'input.border': '#2a303c',
      'dropdown.background': '#161a21',
      'scrollbarSlider.background': '#2a303c99',
    },
  });

  monaco.editor.defineTheme('am-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7c3aed' },
      { token: 'string', foreground: '15803d' },
      { token: 'number', foreground: '#b45309' },
    ],
    colors: {
      'editor.background': '#ffffff00',
      'editor.lineHighlightBackground': '#f1f5f9',
      'editorCursor.foreground': '#2563eb',
      'editor.findMatchBackground': '#fde68a',
      'editor.findMatchHighlightBackground': '#fef3c7aa',
    },
  });

  return monaco;
}

export function monacoLanguageFor(bodyType: string): string {
  switch (bodyType) {
    case 'json': return 'json';
    case 'xml': return 'xml';
    case 'html': return 'html';
    case 'javascript': return 'javascript';
    case 'graphql': return 'graphql';
    case 'form-urlencoded': return 'ini';
    case 'multipart': return 'ini';
    default: return 'plaintext';
  }
}

export { monaco };
