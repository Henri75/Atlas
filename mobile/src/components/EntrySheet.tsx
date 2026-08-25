import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { toast } from './Toast';
import { Badge, Pulse, Stamp } from './atoms';
import { Markdown } from './MarkdownNative';
import { Sheet } from './Sheet';
import { api } from '../api/endpoints';
import { colors, fonts, tint } from '../theme';
import type { FullEntry } from '@atlas/shared';

/**
 * Search shows a 280-char snippet; this sheet shows the whole record, plus the
 * way back to the file it came from. Overlays rather than navigates so the
 * result list stays on screen as context (the web drawer's reason, native
 * form). Copy-path and "Open in editor" ride in the header row.
 */
export function EntrySheet({
  entryId,
  onClose,
  multiMachine = false,
}: {
  entryId: number | null;
  onClose: () => void;
  multiMachine?: boolean;
}) {
  const [entry, setEntry] = useState<FullEntry | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setEntry(null);
    setError('');
    if (entryId == null) return;
    let alive = true;
    api
      .entry(entryId)
      .then((e) => alive && setEntry(e))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [entryId]);

  const copyPath = async () => {
    if (!entry) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await Clipboard.setStringAsync(entry.hostPath);
    toast('Path copied');
  };

  return (
    <Sheet open={entryId != null} onClose={onClose}>
      <ScrollView
        style={{ maxHeight: '100%' }}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32 }}
      >
        {error ? (
          <Text style={{ fontFamily: fonts.mono, fontSize: 13, color: colors.report }}>
            Could not load this entry ({error}).
          </Text>
        ) : null}
        {!entry && !error ? <Pulse label="loading" /> : null}
        {entry ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge source={entry.source_type} />
              <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint }}>{entry.slug}</Text>
              {entry.component ? (
                <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.muted }}>{entry.component}</Text>
              ) : null}
              <Stamp iso={entry.occurred_at} />
            </View>

            <Text style={{ fontFamily: fonts.display, fontSize: 18, fontWeight: '600', lineHeight: 24, marginTop: 10 }}>
              {entry.title}
            </Text>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16, marginTop: 12 }}>
              <Pressable
                onPress={() =>
                  void Linking.openURL(entry.editorUrl).catch(() =>
                    toast('No editor is installed to handle this link.'),
                  )
                }
              >
                <Text style={{ color: colors.kdb, textDecorationLine: 'underline', fontSize: 13 }}>
                  Open in editor
                </Text>
              </Pressable>
              <Pressable onPress={copyPath} hitSlop={6}>
                <Text style={{ color: colors.muted, fontSize: 13 }}>Copy path</Text>
              </Pressable>
            </View>
            <Text selectable style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 6 }}>
              {entry.hostPath}
            </Text>
            {multiMachine && entry.machine ? (
              <Text style={{ fontFamily: fonts.mono, fontSize: 10, color: colors.faint, marginTop: 2 }}>
                first ingested from <Text style={{ color: colors.muted }}>{entry.machine}</Text>
              </Text>
            ) : null}

            <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, marginTop: 16, paddingTop: 14 }}>
              <Markdown text={entry.body} baseSize={13.5} />
            </View>
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
