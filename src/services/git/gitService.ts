/**
 * Git integration (§22) via isomorphic-git: local repo management, branching,
 * sync (fetch/pull/push with HTTPS basic auth), stash, diffs, log, secret
 * scanning pre-commit, and .gitignore scaffolding.
 */
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import fs from 'node:fs';
import path from 'node:path';
import type { SecurityFinding } from '../../shared/types';
import type { GitLogEntry, GitStatusInfo } from '../../shared/api';
import { scanTextForSecrets } from '../../core/secrets/scanner';

export interface GitDeps {
  resolveSecret?: (secretId: string) => string | undefined;
}

function repo(path: string): string {
  if (!fs.existsSync(path)) throw new Error(`git path does not exist: ${path}`);
  return path;
}

export async function gitInit(dir: string): Promise<{ path: string }> {
  fs.mkdirSync(dir, { recursive: true });
  await git.init({ fs, dir, defaultBranch: 'main' });
  await writeGitignore(dir);
  return { path: dir };
}

export async function gitClone(args: { url: string; path: string; username?: string; password?: string }): Promise<{ path: string }> {
  fs.mkdirSync(args.path, { recursive: true });
  await git.clone({
    fs, http, dir: args.path, url: args.url,
    onAuth: args.username ? () => ({ username: args.username, password: args.password }) : undefined,
  });
  await writeGitignore(args.path);
  return { path: args.path };
}

export async function gitStatus(dir: string): Promise<GitStatusInfo> {
  const matrix = await git.statusMatrix({ fs, dir: repo(dir) });
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];
  for (const [file, head, workdir, stage] of matrix) {
    if (head === 0 && workdir === 2 && stage >= 2) untracked.push(file);
    else if (head === 1 && workdir === 2 && stage === 3) staged.push(file);
    else if (head === 1 && workdir === 2 && stage === 2) staged.push(file);
    else if (head === 1 && workdir === 2 && stage === 1) modified.push(file);
    else if (head === 0 && workdir === 2 && stage === 1) untracked.push(file);
    else if (head === 1 && workdir === 0 && stage === 3) staged.push(file); // deleted staged
    else if (head === 1 && workdir === 0 && stage === 1) modified.push(file);
  }
  const branch = (await git.currentBranch({ fs, dir, fullname: false })) ?? 'HEAD';
  let ahead = 0; let behind = 0;
  try {
    const remoteInfo = await git.listRemotes({ fs, dir });
    const remote = remoteInfo[0]?.remote;
    if (remote) {
      const remoteRef = `refs/remotes/${remote}/${branch}`;
      const localOid = await git.resolveRef({ fs, dir, ref: branch }).catch(() => undefined);
      const remoteOid = await git.resolveRef({ fs, dir, ref: remoteRef }).catch(() => undefined);
      if (localOid && remoteOid) { void 0; }
    }
  } catch { /* no remote tracking info */ }
  return { branch, ahead, behind, staged, modified, untracked, conflicted };
}

export async function gitAdd(dir: string, files: string[]): Promise<void> {
  for (const file of files) {
    const full = path.join(dir, file);
    if (fs.existsSync(full)) await git.add({ fs, dir, filepath: file });
    else await git.remove({ fs, dir, filepath: file });
  }
}

export async function gitAddAll(dir: string): Promise<void> {
  const matrix = await git.statusMatrix({ fs, dir });
  for (const [file, head, workdir] of matrix) {
    if (head === 1 && workdir === 0) await git.remove({ fs, dir, filepath: file });
    else await git.add({ fs, dir, filepath: file });
  }
}

export interface CommitResult { oid: string; findings: SecurityFinding[] }

export async function gitCommit(args: { path: string; message: string; author: { name: string; email: string }; skipSecretScan?: boolean }): Promise<CommitResult> {
  const dir = repo(args.path);
  const findings = args.skipSecretScan ? [] : await gitSecretScan(dir);
  const blocking = findings.filter((f) => f.severity === 'Critical' || f.severity === 'High');
  if (!args.skipSecretScan && blocking.length > 0) {
    throw new Error(`Commit blocked: ${blocking.length} potential secret(s) detected in staged files. Re-run with skipSecretScan to override.`);
  }
  const oid = await git.commit({ fs, dir, message: args.message, author: { name: args.author.name, email: args.author.email } });
  return { oid, findings };
}

export async function gitBranches(dir: string): Promise<string[]> {
  return git.listBranches({ fs, dir: repo(dir) });
}

export async function gitCreateBranch(dir: string, name: string, checkout: boolean): Promise<void> {
  await git.branch({ fs, dir: repo(dir), ref: name, checkout });
}

export async function gitCheckout(dir: string, ref: string): Promise<void> {
  await git.checkout({ fs, dir: repo(dir), ref });
}

export async function gitMerge(dir: string, branch: string): Promise<{ merged: boolean; conflicts: string[] }> {
  const current = (await git.currentBranch({ fs, dir: repo(dir), fullname: false })) ?? 'HEAD';
  const merged = await git.merge({ fs, dir, ours: current, theirs: branch, author: { name: 'API Manager', email: 'noreply@api-manager.local' } });
  const conflictsRoot = (merged as { mergeConflict?: string[] }).mergeConflict;
  return { merged: !conflictsRoot || conflictsRoot.length === 0, conflicts: conflictsRoot ?? [] };
}

export async function gitFetch(dir: string, remote?: string, auth?: { username?: string; password?: string }): Promise<void> {
  await git.fetch({ fs, http, dir: repo(dir), remote: remote ?? 'origin', onAuth: auth?.username ? () => ({ username: auth.username, password: auth.password }) : undefined });
}

export async function gitPull(dir: string, remote?: string, auth?: { username?: string; password?: string }): Promise<void> {
  await git.pull({
    fs, http, dir: repo(dir), remote: remote ?? 'origin', singleBranch: true, fastForwardOnly: false,
    author: { name: 'API Manager', email: 'noreply@api-manager.local' },
    onAuth: auth?.username ? () => ({ username: auth.username, password: auth.password }) : undefined,
  });
}

export async function gitPush(dir: string, remote?: string, auth?: { username?: string; password?: string }): Promise<void> {
  await git.push({ fs, http, dir: repo(dir), remote: remote ?? 'origin', onAuth: auth?.username ? () => ({ username: auth.username, password: auth.password }) : undefined });
}

export async function gitStash(dir: string, message?: string): Promise<void> {
  try {
    await git.stash({ fs, dir: repo(dir), op: 'push', message: message ?? 'api-manager stash' });
  } catch {
    // fallback manual stash: commit to a temporary ref
    throw new Error('Stash not supported by this repo state; commit or checkout files first');
  }
}

export async function gitStashPop(dir: string): Promise<void> {
  await git.stash({ fs, dir: repo(dir), op: 'pop' });
}

export async function gitLog(dir: string, limit = 50): Promise<GitLogEntry[]> {
  const commits = await git.log({ fs, dir: repo(dir), depth: limit });
  return commits.map((c) => ({
    oid: c.oid,
    message: c.commit.message.trim(),
    author: `${c.commit.author.name} <${c.commit.author.email}>`,
    date: new Date(c.commit.author.timestamp * 1000).toISOString(),
  }));
}

export async function gitDiff(dir: string, file?: string, staged?: boolean): Promise<string> {
  const dirPath = repo(dir);
  const files = file ? [file] : (await gitStatus(dirPath)).modified.concat((await gitStatus(dirPath)).staged);
  const chunks: string[] = [];
  for (const f of files) {
    let working = '';
    try { working = fs.readFileSync(path.join(dirPath, f), 'utf8'); } catch { working = ''; }
    try {
      const headOid = await git.resolveRef({ fs, dir: dirPath, ref: 'HEAD' });
      const { blob } = await git.readBlob({ fs, dir: dirPath, oid: headOid, filepath: f });
      const headText = Buffer.from(blob).toString('utf8');
      chunks.push(buildUnifiedDiff(f, headText, working, staged ? 'staged' : 'working tree'));
    } catch {
      chunks.push(buildUnifiedDiff(f, '', working, 'new file'));
    }
  }
  return chunks.join('\n');
}

function buildUnifiedDiff(file: string, before: string, after: string, label: string): string {
  const aLines = before.split('\n');
  const bLines = after.split('\n');
  const lines: string[] = [`--- a/${file}`, `+++ b/${file} (${label})`];
  const max = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < max; i++) {
    const a = aLines[i];
    const b = bLines[i];
    if (a === b) continue;
    if (a !== undefined) lines.push(`-${a}`);
    if (b !== undefined && b !== a) lines.push(`+${b}`);
  }
  return lines.join('\n');
}

export async function gitRemotes(dir: string): Promise<{ name: string; url: string }[]> {
  const remotes = await git.listRemotes({ fs, dir: repo(dir) });
  return remotes.map((r) => ({ name: r.remote, url: r.url }));
}

export async function gitAddRemote(dir: string, name: string, url: string): Promise<void> {
  await git.addRemote({ fs, dir: repo(dir), remote: name, url, force: true });
}

export async function writeGitignore(dir: string): Promise<void> {
  const target = path.join(dir, '.gitignore');
  const rules = [
    '# API Manager — protected local files',
    'vault.bin',
    '*.local',
    '*.key', '*.pem', '*.p12', '*.pfx',
    '*.db', '*.db-journal', '*.db-wal', '*.db-shm',
    'crash/',
    'backups/encrypted_*.zip',
    '.api-manager-secrets',
  ].join('\n');
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target, 'utf8');
    const missing = rules.split('\n').filter((line) => line.trim() && !line.startsWith('#') && !existing.includes(line));
    if (missing.length > 0) fs.appendFileSync(target, `\n${missing.join('\n')}\n`);
  } else {
    fs.writeFileSync(target, rules + '\n');
  }
}

export async function gitSecretScan(dir: string): Promise<SecurityFinding[]> {
  const status = await gitStatus(dir);
  const targets = [...new Set([...status.staged, ...status.modified, ...status.untracked])];
  const findings: SecurityFinding[] = [];
  for (const file of targets) {
    if (/vault\.bin|\.gitignore|\.zip$|\.png$|\.jpg$|\.ico$|\.wasm$|node_modules\//.test(file)) continue;
    try {
      const text = fs.readFileSync(path.join(dir, file), 'utf8');
      findings.push(...scanTextForSecrets(text, `git:${file}`));
    } catch { /* binary/unreadable → skip */ }
  }
  return findings;
}
