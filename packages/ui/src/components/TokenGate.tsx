import { useState } from 'react';

/**
 * One-time bearer-token prompt (spec §7). App.tsx renders this in place of
 * the whole shell the moment any API call 401s (api.ts's `atlas:unauthorized`
 * event) — meaning this instance is LAN-exposed and the stored token, if any,
 * is missing or wrong. Saving reloads rather than re-rendering: every call in
 * api.ts already reads `localStorage.atlasToken` fresh, so a reload is the
 * simplest way to retry everything at once with the new value in place.
 */
export function TokenGate() {
  const [token, setToken] = useState('');

  const save = () => {
    if (!token.trim()) return;
    localStorage.setItem('atlasToken', token.trim());
    window.location.reload();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-sm w-full bg-panel border border-line rounded-md p-6">
        <p className="text-muted text-[13px] mb-4">
          This Atlas instance is LAN-exposed and needs its bearer token — paste the one from `atlas connect`.
        </p>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="Bearer token"
          aria-label="Bearer token"
          autoFocus
          className="w-full bg-panel-2 border border-line rounded-md px-3 py-2 text-[13px] placeholder:text-faint mb-3"
        />
        <button
          type="button"
          onClick={save}
          className="w-full rounded-md border border-line bg-panel-2 px-3 py-2 text-[13px] text-ink hover:border-faint"
        >
          Save & reload
        </button>
      </div>
    </div>
  );
}
