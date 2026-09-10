import { describe, it, expect } from 'vitest';
import { createSseParser } from '../../src/services/protocols/sse';

function collect() {
  const frames: { event?: string; data: string; id?: string }[] = [];
  const retries: number[] = [];
  const parser = createSseParser(
    (f) => frames.push(f),
    (ms) => retries.push(ms),
  );
  return { frames, retries, parser };
}

describe('SSE stream parser (§26 streaming)', () => {
  it('parses a simple data frame', () => {
    const { frames, parser } = collect();
    parser.feed('data: hello\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('hello');
  });

  it('dispatches frames split arbitrarily across chunks', () => {
    const { frames, parser } = collect();
    const raw = 'event: update\ndata: {"x":1}\n\nevent: ping\ndata: keepalive\n\n';
    // Feed one byte-ish at a time to stress buffering.
    for (const ch of raw) parser.feed(ch);
    expect(frames).toHaveLength(2);
    expect(frames[0].event).toBe('update');
    expect(frames[0].data).toBe('{"x":1}');
    expect(frames[1].event).toBe('ping');
    expect(frames[1].data).toBe('keepalive');
  });

  it('handles CRLF line endings', () => {
    const { frames, parser } = collect();
    parser.feed('data: a\r\ndata: b\r\n\r\n');
    expect(frames).toHaveLength(1);
    // multi-line data joined with a single newline per WHATWG spec
    expect(frames[0].data).toBe('a\nb');
  });

  it('joins multiple data: lines with newlines', () => {
    const { frames, parser } = collect();
    parser.feed('data: line1\ndata: line2\ndata: line3\n\n');
    expect(frames[0].data).toBe('line1\nline2\nline3');
  });

  it('strips a single leading space after the colon, and tolerates no space', () => {
    const { frames, parser } = collect();
    parser.feed('data:nospace\ndata: spaced\n\n');
    expect(frames[0].data).toBe('nospace\nspaced');
  });

  it('ignores comment lines starting with ":"', () => {
    const { frames, parser } = collect();
    parser.feed(': a comment\ndata: payload\n\n');
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('payload');
  });

  it('captures event and id fields', () => {
    const { frames, parser } = collect();
    parser.feed('id: 42\nevent: custom\ndata: hi\n\n');
    expect(frames[0]).toEqual({ id: '42', event: 'custom', data: 'hi' });
  });

  it('ignores id values containing a null byte (per spec)', () => {
    const { frames, parser } = collect();
    parser.feed('id: bad\u0000id\ndata: hi\n\n');
    expect(frames[0].id).toBeUndefined();
  });

  it('emits retry via the onRetry callback, rounded to ms', () => {
    const { retries, parser } = collect();
    parser.feed('retry: 2500.8\n\n');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toBe(2501);
  });

  it('flush() delivers an unterminated final frame when the stream ends', () => {
    const { frames, parser } = collect();
    parser.feed('data: tail');
    expect(frames).toHaveLength(0);
    parser.flush();
    expect(frames).toHaveLength(1);
    expect(frames[0].data).toBe('tail');
  });

  it('flush() delivers nothing for trailing blank lines / comments only', () => {
    const { frames, parser } = collect();
    parser.feed('data: ok\n\n: trailing comment\n\n');
    parser.flush();
    expect(frames).toHaveLength(1);
  });
});
