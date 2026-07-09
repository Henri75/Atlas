import { useEffect, useState } from 'react';
import type { SourceType } from '../types';
import { Badge, Spinner, Stamp } from './ui';

interface FullEntry {
  id: number;
  title: string;
  body: string;
  slug: string;
  source_type: SourceType;
  component?: string;
  session_id?: string;
  occurred_at?: string;
  hostPath: string;
  editorUrl: string;
}

/**
 * Search shows a 280-char snippet. This drawer shows the whole record, plus a
 * way back to the file it came from. It overlays rather than navigates so the
 * result list stays on screen as context.
 */
export function EntryDrawer({ entryId, onClose }: { entryId: number | null; onClose: () => void }) {
  const [entry, setEntry] = useState<FullEntry | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setEntry(null);
    setError('');
    setCopied(false);
    if (entryId == null) return;
    fetch(`/api/entries/${entryId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then(setEntry)
      .catch((e: Error) => setError(e.message));
  }, [entryId]);

  useEffect(() => {
    if (entryId == null) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [entryId, onClose]);

  if (entryId == null) return null;

  const copyPath = async () => {
    if (!entry) return;
    await navigator.clipboard.writeText(entry.hostPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/50"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="w-full max-w-2xl h-full bg-bg border-l border-line overflow-y-auto p-6 rise"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Entry detail"
      >
        <div className="flex items-start gap-3">
          <button
            onClick={onClose}
            className="text-muted hover:text-ink text-sm shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
          <div className="flex-1 min-w-0">
            {error && (
              <p className="font-mono text-sm" style={{ color: 'var(--color-report)' }}>
                Could not load this entry ({error}).
              </p>
            )}
            {!entry && !error && <Spinner />}
            {entry && (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge source={entry.source_type} />
                  <span className="font-mono text-[11px] text-faint">{entry.slug}</span>
                  {entry.component && (
                    <span className="font-mono text-[11px] text-muted">{entry.component}</span>
                  )}
                  <Stamp iso={entry.occurred_at} />
                </div>

                <h2 className="mt-2 font-display text-lg font-semibold leading-snug">
                  {entry.title}
                </h2>

                <div className="mt-3 flex items-center gap-3 text-[12px]">
                  <a
                    href={entry.editorUrl}
                    className="underline underline-offset-2"
                    style={{ color: 'var(--color-kdb)' }}
                  >
                    Open in editor
                  </a>
                  <button onClick={copyPath} className="text-muted hover:text-ink">
                    {copied ? 'Path copied' : 'Copy path'}
                  </button>
                </div>
                <p className="mt-1 font-mono text-[10px] text-faint break-all">{entry.hostPath}</p>

                <pre className="mt-5 text-[13px] whitespace-pre-wrap font-sans leading-relaxed text-ink/90">
                  {entry.body}
                </pre>
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
