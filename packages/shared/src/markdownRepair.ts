/**
 * Repair markdown truncated mid-syntax, before it reaches a parser.
 *
 * Search snippets are a blind `body.slice(0, 280)`, so they routinely end
 * inside a construct: `…**Objective` or `` …```ts\nconst x ``. Parsers are
 * tolerant but not repairing — an unclosed `**` renders as literal asterisks,
 * and an unclosed fence swallows the remainder into a code block. Closing the
 * delimiters we opened costs nothing and is the difference between formatted
 * text and visible syntax. Shared by the web renderer and the native one;
 * only used for compact/snippet rendering — a full body is never cut.
 */
export function repairTruncated(text: string): string {
  let out = text;

  const fence = (out.match(/```/g) ?? []).length;
  if (fence % 2 === 1) out += '\n```';

  // Inline delimiters, longest first: `**` must be counted before `*`, or every
  // bold marker reads as two stray emphasis markers.
  for (const [delim, re] of [
    ['`', /`/g],
    ['**', /\*\*/g],
    ['~~', /~~/g],
  ] as const) {
    // Skip anything inside a fenced block — backticks there are the fence.
    if (delim === '`' && fence > 0) continue;
    const n = (out.match(re) ?? []).length;
    if (n % 2 === 1) out += delim;
  }

  return out;
}
