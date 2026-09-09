/** XML utilities: format, validate, minify (§26). */

export interface XmlValidation { ok: boolean; error?: string; line?: number; column?: number; }

/** Lightweight well-formedness check without external deps. */
export function validateXml(text: string): XmlValidation {
  if (!text.trim()) return { ok: false, error: 'Empty document' };
  const stack: { tag: string; pos: number }[] = [];
  let i = 0;
  const n = text.length;
  const at = (pos: number) => ({ line: text.slice(0, pos).split('\n').length, column: pos - text.lastIndexOf('\n', pos) });
  while (i < n) {
    const open = text.indexOf('<', i);
    if (open === -1) break;
    if (text.startsWith('<!--', open)) {
      const close = text.indexOf('-->', open + 4);
      if (close === -1) return { ok: false, error: 'Unterminated comment', ...at(open) };
      i = close + 3; continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      const close = text.indexOf(']]>', open + 9);
      if (close === -1) return { ok: false, error: 'Unterminated CDATA', ...at(open) };
      i = close + 3; continue;
    }
    if (text.startsWith('<?', open) || text.startsWith('<!', open)) {
      const close = text.indexOf('>', open);
      if (close === -1) return { ok: false, error: 'Unterminated declaration', ...at(open) };
      i = close + 1; continue;
    }
    const close = text.indexOf('>', open);
    if (close === -1) return { ok: false, error: 'Unterminated tag', ...at(open) };
    const inner = text.slice(open + 1, close);
    if (inner.endsWith('/')) { i = close + 1; continue; } // self-closing
    if (inner.startsWith('/')) {
      const tag = inner.slice(1).trim().split(/\s+/)[0];
      const top = stack.pop();
      if (!top || top.tag !== tag) {
        return { ok: false, error: `Mismatched closing tag </${tag}>${top ? ` (expected </${top.tag}>)` : ''}`, ...at(open) };
      }
      i = close + 1; continue;
    }
    const tag = inner.trim().split(/[\s/>]/)[0];
    if (!tag) return { ok: false, error: 'Empty tag', ...at(open) };
    stack.push({ tag, pos: open });
    i = close + 1;
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1];
    return { ok: false, error: `Unclosed tag <${top.tag}>`, ...at(top.pos) };
  }
  return { ok: true };
}

/** Pretty-print XML (best-effort, preserving text content). */
export function formatXml(text: string, indent = '  '): { ok: boolean; result: string; error?: string } {
  const v = validateXml(text);
  if (!v.ok) return { ok: false, result: text, error: v.error };
  const min = text.replace(/>\s+</g, '><').trim();
  const parts: string[] = [];
  let level = 0;
  let i = 0;
  const pad = (l: number) => indent.repeat(l);
  while (i < min.length) {
    const open = min.indexOf('<', i);
    if (open === -1) { break; }
    const content = min.slice(i, open);
    if (content) {
      // text between tags: print inline at current level
      parts.push(pad(level) + content);
    }
    let end: number;
    let token: string;
    if (min.startsWith('<!--', open)) { end = min.indexOf('-->', open + 4) + 3; token = min.slice(open, end); parts.push(pad(level) + token); i = end; continue; }
    if (min.startsWith('<![CDATA[', open)) { end = min.indexOf(']]>', open + 9) + 3; token = min.slice(open, end); parts.push(pad(level) + token); i = end; continue; }
    if (min.startsWith('<?', open)) { end = min.indexOf('?>', open) + 2; token = min.slice(open, end); parts.push(pad(level) + token); i = end; continue; }
    if (min.startsWith('<!', open)) { end = min.indexOf('>', open) + 1; token = min.slice(open, end); parts.push(pad(level) + token); i = end; continue; }
    end = min.indexOf('>', open) + 1;
    token = min.slice(open, end);
    const inner = token.slice(1, -1);
    if (inner.startsWith('/')) {
      level = Math.max(0, level - 1);
      // close directly after open+content on same element -> collapse
      const prev = parts[parts.length - 1] ?? '';
      parts.push(pad(level) + token);
      void prev;
    } else if (inner.endsWith('/')) {
      parts.push(pad(level) + token);
    } else {
      parts.push(pad(level) + token);
      level++;
    }
    i = end;
  }
  return { ok: true, result: parts.join('\n') };
}

export function minifyXml(text: string): { ok: boolean; result: string; error?: string } {
  const v = validateXml(text);
  if (!v.ok) return { ok: false, result: text, error: v.error };
  const result = text.replace(/>\s+</g, '><').replace(/<!--[\s\S]*?-->/g, '').trim();
  return { ok: true, result };
}

/** Escape special characters for XML text content. */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
