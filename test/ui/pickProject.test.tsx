// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PickProject } from '../../packages/ui/src/components/ui';

afterEach(cleanup);

const projects = [
  { slug: 'deepcast', entryCount: 7871 },
  { slug: 'askall', entryCount: 1320 },
];

/**
 * Timeline/Components/Sessions used to say "Pick a project" while offering no
 * picker: the only one was in a sidebar the user might never connect to that
 * instruction. An empty state has to be an invitation to act.
 */
describe('PickProject', () => {
  it('offers every project as a button', () => {
    render(<PickProject what="timeline" projects={projects} onProject={() => {}} />);
    expect(screen.getByText(/Choose a project to see its timeline/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /deepcast/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /askall/ })).toBeTruthy();
  });

  it('selects the project that was clicked', () => {
    const onProject = vi.fn();
    render(<PickProject what="components" projects={projects} onProject={onProject} />);
    fireEvent.click(screen.getByRole('button', { name: /deepcast/ }));
    expect(onProject).toHaveBeenCalledWith('deepcast');
  });

  it('explains an empty index rather than showing an empty picker', () => {
    render(<PickProject what="sessions" projects={[]} onProject={() => {}} />);
    expect(screen.getByText(/No projects indexed yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
