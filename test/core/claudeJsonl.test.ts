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

  it('keeps substantial assistant text, skips short acks and thinking', () => {
    const long = 'Root cause analysis: '.repeat(30); // > 280 chars
    const { entries } = distillClaudeJsonl(
      lines(
        { type: 'assistant', timestamp: '2026-03-06T15:33:00Z', message: { content: [{ type: 'thinking', thinking: 'x'.repeat(500) }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'On it.' }] } },
        { type: 'assistant', timestamp: '2026-03-06T15:34:00Z', message: { content: [{ type: 'text', text: long }] } },
      ),
      ctx,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.meta).toEqual({ kind: 'response' });
    expect(entries[0]!.occurredAt).toBe('2026-03-06T15:34:00Z');
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

  it('survives torn/corrupt lines', () => {
    const { entries } = distillClaudeJsonl(
      ['{"type":"user","message":{"content":"valid prompt here"}}', '{"type":"user","mess'],
      ctx,
    );
    expect(entries).toHaveLength(1);
  });
});
