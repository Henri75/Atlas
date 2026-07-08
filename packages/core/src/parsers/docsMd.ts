import type { Entry } from '../types.js';

/** Markdown docs → one entry per H1/H2 section (frontmatter stripped). */

export interface DocParseCtx {
  projectSlug: string;
  sourcePath: string;
  /** File mtime (ISO) — docs carry no reliable inline date. */
  modifiedAt?: string;
}

const MIN_SECTION_CHARS = 80;
const MAX_SECTION_CHARS = 20_000;

export function parseMarkdownDoc(text: string, ctx: DocParseCtx): Entry[] {
  let body = text;
  // Strip YAML frontmatter.
  const fm = body.match(/^---\n[\s\S]*?\n---\n/);
  if (fm) body = body.slice(fm[0].length);

  const fileName = ctx.sourcePath.split('/').pop() ?? ctx.sourcePath;
  const lines = body.split('\n');
  const sections: { heading: string; text: string[] }[] = [
    { heading: fileName, text: [] },
  ];
  for (const line of lines) {
    const h = line.match(/^(#{1,2})\s+(.*)/);
    if (h) sections.push({ heading: h[2]!.trim(), text: [] });
    else sections[sections.length - 1]!.text.push(line);
  }

  const entries: Entry[] = [];
  for (const s of sections) {
    const content = s.text.join('\n').trim();
    if (content.length < MIN_SECTION_CHARS) continue;
    entries.push({
      projectSlug: ctx.projectSlug,
      sourceType: 'doc',
      title: `${fileName} — ${s.heading}`.slice(0, 140),
      body: content.slice(0, MAX_SECTION_CHARS),
      occurredAt: ctx.modifiedAt,
      sourcePath: ctx.sourcePath,
      sourceRef: `#${s.heading.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    });
  }
  return entries;
}
