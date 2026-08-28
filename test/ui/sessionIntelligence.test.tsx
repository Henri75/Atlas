// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCardRow } from '../../packages/ui/src/views/sessions/SessionCardRow';
import { SessionRefActions } from '../../packages/ui/src/components/SessionRefActions';
import { RelatedTimeline } from '../../packages/ui/src/views/sessions/RelatedTimeline';
import type { RelatedResponse, SessionCard } from '@atlas/shared';

afterEach(cleanup);

function card(over: Partial<SessionCard> = {}): SessionCard {
  return {
    sessionId: 'abcdef12-3456-7890-abcd-ef1234567890',
    projectSlug: 'deepcast',
    title: 'Qdrant collection copy',
    startedAt: '2026-08-10T10:00:00.000Z',
    endedAt: '2026-08-10T12:00:00.000Z',
    durationMs: 2 * 3600_000,
    promptCount: 4,
    actionCount: 30,
    entryCount: 120,
    fileCount: 3,
    filesTouched: ['a.ts'],
    substance: 0.8,
    score: 1.2,
    why: [
      { kind: 'file', detail: 'touched a matching file', weight: 0.35 },
      { kind: 'message', detail: '3 insights, 2 prompts', weight: 0.9 },
    ],
    excerpts: [
      { entryId: 1, kind: 'insight', occurredAt: undefined, text: 'the bottleneck was the lock' },
    ],
    ...over,
  };
}

describe('SessionRefActions', () => {
  it('offers all three ways into a session', () => {
    render(<SessionRefActions sessionId="s1" onOpen={() => {}} />);
    expect(screen.getByText('open session')).toBeTruthy();
    expect(screen.getByText('insights')).toBeTruthy();
    expect(screen.getByText('related')).toBeTruthy();
  });

  it('reports which tab was asked for', () => {
    const onOpen = vi.fn();
    render(<SessionRefActions sessionId="s1" onOpen={onOpen} />);
    fireEvent.click(screen.getByText('insights'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'insights');
  });

  /**
   * These buttons live inside rows that are themselves clickable. Without
   * stopPropagation, asking for insights would ALSO fire the row's open action
   * and land the reader on the conversation instead.
   */
  it('does not also trigger the row it sits inside', () => {
    const rowClick = vi.fn();
    const onOpen = vi.fn();
    render(
      <div onClick={rowClick}>
        <SessionRefActions sessionId="s1" onOpen={onOpen} />
      </div>,
    );
    fireEvent.click(screen.getByText('related'));
    expect(onOpen).toHaveBeenCalledWith('s1', 'related');
    expect(rowClick).not.toHaveBeenCalled();
  });
});

describe('SessionCardRow', () => {
  it('shows why the session matched, so the ranking can be judged', () => {
    render(<SessionCardRow card={card()} onOpen={() => {}} />);
    expect(screen.getByText('touched a matching file')).toBeTruthy();
    expect(screen.getByText('3 insights, 2 prompts')).toBeTruthy();
  });

  it('states the session weight in words for screen readers', () => {
    render(<SessionCardRow card={card({ substance: 0.9 })} onOpen={() => {}} />);
    expect(screen.getByText('deep session')).toBeTruthy();
  });

  it('says when a card stands for a whole run of sessions', () => {
    render(
      <SessionCardRow
        card={card({ thread: { size: 4, memberIds: ['a', 'b', 'c', 'd'] } })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('+3 in thread')).toBeTruthy();
  });

  it('marks an AI headline as AI rather than passing it off as recorded fact', () => {
    render(
      <SessionCardRow
        card={card({ ai: { headline: 'Rebuilt the collection', gist: '' } })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Rebuilt the collection')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
  });

  it('carries the three session actions on every card', () => {
    render(<SessionCardRow card={card()} onOpen={() => {}} />);
    expect(screen.getByText('insights')).toBeTruthy();
    expect(screen.getByText('related')).toBeTruthy();
  });

  it('opens the conversation when the row itself is activated', () => {
    const onOpen = vi.fn();
    render(<SessionCardRow card={card()} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Qdrant collection copy'));
    expect(onOpen).toHaveBeenCalledWith(card().sessionId, 'conversation');
  });
});

function related(over: Partial<RelatedResponse> = {}): RelatedResponse {
  return {
    anchor: card({ sessionId: 'anchor', title: 'the anchor' }),
    related: [
      {
        ...card({ sessionId: 'later', title: 'a later session' }),
        direction: 'after',
        deltaMs: 3 * 24 * 3600_000,
        legs: { file: 0.7, semantic: 0.3, temporal: 0.2 },
        sharedFiles: ['packages/core/src/ask.ts'],
        startedAt: '2026-08-13T10:00:00.000Z',
        why: [{ kind: 'file', detail: 'shares packages/core/src/ask.ts', weight: 0.7 }],
      },
    ],
    basis: ['file', 'semantic'],
    tookMs: 12,
    ...over,
  };
}

describe('RelatedTimeline', () => {
  it('is described for screen readers rather than being a silent picture', () => {
    render(
      <RelatedTimeline data={related()} onOpenSession={() => {}} onSelect={() => {}} />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toMatch(/Timeline of \d+ session/);
  });

  /**
   * A compressed axis read as linear time is a chart that lies, so the chart
   * has to say so itself.
   */
  it('warns on screen that the axis is not linear time', () => {
    render(<RelatedTimeline data={related()} onOpenSession={() => {}} onSelect={() => {}} />);
    // Said twice on purpose — once in the caption a sighted reader sees, once
    // inside the chart's own accessible description.
    expect(screen.getAllByText(/not linear time/).length).toBeGreaterThanOrEqual(2);
  });

  it('states plainly when the only basis was timing', () => {
    render(
      <RelatedTimeline
        data={related({ basis: ['temporal'] })}
        onOpenSession={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(screen.getByText(/not as related work/)).toBeTruthy();
  });

  it('is keyboard navigable, not hover-only', () => {
    const onOpen = vi.fn();
    const onSelect = vi.fn();
    render(<RelatedTimeline data={related()} onOpenSession={onOpen} onSelect={onSelect} />);
    const svg = screen.getByRole('img');
    expect(svg.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalled();
    fireEvent.keyDown(svg, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalled();
  });
});

