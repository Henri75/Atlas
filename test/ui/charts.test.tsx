// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Bars, HourStrip, ShareBar, Sparkline } from '../../packages/ui/src/components/charts';

afterEach(cleanup);

/**
 * The charts are hand-rolled, so their degenerate cases are ours to get right.
 * All three matter in practice: a fresh install has no data, a first day of use
 * has one point, and a normal 30-day window is mostly zeroes with a couple of
 * spikes. A chart that looks broken in any of those teaches the reader to
 * distrust it when it finally shows something real.
 */

const day = (day: string, byClient: Record<string, number> = {}) => ({ day, byClient });

describe('Bars', () => {
  it('renders an axis and says so when nothing happened', () => {
    render(<Bars days={[day('2026-07-01'), day('2026-07-02')]} label="calls" />);
    expect(screen.getByLabelText('calls')).toBeTruthy();
    expect(screen.getByText('no calls')).toBeTruthy();
  });

  it('reports the peak when there is data', () => {
    render(
      <Bars
        days={[day('2026-07-01', { mcp: 3 }), day('2026-07-02', { mcp: 9, cli: 1 })]}
        label="calls"
      />,
    );
    expect(screen.getByText('peak 10/day')).toBeTruthy();
  });

  it('keeps the first and last day as the axis ends', () => {
    render(<Bars days={[day('2026-07-01'), day('2026-07-30')]} label="calls" />);
    expect(screen.getByText('2026-07-01')).toBeTruthy();
    expect(screen.getByText('2026-07-30')).toBeTruthy();
  });

  /**
   * One call among thousands must still be visible. Without a floor its bar
   * rounds to sub-pixel and the chart silently reports it as zero.
   */
  it('gives a tiny value a visible floor', () => {
    const { container } = render(
      <Bars days={[day('2026-07-01', { mcp: 1 }), day('2026-07-02', { mcp: 5000 })]} label="calls" />,
    );
    const heights = [...container.querySelectorAll<HTMLElement>('div[style*="height"]')].map(
      (el) => el.style.height,
    );
    expect(heights).toContain('2%');
  });
});

describe('Sparkline', () => {
  it('renders a dash rather than an empty box when there is no series', () => {
    render(<Sparkline values={[]} label="trend" />);
    expect(screen.getByText('—')).toBeTruthy();
  });

  /** A single point has no line to draw; a zero-length polyline is invisible. */
  it('draws a dot for a single point', () => {
    const { container } = render(<Sparkline values={[4]} label="trend" />);
    expect(container.querySelector('circle')).toBeTruthy();
    expect(container.querySelector('polyline')).toBeNull();
  });

  it('draws a polyline for a real series', () => {
    const { container } = render(<Sparkline values={[1, 4, 2]} label="trend" />);
    const pts = container.querySelector('polyline')?.getAttribute('points');
    expect(pts?.split(' ')).toHaveLength(3);
  });

  it('survives an all-zero series without dividing by zero', () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} label="trend" />);
    const pts = container.querySelector('polyline')?.getAttribute('points') ?? '';
    expect(pts).not.toMatch(/NaN/);
  });
});

describe('HourStrip', () => {
  it('always renders all 24 hours, even with one data point', () => {
    const { container } = render(<HourStrip byHour={[{ hour: 9, calls: 3 }]} />);
    expect(container.querySelectorAll('div[title*="UTC"]')).toHaveLength(24);
    expect(screen.getByText(/busiest 3\/h/)).toBeTruthy();
  });

  it('says there are no calls rather than showing a misleading busiest', () => {
    render(<HourStrip byHour={[]} />);
    expect(screen.getByText('no calls')).toBeTruthy();
  });
});

describe('ShareBar', () => {
  it('renders a flat rule when every category is zero', () => {
    const { container } = render(
      <ShareBar parts={[{ key: 'query', calls: 0, color: 'red' }]} />,
    );
    expect(container.querySelector('[role="img"]')).toBeNull();
  });

  it('omits zero-width segments so their tooltips cannot be hit', () => {
    const { container } = render(
      <ShareBar
        parts={[
          { key: 'query', calls: 4, color: 'red' },
          { key: 'read', calls: 0, color: 'blue' },
        ]}
      />,
    );
    expect(container.querySelectorAll('div[title]')).toHaveLength(1);
  });
});
