import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { bytes, millis, relativeTime, type MachineRow } from '@atlas/shared';
import { useMachines } from '../hooks/useMachines';
import { Empty, Eyebrow, Spinner } from '../components/atoms';
import { SyncDot } from '../components/charts';
import { syncStateOf, SyncPill } from './DashboardScreen';
import { colors, fonts } from '../theme';

/**
 * Read-only fleet table: config/machines.yaml is the source of truth and edits
 * happen there or via `atlas machines add/remove` — never on this page. It
 * exists so "is my fleet syncing?" has an answer without a terminal.
 */
export function MachinesScreen() {
  const { self, machines, loading, error } = useMachines(15_000);

  if (error && machines.length === 0) {
    return <Empty title="Cannot reach the API." hint="The stack may still be starting." />;
  }
  if (loading) return <Spinner />;

  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 40 }}>
      <Text style={{ fontFamily: fonts.display, fontSize: 20, fontWeight: '600' }}>Machines</Text>
      <Text style={{ fontFamily: fonts.mono, fontSize: 11, color: colors.faint, marginTop: 4, lineHeight: 17 }}>
        Configured in config/machines.yaml — edit there or run `atlas machines add` / `remove`.
        This page is read-only.
      </Text>

      {machines.length === 0 ? (
        <View style={{ marginTop: 24 }}>
          <Empty
            title="Single-machine mode."
            hint="No config/machines.yaml is configured — everything indexes as one machine named 'local'."
          />
        </View>
      ) : (
        <View style={{ marginTop: 20 }}>
          <Eyebrow>Fleet</Eyebrow>
          <View style={{ gap: 8 }}>
            {machines.map((m) => (
              <MachineCard key={m.name} m={m} isSelf={m.name === self} />
            ))}
          </View>
        </View>
      )}
    </ScrollView>
  );
}

/** The web's wide table becomes a card per machine — every field still present. */
function MachineCard({ m, isSelf }: { m: MachineRow; isSelf: boolean }) {
  const state = syncStateOf(m.sync);
  return (
    <View
      style={{
        backgroundColor: colors.panel,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.line,
        borderRadius: 10,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 7,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <SyncDot color={stateColor(state)} />
        <Text numberOfLines={1} style={{ fontSize: 14, fontWeight: '600', flex: 1 }}>
          {m.name}
          {isSelf ? (
            <Text style={{ fontFamily: fonts.mono, fontSize: 10, fontWeight: '400', color: colors.faint }}>
              {' '}
              (self)
            </Text>
          ) : null}
        </Text>
        <Text style={{ color: m.enabled ? colors.git : colors.faint, fontSize: 12 }}>
          {m.enabled ? 'enabled' : 'disabled'}
        </Text>
        <SyncPill state={state} />
      </View>

      <Kv k="address" v={`${m.user}@${m.address}`} mono />
      <Kv k="code roots" v={m.codeRoots.join(', ')} mono small />

      <View style={{ flexDirection: 'row', gap: 18 }}>
        <View style={{ flex: 1 }}>
          <Kv k="last success" v={relativeTime(m.sync?.lastSuccessAt ?? undefined)} />
          <Kv k="bytes" v={bytes(m.sync?.bytes ?? null)} />
        </View>
        <View style={{ flex: 1 }}>
          <Kv k="duration" v={millis(m.sync?.durationMs ?? null)} />
          <Kv k="attempted" v={relativeTime(m.sync?.lastAttemptAt ?? undefined)} />
        </View>
      </View>

      {m.sync?.error ? (
        <Text selectable style={{ fontSize: 11.5, lineHeight: 16, color: colors.report }}>
          {m.sync.error}
        </Text>
      ) : null}
    </View>
  );
}

function stateColor(state: ReturnType<typeof syncStateOf>): string {
  switch (state) {
    case 'ok':
      return colors.git;
    case 'running':
      return colors.claude;
    case 'unreachable':
      return colors.kdb;
    case 'error':
      return colors.report;
    default:
      return colors.faint;
  }
}

function Kv({ k, v, mono, small }: { k: string; v: string; mono?: boolean; small?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
      <Text style={{ fontFamily: fonts.mono, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 1.2, color: colors.faint }}>
        {k}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          textAlign: 'right',
          fontFamily: mono ? fonts.mono : undefined,
          fontSize: small ? 10.5 : 11.5,
          color: colors.muted,
        }}
      >
        {v}
      </Text>
    </View>
  );
}
