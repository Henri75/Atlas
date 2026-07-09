import { describe, expect, it } from 'vitest';
import { distillClaudeJsonl } from '@kdbscope/core';

const ctx = {
  projectSlug: 'deepcast',
  sourcePath: '/data/claude/projects/x/abc.jsonl',
  sessionId: 'abc',
};

function lines(...events: unknown[]): string[] {
  return events.map((e) => JSON.stringify(e));
}

describe('distillClaudeJsonl', () => {
  it('keeps real prompts, drops command wrappers and tool results', () => {
    const { entries, meta } = distillClaudeJsonl(
      lines(
        { type: 'user', timestamp: '2026-03-06T15:32:46Z', cwd: '/x', message: { content: 'Fix the video import timeout bug in the worker pool' } },
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { content: [{ type: 'tool_result', content: 'big blob' }] } },
        { type: 'progress', data: 'noise' },
      ),
      ctx,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toContain('Fix the video import timeout');
    expect(entries[0]!.meta).toEqual({ kind: 'prompt' });
    expect(meta.promptCount).toBe(1);
    expect(meta.cwd).toBe('/x');
  });

  /**
   * Short replies used to be dropped by a 280-char filter. On real transcripts
   * that discarded ~53% of Claude's messages ("No security findings." is
   * exactly what you search for later) to save ~7% of the volume.
   */
  it('keeps every piece of assistant prose, and still skips thinking blocks', () => {
    const { entries } = distillClaudeJsonl(
      lines(
        { type: 'assistant', timestamp: '2026-03-06T15:33:00Z', message: { content: [{ type: 'thinking', thinking: 'x'.repeat(500) }] } },
        { type: 'assistant', timestamp: '2026-03-06T15:34:00Z', message: { content: [{ type: 'text', text: 'No security findings.' }] } },
      ),
      ctx,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toBe('No security findings.');
    expect(entries[0]!.meta).toEqual({ kind: 'response' });
    expect(entries[0]!.occurredAt).toBe('2026-03-06T15:34:00Z');
  });

  it('classifies insights, summaries and plans so search can filter by intent', () => {
    const { entries } = distillClaudeJsonl(
      lines(
        { type: 'assistant', message: { content: [{ type: 'text', text: '★ Insight ───\nqdrant lags writes' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: '## Summary\nRewrote the README.' }] } },
        { type: 'user', message: { content: 'Implement the following plan:\n\n# Multi-Track Indexing' } },
        { type: 'user', message: { content: 'what does this sentence mean?' } },
      ),
      ctx,
    );
    expect(entries.map((e) => (e.meta as any).kind)).toEqual([
      'insight',
      'summary',
      'plan',
      'prompt',
    ]);
    expect(entries[0]!.title.startsWith('Insight:')).toBe(true);
    expect(entries[2]!.title.startsWith('Plan:')).toBe(true);
  });

  /** Screenshot 5: consecutive replies with no sign that any tool ran. */
  it('records what was actually done as one action entry per turn', () => {
    const { entries, meta } = distillClaudeJsonl(
      lines({
        type: 'assistant',
        timestamp: '2026-03-06T15:35:00Z',
        message: {
          content: [
            { type: 'text', text: 'Rewriting it now.' },
            { type: 'tool_use', name: 'Write', input: { file_path: '/x/README.md' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'git commit -m "docs"\nsecond line' } },
            { type: 'tool_use', name: 'Read', input: { file_path: '/x/ignored.ts' } },
          ],
        },
      }),
      ctx,
    );

    const action = entries.find((e) => (e.meta as any).kind === 'action')!;
    expect(action.body).toContain('Write: /x/README.md');
    // Only the command's first line — never its body.
    expect(action.body).toContain('Bash: git commit -m "docs"');
    expect(action.body).not.toContain('second line');
    // Read is not an action: it changed nothing.
    expect(action.body).not.toContain('Read');
    expect(meta.actionCount).toBe(2);
  });

  it('collects files touched from edit tools and session timespan', () => {
    const { meta } = distillClaudeJsonl(
      lines(
        { type: 'user', timestamp: '2026-03-06T15:32:46Z', message: { content: 'go' } },
        { type: 'assistant', timestamp: '2026-03-06T15:35:00Z', message: { content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/x/b.py' } },
          { type: 'tool_use', name: 'Write', input: { file_path: '/x/a.py' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/x/ignored.py' } },
        ] } },
        { type: 'summary', summary: 'Video import bugfix session' },
      ),
      ctx,
    );
    expect(meta.filesTouched).toEqual(['/x/a.py', '/x/b.py']);
    expect(meta.title).toBe('Video import bugfix session');
    expect(meta.startedAt).toBe('2026-03-06T15:32:46Z');
    expect(meta.endedAt).toBe('2026-03-06T15:35:00Z');
  });

  /**
   * Regression: the 800-entry cap used to `break` the read loop. Claude writes
   * the `summary` event at either end of a file, so any long session lost its
   * title (54 DeepCast sessions) and under-reported its prompt count.
   */
  it('reads metadata across the whole stream even past the entry cap', () => {
    const noise = Array.from({ length: 900 }, (_, i) =>
      JSON.stringify({
        type: 'user',
        timestamp: `2026-03-06T15:${String(i % 60).padStart(2, '0')}:00Z`,
        message: { content: `prompt number ${i} with enough text to be kept` },
      }),
    );
    const { entries, meta } = distillClaudeJsonl(
      [...noise, JSON.stringify({ type: 'summary', summary: 'Multi-track video indexing' })],
      ctx,
    );

    expect(entries.length).toBe(800); // still capped
    expect(meta.promptCount).toBe(900); // but counted in full
    expect(meta.title).toBe('Multi-track video indexing'); // last line still read
  });

  it('reads a summary that appears on the first line', () => {
    const { meta } = distillClaudeJsonl(
      lines(
        { type: 'summary', summary: 'Early summary' },
        { type: 'user', message: { content: 'a real prompt here' } },
      ),
      ctx,
    );
    expect(meta.title).toBe('Early summary');
  });

  /** Most sessions never get a summary; a raw UUID is a useless label. */
  it('falls back to the first prompt when there is no summary', () => {
    const { meta } = distillClaudeJsonl(
      lines(
        { type: 'user', message: { content: 'Review this change for security vulnerabilities.' } },
        { type: 'user', message: { content: 'a later prompt' } },
      ),
      ctx,
    );
    expect(meta.title).toBeUndefined();
    expect(meta.firstPrompt).toBe('Review this change for security vulnerabilities.');
  });

  it('does not use a skipped noise prompt as the fallback title', () => {
    const { meta } = distillClaudeJsonl(
      lines(
        { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
        { type: 'user', message: { content: 'the real first prompt' } },
      ),
      ctx,
    );
    expect(meta.firstPrompt).toBe('the real first prompt');
  });

  it('survives torn/corrupt lines', () => {
    const { entries } = distillClaudeJsonl(
      ['{"type":"user","message":{"content":"valid prompt here"}}', '{"type":"user","mess'],
      ctx,
    );
    expect(entries).toHaveLength(1);
  });
});
