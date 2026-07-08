/** Paragraph-aware chunker: ~1800 chars per chunk with ~200-char overlap. */

export interface ChunkOptions {
  maxChars?: number;
  overlap?: number;
}

export function chunk(text: string, opts: ChunkOptions = {}): string[] {
  const max = opts.maxChars ?? 1800;
  const overlap = opts.overlap ?? 200;
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  // Split on paragraph boundaries; hard-split any paragraph longer than max.
  const paragraphs = clean
    .split(/\n{2,}/)
    .flatMap((p) => {
      if (p.length <= max) return [p];
      const parts: string[] = [];
      for (let i = 0; i < p.length; i += max) parts.push(p.slice(i, i + max));
      return parts;
    });

  const chunks: string[] = [];
  let current = '';
  for (const p of paragraphs) {
    if (current && current.length + p.length + 2 > max) {
      chunks.push(current);
      // Seed the next chunk with the tail of the previous one for context continuity.
      current = current.slice(-overlap) + '\n\n' + p;
    } else {
      current = current ? current + '\n\n' + p : p;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}
