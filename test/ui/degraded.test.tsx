// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DegradedBanner } from '../../packages/ui/src/components/ui';

afterEach(cleanup);

/**
 * Search degrades silently (hybrid → sparse-only → FTS). A stale collection
 * once pushed every query onto the Postgres fallback for an hour and the only
 * sign was a grey footnote nobody reads.
 */
describe('DegradedBanner', () => {
  it('explains a dead embedding provider and its cost', () => {
    render(<DegradedBanner mode="sparse-only" />);
    expect(screen.getByRole('status').textContent).toMatch(/embedding provider is unreachable/i);
    expect(screen.getByRole('status').textContent).toMatch(/keyword matching only/i);
  });

  it('explains a dead vector index and its cost', () => {
    render(<DegradedBanner mode="fts" />);
    expect(screen.getByRole('status').textContent).toMatch(/vector index is unreachable/i);
    expect(screen.getByRole('status').textContent).toMatch(/ranking and recall are weaker/i);
  });

  it('renders nothing for a healthy hybrid search', () => {
    const { container } = render(<DegradedBanner mode="hybrid" />);
    expect(container.firstChild).toBeNull();
  });
});
