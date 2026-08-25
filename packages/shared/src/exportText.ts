import type { AskSource } from './types.js';

/**
 * Take a reply out of the app, as text.
 *
 * The canonical serialization, generated from the *source data* — the markdown
 * text plus the structured `sources` array. The web renders it to a download or
 * a PDF; native hands it to the share sheet / Files. One serializer, so the two
 * exports can never drift out of sync.
 */

/** A reply plus its citations: everything an export needs, in one place. */
export interface Exportable {
  question?: string;
  content: string;
  sources?: AskSource[];
}

/** `2026-07-12T09:31:00Z` → `2026-07-12`. Undefined stays undefined. */
export const exportDay = (iso?: string) => iso?.slice(0, 10);

export function toMarkdown(reply: Exportable): string {
  const parts: string[] = [];
  if (reply.question) parts.push(`# ${reply.question}\n`);
  parts.push(reply.content.trim());

  if (reply.sources?.length) {
    parts.push('\n## Sources\n');
    for (const s of reply.sources) {
      const when = exportDay(s.occurredAt);
      // Keep the [n] markers meaningful: they are what the answer body cites.
      parts.push(
        `[${s.n}] **${s.title}** — \`${s.projectSlug}\` · ${s.sourceType}${when ? ` · ${when}` : ''}  \n` +
          `    ${s.sourcePath}`,
      );
    }
  }
  return parts.join('\n') + '\n';
}

/** Filename-safe slug from the question, so exports don't all collide. */
export function exportFilename(reply: Exportable, ext: string): string {
  const base =
    reply.question
      ?.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50) || 'atlas-answer';
  return `${base}.${ext}`;
}

/** A one-line, paste-ready reference for a cited source. */
export function sourceRef(s: AskSource): string {
  const date = s.occurredAt ? ` (${s.occurredAt.slice(0, 10)})` : '';
  return `[${s.n}] ${s.title} — ${s.projectSlug}/${s.sourceType}${date}\n${s.sourcePath}`;
}
