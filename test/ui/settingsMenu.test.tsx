// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsMenu } from '../../packages/ui/src/components/SettingsMenu';

/**
 * Preferences live in the rail's footer rather than as a seventh view: settings
 * are not a way of looking at your projects. One preference exists so far —
 * which view Atlas opens on — so the menu is a radio group that writes on
 * click, with no Save button to leave in an ambiguous state.
 */

afterEach(cleanup);

const open = () => fireEvent.click(screen.getByLabelText('Settings'));

describe('SettingsMenu', () => {
  it('stays shut until asked', () => {
    render(<SettingsMenu startView="search" onStartView={() => {}} />);
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByLabelText('Settings').getAttribute('aria-expanded')).toBe('false');
  });

  it('offers every view and marks the current choice', () => {
    render(<SettingsMenu startView="search" onStartView={() => {}} />);
    open();
    const options = screen.getAllByRole('radio');
    expect(options.map((o) => o.textContent?.replace(/^[●○] /, ''))).toEqual([
      'Search & Ask', 'Overview', 'Timeline', 'Components', 'Sessions', 'Monitor', 'Machines',
    ]);
    expect(screen.getByRole('radio', { checked: true }).textContent).toContain('Search & Ask');
  });

  /** The point of the menu: getting the old landing view back. */
  it('reports the pick and closes', () => {
    const onStartView = vi.fn();
    render(<SettingsMenu startView="search" onStartView={onStartView} />);
    open();
    fireEvent.click(screen.getByRole('radio', { name: /Overview/ }));
    expect(onStartView).toHaveBeenCalledWith('dashboard');
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  it('closes on a click elsewhere', () => {
    render(<SettingsMenu startView="search" onStartView={() => {}} />);
    open();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('radiogroup')).toBeNull();
  });

  /**
   * Escape is consumed here rather than left to bubble: App has a window-level
   * Escape that backs out of an open session, and one keystroke closing both
   * the menu and the thing behind it is the wrong number of layers.
   */
  it('closes on Escape without letting the key reach the view behind it', () => {
    const onWindowEscape = vi.fn();
    window.addEventListener('keydown', onWindowEscape);
    render(<SettingsMenu startView="search" onStartView={() => {}} />);
    open();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(onWindowEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', onWindowEscape);
  });
});
