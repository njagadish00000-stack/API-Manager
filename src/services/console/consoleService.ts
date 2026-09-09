/**
 * Dev console (§33): persistent JSONL app log with level/source filters,
 * retention by age, export, and live event emission for the UI panel.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConsoleLogEntry } from '../../shared/types';
import { uid } from '../../shared/ids';
import { now } from '../../shared/types';

export interface ConsoleDeps {
  filePath: string;
  maxEntries: number;
  retentionHours: number;
  emit: (type: 'console.log', payload: ConsoleLogEntry) => void;
}

export class ConsoleStore {
  private cache: ConsoleLogEntry[] = [];
  private loaded = false;

  constructor(private deps: ConsoleDeps) {}

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (existsSync(this.deps.filePath)) {
      try {
        for (const line of readFileSync(this.deps.filePath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this.cache.push(JSON.parse(line) as ConsoleLogEntry); } catch { /* skip corrupt line */ }
        }
        this.cache = this.cache.slice(-this.deps.maxEntries);
      } catch { /* unreadable → start fresh */ }
    }
  }

  log(level: string, source: string, message: string): void {
    this.ensureLoaded();
    const entry: ConsoleLogEntry = {
      id: uid(), timestamp: now(),
      level: (['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info') as ConsoleLogEntry['level'],
      source, message,
    };
    this.cache.push(entry);
    if (this.cache.length > this.deps.maxEntries) this.cache.splice(0, this.cache.length - this.deps.maxEntries);
    try {
      mkdirSync(dirname(this.deps.filePath), { recursive: true });
      appendFileSync(this.deps.filePath, JSON.stringify(entry) + '\n');
    } catch { /* filesystem trouble must never break logging */ }
    try { this.deps.emit('console.log', entry); } catch { /* UI not ready */ }
  }

  list(filter: { level?: string; source?: string; search?: string; limit?: number } = {}): ConsoleLogEntry[] {
    this.ensureLoaded();
    let out = [...this.cache].reverse();
    if (filter.level) out = out.filter((e) => e.level === filter.level);
    if (filter.source) out = out.filter((e) => e.source?.includes(filter.source ?? ''));
    if (filter.search) out = out.filter((e) => e.message.toLowerCase().includes((filter.search ?? '').toLowerCase()));
    if (filter.limit && filter.limit > 0) out = out.slice(0, filter.limit);
    return out;
  }

  clear(): void {
    this.cache = [];
    try { if (existsSync(this.deps.filePath)) writeFileSync(this.deps.filePath, ''); } catch { /* ignore */ }
  }

  pruneOld(): number {
    this.ensureLoaded();
    const cutoff = Date.now() - this.deps.retentionHours * 3600_000;
    const before = this.cache.length;
    this.cache = this.cache.filter((e) => Date.parse(e.timestamp) >= cutoff);
    const removed = before - this.cache.length;
    if (removed > 0) this.rewrite();
    return removed;
  }

  private rewrite(): void {
    try {
      const tmp = `${this.deps.filePath}.tmp`;
      writeFileSync(tmp, this.cache.map((e) => JSON.stringify(e)).join('\n') + (this.cache.length > 0 ? '\n' : ''));
      renameSync(tmp, this.deps.filePath);
    } catch { /* ignore */ }
  }

  exportText(): string {
    return this.list().map((e) => `${e.timestamp} [${e.level}] ${e.source ?? 'app'}: ${e.message}`).join('\n');
  }
}
