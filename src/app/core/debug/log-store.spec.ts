import {
  LOG_CAPACITY,
  appendLog,
  clearEntries,
  entriesSince,
  formatValue,
  getEntries,
  latestEntryId,
  parseJsonLines,
  recordConsole,
  toJsonLine,
} from './log-store';

describe('log store', () => {
  beforeEach(() => clearEntries());

  it('splits the [tag] prefix off a console message', () => {
    recordConsole('info', ['[enhance] pump tick', { page: 3 }]);

    const [entry] = getEntries();
    expect(entry.tag).toBe('enhance');
    expect(entry.message).toBe('pump tick');
    expect(entry.detail).toContain('"page":3');
  });

  it('keeps untagged console output under "app"', () => {
    recordConsole('warn', ['no tag here']);

    expect(getEntries()[0].tag).toBe('app');
  });

  it('formats circular objects and errors without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;

    expect(formatValue(cyclic)).toContain('[Circular]');
    expect(formatValue(new Error('boom'))).toContain('boom');
  });

  it('caps the buffer at LOG_CAPACITY', () => {
    for (let i = 0; i < LOG_CAPACITY + 10; i++) {
      appendLog('info', 'test', `line ${i}`);
    }

    expect(getEntries().length).toBe(LOG_CAPACITY);
    expect(getEntries()[0].message).toBe('line 10');
  });

  it('returns only entries newer than an id', () => {
    const first = appendLog('info', 'test', 'a');
    appendLog('info', 'test', 'b');

    expect(entriesSince(first.id).map((entry) => entry.message)).toEqual(['b']);
    expect(latestEntryId()).toBeGreaterThan(first.id);
  });

  it('round-trips the JSONL file format and skips malformed lines', () => {
    const entry = appendLog('warn', 'logs', 'hello', { a: 1 });

    const parsed = parseJsonLines(`${toJsonLine(entry)}\nnot json\n`);

    expect(parsed.length).toBe(1);
    expect(parsed[0].level).toBe('warn');
    expect(parsed[0].message).toBe('hello');
    expect(parsed[0].detail).toContain('"a":1');
  });
});
