import { useState } from 'react';
import { toMarkdown, exportFilename, exportDay as day, type Exportable } from '@atlas/shared';

export { toMarkdown };
export type { Exportable };

/**
 * Take a reply out of the app: markdown, PDF, or the clipboard.
 *
 * Both formats are generated from the *source data* — the markdown text plus the
 * structured `sources` array — never by screenshotting the DOM. The canonical
 * serializer (`toMarkdown`) and the filename slug live in @atlas/shared, so the
 * native share-sheet export renders byte-identical output.
 */

/** Filename-safe slug from the question, so downloads don't all collide. */
const filename = exportFilename;

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // Revoking immediately can cancel the download in some browsers; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMarkdown(reply: Exportable) {
  download(new Blob([toMarkdown(reply)], { type: 'text/markdown' }), filename(reply, 'md'));
}

/**
 * Render to PDF with jsPDF's text API — no html2canvas, so the output is real
 * vector text rather than a bitmap of the screen.
 *
 * jsPDF is ~240 KB gzipped, so it is imported dynamically: a user who never
 * exports never pays for it. That also keeps it out of the initial bundle, where
 * it would be the single largest dependency.
 */
export async function downloadPdf(reply: Exportable) {
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 56; // margin
  const W = PAGE_W - M * 2;
  let y = M;

  /** Break to a new page before drawing something `need` points tall. */
  const room = (need: number) => {
    if (y + need > PAGE_H - M) {
      doc.addPage();
      y = M;
    }
  };

  const write = (
    text: string,
    { size = 10.5, style = 'normal', gap = 5, color = '#111827' as string } = {},
  ) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(color);
    for (const line of doc.splitTextToSize(text, W) as string[]) {
      room(size * 1.35);
      doc.text(line, M, y);
      y += size * 1.35;
    }
    y += gap;
  };

  if (reply.question) {
    write(reply.question, { size: 16, style: 'bold', gap: 10 });
  }

  // Markdown is rendered structurally rather than dumped verbatim: headings,
  // bullets and code read as themselves, and the syntax noise (#, *, `) is gone.
  for (const raw of reply.content.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      y += 4;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      y += 4;
      write(h[2]!, { size: 14 - h[1]!.length, style: 'bold', gap: 3 });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      write(`•  ${strip(bullet[1]!)}`, { gap: 1 });
      continue;
    }
    const num = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (num) {
      write(`${num[1]}.  ${strip(num[2]!)}`, { gap: 1 });
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) continue; // fence markers carry no content
    write(strip(line), { gap: 3 });
  }

  if (reply.sources?.length) {
    y += 10;
    room(40);
    doc.setDrawColor('#d1d5db');
    doc.line(M, y, PAGE_W - M, y);
    y += 16;
    write('Sources', { size: 12, style: 'bold', gap: 6 });

    for (const s of reply.sources) {
      const when = day(s.occurredAt);
      write(`[${s.n}] ${s.title}`, { size: 10, style: 'bold', gap: 1 });
      write(`${s.projectSlug} · ${s.sourceType}${when ? ` · ${when}` : ''}`, {
        size: 9,
        color: '#6b7280',
        gap: 1,
      });
      // A real, clickable link — the reason we generate rather than screenshot.
      doc.setFontSize(9);
      doc.setTextColor('#1d4ed8');
      const path = (doc.splitTextToSize(s.sourcePath, W) as string[])[0]!;
      room(12);
      doc.textWithLink(path, M, y, { url: toFileUrl(s.sourcePath) });
      y += 18;
    }
  }

  doc.save(filename(reply, 'pdf'));
}

/** Inline markdown emphasis is meaningless once flattened to PDF text. */
function strip(s: string): string {
  return s
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)\*([^*]+)\*/g, '$1$2')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
}

/** Absolute paths become openable file:// links; anything else is left alone. */
function toFileUrl(path: string): string {
  return path.startsWith('/') ? `file://${path}` : path;
}

export function ExportButtons({ reply }: { reply: Exportable }) {
  const [busy, setBusy] = useState(false);

  // One "download" affordance with two formats, not two loose buttons: the ↓
  // is shared, and the pill groups them so they read as a pair rather than
  // competing with the icon controls beside them.
  const item =
    'text-muted hover:text-ink text-[11px] font-mono leading-none px-1.5 py-1 rounded disabled:opacity-50';

  return (
    <span className="inline-flex items-center rounded border border-line bg-panel-2/60">
      <span className="text-faint text-[11px] font-mono pl-1.5 pr-0.5 leading-none" aria-hidden>
        ↓
      </span>
      <button
        onClick={() => downloadMarkdown(reply)}
        title="Download as Markdown"
        aria-label="Download answer as Markdown"
        className={item}
      >
        md
      </button>
      <span className="w-px self-stretch bg-line" aria-hidden />
      <button
        onClick={() => {
          // The jsPDF chunk loads on first use; say so rather than appear dead.
          setBusy(true);
          void downloadPdf(reply).finally(() => setBusy(false));
        }}
        disabled={busy}
        title="Download as PDF"
        aria-label="Download answer as PDF"
        className={item}
      >
        {busy ? '…' : 'pdf'}
      </button>
    </span>
  );
}
