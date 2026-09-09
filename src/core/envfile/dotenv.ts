/** .env file parsing/serialization (§17). */
import type { Variable } from '../../shared/types';
import { uid } from '../../shared/ids';

export function parseDotEnv(content: string): Variable[] {
  const vars: Variable[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().replace(/^export\s+/, '');
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // inline comment for unquoted values
    if (!rawLine.includes('"') && !rawLine.includes("'")) {
      const hashIdx = value.indexOf(' #');
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    const secret = /key|secret|token|pass|cred|auth/i.test(key);
    vars.push({ id: uid(), key, value, type: secret ? 'secret' : 'default', enabled: true });
  }
  return vars;
}

export function serializeDotEnv(vars: Variable[], revealSecrets = false): string {
  return vars.filter((v) => v.enabled).map((v) => {
    const value = v.type === 'secret' && !revealSecrets ? '' : v.value;
    const needsQuote = /[\s#]/.test(value);
    return `${v.key}=${needsQuote ? `"${value.replace(/"/g, '\\"')}"` : value}`;
  }).join('\n') + '\n';
}
