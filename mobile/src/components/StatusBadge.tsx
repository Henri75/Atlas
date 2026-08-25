import { Text } from 'react-native';
import { colors, fonts } from '../theme';

/**
 * 499/500 on the stream route are outcomes, not wire statuses — name them.
 * (Ported from the web CallsTab StatusBadge.)
 */
export function StatusBadgeNative({ status }: { status: number }) {
  if (status === 499) {
    return <Text style={{ color: colors.kdb, fontSize: 11, fontFamily: fonts.mono }}>aborted</Text>;
  }
  if (status >= 400) {
    return <Text style={{ color: colors.report, fontSize: 11, fontFamily: fonts.mono }}>{status}</Text>;
  }
  return <Text style={{ color: colors.faint, fontSize: 11, fontFamily: fonts.mono }}>{status}</Text>;
}
