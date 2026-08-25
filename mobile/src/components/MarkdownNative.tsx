import { memo, useMemo } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { marked } from 'marked';
import type { Token, Tokens } from 'marked';
import { colors, fonts, tint } from '../theme';

/**
 * Render Atlas markdown natively — kdb log bodies, git commit messages,
 * session transcripts and Ask answers all flow through here, as on the web.
 *
 * Security posture differs from web by construction: instead of parse →
 * sanitize → inject-as-HTML, we lex with `marked` and render *tokens* as RN
 * elements. No HTML is ever interpreted; anything markup-shaped in untrusted
 * content renders as literal text. The enrichments survive:
 *
 *  - **Citations**: `[3]` becomes a tappable marker when the caller passes the
 *    set of known citation numbers (Ask answers only — elsewhere `[1]` is
 *    array syntax or a log prefix and must stay text).
 *  - **Filter highlight**: `needle` wraps matches in an amber mark, matching
 *    the plain-text Highlight used by list rows.
 *  - **Compact mode**: search snippets are blind truncations of markdown;
 *    blocks collapse to body size with no vertical margin so rows stay short.
 */

marked.use({ gfm: true, breaks: true });

interface MdProps {
  text: string;
  citations?: ReadonlySet<number>;
  /** Citation tap → jump/flash the source row (native scrolls via ref callback). */
  onCite?: (n: number) => void;
  needle?: string;
  compact?: boolean;
  baseSize?: number;
}

export const Markdown = memo(function Markdown({
  text,
  citations,
  onCite,
  needle,
  compact,
  baseSize = 13.5,
}: MdProps) {
  const tokens = useMemo(() => {
    const src = compact ? repair(text) : text;
    return marked.lexer(src);
  }, [text, compact]);

  return (
    <View>
      {tokens.map((t, i) => (
        <Block
          key={i}
          token={t}
          citations={citations}
          onCite={onCite}
          needle={needle}
          compact={compact}
          size={baseSize}
        />
      ))}
    </View>
  );
});

/** Local re-implementation guard: shared's repairTruncated is the same code. */
import { repairTruncated as repair } from '@atlas/shared';

function Block({
  token,
  citations,
  onCite,
  needle,
  compact,
  size,
}: {
  token: Token;
  citations?: ReadonlySet<number>;
  onCite?: (n: number) => void;
  needle?: string;
  compact?: boolean;
  size: number;
}) {
  switch (token.type) {
    case 'heading': {
      const h = token as Tokens.Heading;
      const level = Math.min(4, h.depth);
      return (
        <Text
          style={{
            fontFamily: fonts.display,
            fontWeight: level <= 2 ? '600' : '600',
            fontSize: size + [5, 3.5, 1.5, 0][level - 1]!,
            lineHeight: size * 1.35,
            color: level >= 3 ? colors.ink : colors.ink,
            marginTop: compact ? 2 : 12,
            marginBottom: compact ? 2 : 5,
          }}
          accessible
          accessibilityRole="header"
        >
          <Inline text={h.text} needle={needle} />
        </Text>
      );
    }
    case 'paragraph':
      return (
        <Text
          style={{
            fontSize: size,
            lineHeight: size * 1.6,
            color: colors.ink,
            marginTop: compact ? 2 : 6,
            marginBottom: compact ? 2 : 6,
          }}
        >
          <Inline text={(token as Tokens.Paragraph).raw.trim()} needle={needle} citations={citations} onCite={onCite} />
        </Text>
      );
    case 'space':
      return null;
    case 'hr':
      return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginVertical: 10 }} />;
    case 'code': {
      const c = token as Tokens.Code;
      return (
        <View
          style={{
            backgroundColor: colors.panel2,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: colors.line,
            borderRadius: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            marginVertical: compact ? 2 : 8,
          }}
        >
          <Text style={{ fontFamily: fonts.mono, fontSize: size - 1.5, lineHeight: (size - 1.5) * 1.45, color: colors.ink }}>
            {c.text}
          </Text>
        </View>
      );
    }
    case 'blockquote': {
      const q = token as Tokens.Blockquote;
      return (
        <View
          style={{
            borderLeftWidth: 3,
            borderLeftColor: colors.line,
            paddingLeft: 12,
            marginVertical: compact ? 2 : 8,
          }}
        >
          {q.tokens.map((t, i) => (
            <Block
              key={i}
              token={t}
              citations={citations}
              onCite={onCite}
              needle={needle}
              compact={compact}
              size={size - 0.5}
            />
          ))}
        </View>
      );
    }
    case 'list': {
      const l = token as Tokens.List;
      let idx = 1;
      return (
        <View style={{ marginVertical: compact ? 2 : 6 }}>
          {l.items.map((item, i) => {
            const ordered = l.ordered;
            const bullet = ordered ? `${idx++}.` : '•';
            // GFM task lists carry their own checkbox; no bullet next to it.
            const task = item.task;
            return (
              <View key={i} style={{ flexDirection: 'row', marginVertical: compact ? 0 : 2 }}>
                <Text
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: size,
                    lineHeight: size * 1.6,
                    color: colors.faint,
                    width: task ? 0 : 20,
                  }}
                >
                  {task ? '' : `${bullet} `}
                </Text>
                <View style={{ flex: 1 }}>
                  {item.tokens.map((t, j) =>
                    t.type === 'text' ? (
                      <Text key={j} style={{ fontSize: size, lineHeight: size * 1.6, color: colors.ink }}>
                        {task && (
                          <Text
                            style={{
                              fontFamily: fonts.mono,
                              color: item.checked ? colors.git : colors.faint,
                            }}
                          >
                            {item.checked ? '[x] ' : '[ ] '}
                          </Text>
                        )}
                        <Inline
                          text={stripListToken((t as Tokens.Text).raw)}
                          needle={needle}
                          citations={citations}
                          onCite={onCite}
                        />
                      </Text>
                    ) : (
                      <Block
                        key={j}
                        token={t}
                        citations={citations}
                        onCite={onCite}
                        needle={needle}
                        compact={compact}
                        size={size}
                      />
                    ),
                  )}
                </View>
              </View>
            );
          })}
        </View>
      );
    }
    case 'table': {
      const tb = token as Tokens.Table;
      return (
        <View style={{ marginVertical: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: 6, overflow: 'hidden' }}>
          <View style={{ flexDirection: 'row', backgroundColor: colors.panel2 }}>
            {tb.header.map((cell, i) => (
              <View key={i} style={{ flex: 1, padding: 6, borderRightWidth: i < tb.header.length - 1 ? StyleSheet.hairlineWidth : 0, borderRightColor: colors.line }}>
                <Text style={{ fontFamily: fonts.sansSemiBold, fontSize: size - 1, color: colors.ink }}>
                  <Inline text={clean(cell.text)} needle={needle} />
                </Text>
              </View>
            ))}
          </View>
          {tb.rows.map((row, r) => (
            <View key={r} style={{ flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line }}>
              {row.map((cell, c) => (
                <View key={c} style={{ flex: 1, padding: 6, borderRightWidth: c < row.length - 1 ? StyleSheet.hairlineWidth : 0, borderRightColor: colors.line }}>
                  <Text style={{ fontSize: size - 1, lineHeight: (size - 1) * 1.5, color: colors.muted }}>
                    <Inline text={clean(cell.text)} needle={needle} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    }
    case 'html':
      // Raw HTML never renders (there is no WebView here); show it literally.
      return (
        <Text style={{ fontFamily: fonts.mono, fontSize: size - 1, color: colors.faint }}>
          {(token as Tokens.HTML).raw}
        </Text>
      );
    default:
      return null;
  }
}

/** Inline markdown → styled Text spans (emphasis, code, links, citations). */
function Inline({
  text,
  needle,
  citations,
  onCite,
}: {
  text: string;
  needle?: string;
  citations?: ReadonlySet<number>;
  onCite?: (n: number) => void;
}) {
  const spans = useMemo(() => parseInline(text, citations), [text, citations]);
  return (
    <>
      {spans.map((s, i) => {
        if (s.cite != null) {
          const known = !citations || citations.has(s.cite);
          if (known && onCite) {
            return (
              <Pressable key={i} onPress={() => onCite(s.cite!)} hitSlop={6}>
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.kdb }}>[{s.cite}]</Text>
              </Pressable>
            );
          }
          return (
            <Text key={i} style={{ fontFamily: fonts.mono, fontSize: 11, color: known ? colors.kdb : colors.faint }}>
              [{s.cite}]
            </Text>
          );
        }
        if (s.link) {
          return (
            <Pressable key={i} onPress={() => void Linking.openURL(s.link!).catch(() => {})}>
              <Text style={{ color: colors.claude, textDecorationLine: 'underline' }}>
                {highlightSpan(s.t, needle, s.style)}
              </Text>
            </Pressable>
          );
        }
        return highlightSpan(s.t, needle, s.style);
      })}
    </>
  );
}

type Span = {
  t: string;
  style?: { bold?: boolean; italic?: boolean; mono?: boolean };
  link?: string;
  cite?: number;
};

/**
 * A small inline parser over the common subset (`**`, `*`, `` ` ``, `[x](y)`,
 * `[n]` citations). marked's inline tokenizer returns nested token trees whose
 * raw leaves still carry delimiters at depth, so a focused scanner is both
 * simpler and fully testable.
 */
function parseInline(text: string, citations?: ReadonlySet<number>): Span[] {
  const out: Span[] = [];
  let i = 0;
  let plain = '';

  const flush = () => {
    if (plain) {
      out.push({ t: plain });
      plain = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Citation markers: only where citations exist (see component doc).
    const citeM = /^\[(\d+)\]/.exec(rest);
    if (citeM) {
      flush();
      out.push({ t: '', cite: Number(citeM[1]) });
      i += citeM[0].length;
      continue;
    }

    // Code span
    const codeM = /^`([^`]+)`/.exec(rest);
    if (codeM) {
      flush();
      out.push({ t: codeM[1]!, style: { mono: true } });
      i += codeM[0].length;
      continue;
    }

    // Bold+italic, bold, italic
    const bi = /^\*\*\*([^*]+)\*\*\*/.exec(rest);
    if (bi) {
      flush();
      out.push({ t: bi[1]!, style: { bold: true, italic: true } });
      i += bi[0].length;
      continue;
    }
    const bold = /^\*\*([^*]+)\*\*/.exec(rest);
    if (bold) {
      flush();
      out.push({ t: bold[1]!, style: { bold: true } });
      i += bold[0].length;
      continue;
    }
    const ital = /^[*_]([^*_]+)[*_]/.exec(rest);
    if (ital) {
      flush();
      out.push({ t: ital[1]!, style: { italic: true } });
      i += ital[0].length;
      continue;
    }

    // Strikethrough
    const strike = /^~~([^~]+)~~/.exec(rest);
    if (strike) {
      flush();
      out.push({ t: strike[1]!, style: {} });
      i += strike[0].length;
      continue;
    }

    // Link — keep the label; the URL opens on tap.
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      out.push({ t: link[1]!, link: link[2] });
      i += link[0].length;
      continue;
    }

    plain += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** Wrap needle matches in amber marks; other styles pass through untouched. */
function highlightSpan(
  t: string,
  needle: string | undefined,
  style?: Span['style'],
): React.ReactNode {
  const base = {
    fontWeight: style?.bold ? ('600' as const) : undefined,
    fontStyle: style?.italic ? ('italic' as const) : undefined,
    fontFamily: style?.mono ? fonts.mono : undefined,
    ...(style?.mono
      ? {
          color: colors.ink,
          backgroundColor: colors.panel2,
        }
      : {}),
  };

  if (!needle) return <Text style={base}>{t}</Text>;
  const lower = t.toLowerCase();
  const target = needle.toLowerCase();
  if (!target) return <Text style={base}>{t}</Text>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  let k = 0;
  for (;;) {
    const found = lower.indexOf(target, at);
    if (found === -1) {
      parts.push(<Text key={`p${k++}`} style={base}>{t.slice(at)}</Text>);
      break;
    }
    if (found > at)
      parts.push(<Text key={`p${k++}`} style={base}>{t.slice(at, found)}</Text>);
    parts.push(
      <Text key={`m${k++}`} style={[base, { backgroundColor: tint(colors.kdb, 30) }]}>
        {t.slice(found, found + target.length)}
      </Text>,
    );
    at = found + target.length;
  }
  return <>{parts}</>;
}

/** Table cells arrive with their inline markup; flatten to readable text. */
function clean(cell: string): string {
  return cell.replace(/\*\*/g, '').replace(/`/g, '').trim();
}

function stripListToken(raw: string): string {
  return raw.replace(/^\[[ xX]\]\s*/, '');
}
