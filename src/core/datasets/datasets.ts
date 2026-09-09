/** Dataset parsing: CSV (RFC4180-ish) and JSON (§38). */

export interface ParsedDataset { columns: string[]; rows: Record<string, string>[] }

export function parseCsv(content: string): ParsedDataset {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { cur.push(field); field = ''; continue; }
    if (c === '\n') { cur.push(field); field = ''; rows.push(cur); cur = []; continue; }
    field += c;
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (nonEmpty.length === 0) return { columns: [], rows: [] };
  const columns = nonEmpty[0].map((h) => h.trim());
  const data = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    columns.forEach((col, i) => { obj[col] = r[i] ?? ''; });
    return obj;
  });
  return { columns, rows: data };
}

export function serializeCsv(parsed: ParsedDataset): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [parsed.columns.map(esc).join(',')];
  for (const row of parsed.rows) lines.push(parsed.columns.map((c) => esc(row[c] ?? '')).join(','));
  return lines.join('\n');
}

export function parseJsonDataset(content: string): ParsedDataset {
  const parsed: unknown = JSON.parse(content);
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const columns: string[] = [];
  const rows: Record<string, string>[] = [];
  for (const item of arr) {
    if (item && typeof item === 'object') {
      const row: Record<string, string> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (!columns.includes(k)) columns.push(k);
        row[k] = typeof v === 'string' ? v : JSON.stringify(v);
      }
      rows.push(row);
    }
  }
  return { columns, rows };
}

export function parseDataset(content: string, format: 'csv' | 'json'): ParsedDataset {
  return format === 'csv' ? parseCsv(content) : parseJsonDataset(content);
}
