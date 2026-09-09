/**
 * Dataset tools (§data files): CSV / JSON / JSONL parse + generation.
 * - parse: JSON array of objects | JSONL | CSV (RFC-4180-ish, quoted fields)
 * - generate: template syntax `{{$faker.name}}`, `{{$randomInt:1:100}}`,
 *   `{{$guid}}`, `{{$pick:a:b:c}}`, `{{$seq}}`, `{{$date:YYYY-MM-DD}}`,
 *   `{{$word}}`, `{{$email}}`, `{{$uuid}}`
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

export interface ParsedDataset { columns: string[]; rows: Record<string, string>[] }

export function parseDatasetContent(content: string, format: 'csv' | 'json'): ParsedDataset {
  const trimmed = content.trim();
  if (!trimmed) return { columns: [], rows: [] };
  if (format === 'json') {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const rows = parsed.map((item) => flattenRow(item));
        const columns = unique(rows.flatMap((r) => Object.keys(r)));
        return { columns, rows };
      }
      throw new Error('JSON dataset must be an array of objects');
    } catch (e) {
      // try JSONL
      const lines = trimmed.split('\n').filter((l) => l.trim());
      if (lines.length > 0 && lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })) {
        const rows = lines.map((l) => flattenRow(JSON.parse(l)));
        return { columns: unique(rows.flatMap((r) => Object.keys(r))), rows };
      }
      throw new Error(`Invalid JSON dataset: ${e instanceof Error ? e.message : e}`);
    }
  }
  return parseCsv(content);
}

export function parseCsv(content: string): ParsedDataset {
  const rows = csvRows(content);
  if (rows.length === 0) return { columns: [], rows: [] };
  const columns = rows[0].map((c, i) => (c.trim() || `col_${i + 1}`));
  const dataRows = rows.slice(1).filter((r) => r.some((c) => c !== '')).map((r) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < columns.length; i++) obj[columns[i]] = r[i] ?? '';
    return obj;
  });
  return { columns, rows: dataRows };
}

function csvRows(content: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cur.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && content[i + 1] === '\n') i++;
      cur.push(field); field = '';
      rows.push(cur); cur = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || cur.length > 0) { cur.push(field); rows.push(cur); }
  return rows;
}

export function toCsv(columns: string[], rows: Record<string, string>[]): string {
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [columns.map(esc).join(',')];
  for (const row of rows) lines.push(columns.map((c) => esc(row[c] ?? '')).join(','));
  return lines.join('\n');
}

function flattenRow(item: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (item === null || typeof item !== 'object') return { value: String(item) };
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    out[k] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  return out;
}

function unique<T>(arr: T[]): T[] { return [...new Set(arr)]; }

// ---------------------------------------------------------------------------
// Template-driven random generation (no external faker dependency)
// ---------------------------------------------------------------------------

const FIRST = ['Ava', 'Liam', 'Noah', 'Emma', 'Olivia', 'Mason', 'Sophia', 'James', 'Isabella', 'Benjamin', 'Mia', 'Lucas', 'Charlotte', 'Henry', 'Amelia', 'Elijah', 'Harper', 'Jack', 'Evelyn', 'Owen'];
const LAST = ['Smith', 'Johnson', 'Brown', 'Taylor', 'Miller', 'Davis', 'Garcia', 'Wilson', 'Singh', 'Patel', 'Kumar', 'Lee', 'Nguyen', 'Kim', 'Chen', 'Wang', 'Lopez', 'Hernandez', 'Moore', 'Jackson'];
const WORDS = ['apple', 'bridge', 'cloud', 'delta', 'ember', 'forest', 'gale', 'harbor', 'ion', 'jade', 'kite', 'lumen', 'mango', 'nova', 'orbit', 'prism', 'quartz', 'river', 'stone', 'tide', 'umbra', 'vault', 'wave', 'xenon', 'yarn', 'zenith'];
const CITIES = ['Springfield', 'Riverton', 'Lakewood', 'Fairview', 'Greenville', 'Bristol', 'Clinton', 'Georgetown', 'Madison', 'Salem'];
const DOMAINS = ['example.com', 'mail.local', 'test.dev', 'demo.org', 'sample.io'];

function randomOf<T>(arr: T[]): T { return arr[randomInt(arr.length)]; }

const gens: Record<string, (...args: string[]) => string> = {
  guid: () => randomUUID(),
  uuid: () => randomUUID(),
  randomInt: (min = '0', max = '1000') => String(randomInt(Number(min) || 0, (Number(max) || 1000) + 1)),
  randomFloat: (min = '0', max = '1') => (Math.random() * ((Number(max) || 1) - (Number(min) || 0)) + (Number(min) || 0)).toFixed(2),
  boolean: () => (Math.random() < 0.5 ? 'true' : 'false'),
  name: () => `${randomOf(FIRST)} ${randomOf(LAST)}`,
  firstName: () => randomOf(FIRST),
  lastName: () => randomOf(LAST),
  email: () => `${randomOf(FIRST).toLowerCase()}.${randomOf(LAST).toLowerCase()}${randomInt(99)}@${randomOf(DOMAINS)}`,
  username: () => `${randomOf(WORDS)}${randomOf(WORDS)}${randomInt(999)}`,
  word: () => randomOf(WORDS),
  sentence: () => Array.from({ length: randomInt(4, 10) }, () => randomOf(WORDS)).join(' '),
  city: () => randomOf(CITIES),
  phone: () => `+1-${randomInt(200, 999)}-${randomInt(100, 999)}-${randomInt(1000, 9999)}`,
  date: (from = '2024-01-01', to = '2026-12-31') => {
    const a = Date.parse(from) || 0, b = Date.parse(to) || Date.now();
    return new Date(randomInt(Math.min(a, b), Math.max(a, b))).toISOString().slice(0, 10);
  },
  timestamp: () => new Date().toISOString(),
  password: (len = '16') => randomBytes(Math.ceil((Number(len) || 16) / 2)).toString('hex').slice(0, Number(len) || 16),
  hex: (len = '8') => randomBytes(Math.ceil((Number(len) || 8) / 2)).toString('hex').slice(0, Number(len) || 8),
  ip: () => `${randomInt(1, 255)}.${randomInt(255)}.${randomInt(255)}.${randomInt(255)}`,
  url: () => `https://${randomOf(WORDS)}.${randomOf(DOMAINS)}`,
  color: () => `#${randomBytes(3).toString('hex')}`,
  pick: (...opts: string[]) => opts.length > 0 ? randomOf(opts) : '',
};
const gensCountSafe = gens;

let seqCounter = 0;

export function renderDatasetTemplate(template: string, seq: number): string {
  seqCounter = seq;
  return template.replace(/\{\{\s*\$(\w+)(?::([^}]*))?\s*\}\}/g, (_m, name: string, args: string | undefined) => {
    if (name === 'seq') return String(seqCounter);
    const fn = (gensCountSafe as Record<string, (...a: string[]) => string>)[name];
    if (!fn) return `{{$${name}}}`;
    const parts = args ? args.split(':') : [];
    try { return fn(...parts); } catch { return ''; }
  });
}

export function generateDataset(spec: { name: string; template: string; count: number }[]): ParsedDataset {
  const columns = spec.map((s) => s.name);
  const maxCount = Math.max(...spec.map((s) => s.count), 0);
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < maxCount; i++) {
    const row: Record<string, string> = {};
    for (const col of spec) {
      row[col.name] = i < col.count ? renderDatasetTemplate(col.template, i + 1) : '';
    }
    rows.push(row);
  }
  return { columns, rows };
}

export { toCsv as serializeCsv };
