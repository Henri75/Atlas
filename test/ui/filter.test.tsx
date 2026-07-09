// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterInput, Highlight, matches } from '../../packages/ui/src/components/ui';

afterEach(cleanup);

describe('matches', () => {
  it('is case-insensitive and matches substrings', () => {
    expect(matches('PgBouncer crash-loop', 'bouncer')).toBe(true);
    expect(matches('PgBouncer', 'qdrant')).toBe(false);
  });

  it('an empty needle matches everything, including undefined text', () => {
    expect(matches(undefined, '')).toBe(true);
    expect(matches(undefined, 'x')).toBe(false);
  });
});

describe('Highlight', () => {
  it('marks every occurrence', () => {
    const { container } = render(<Highlight text="fix the fix" needle="fix" />);
    expect(container.querySelectorAll('mark')).toHaveLength(2);
  });

  it('preserves the original casing of the matched text', () => {
    render(<Highlight text="PgBouncer" needle="pgbouncer" />);
    expect(screen.getByText('PgBouncer').tagName).toBe('MARK');
  });

  /** A needle is user text, never a pattern. */
  it('treats regex metacharacters literally', () => {
    const { container } = render(<Highlight text="a.b and axb" needle="a.b" />);
    expect(container.querySelectorAll('mark')).toHaveLength(1);
    expect(container.querySelector('mark')!.textContent).toBe('a.b');
  });

  it('renders plain text when there is no needle', () => {
    const { container } = render(<Highlight text="untouched" needle="" />);
    expect(container.querySelector('mark')).toBeNull();
  });
});

describe('FilterInput', () => {
  it('reports how much a filter hid', () => {
    render(<FilterInput value="x" onChange={() => {}} placeholder="Filter…" count={{ shown: 3, total: 40 }} />);
    expect(screen.getByText('3 of 40')).toBeTruthy();
  });

  it('shows just the total when nothing is filtered out', () => {
    render(<FilterInput value="" onChange={() => {}} placeholder="Filter…" count={{ shown: 40, total: 40 }} />);
    expect(screen.getByText('40')).toBeTruthy();
  });

  it('clears the filter', () => {
    const onChange = vi.fn();
    render(<FilterInput value="x" onChange={onChange} placeholder="Filter…" />);
    fireEvent.click(screen.getByText('clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
