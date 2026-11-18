import { StyleSheet, Switch, View, type StyleProp, type ViewStyle } from 'react-native';
import type { Visibility } from '../api';
import { ink } from '../theme';
import { Txt } from '../ui';

export const visibilityHint = (v: Visibility) =>
  v === 'public' ? 'Public: everyone can play the newest version' : 'Private: only you (and groups you share with)';

/** docs/platform.md §11.8: Public (newest version auto-live) / Private switch with its one-line explainer. */
export function VisibilitySwitch({ value, onChange, disabled, style }: {
  value: Visibility;
  onChange: (v: Visibility) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const on = value === 'public';
  return (
    <View style={[styles.wrap, style]}>
      <View style={styles.row}>
        <Txt variant="label">{on ? 'Public' : 'Private'}</Txt>
        <Switch
          value={on}
          disabled={disabled}
          onValueChange={(next) => onChange(next ? 'public' : 'private')}
          trackColor={{ false: ink.border, true: ink.accent }}
          accessibilityLabel="Public"
        />
      </View>
      <Txt variant="meta" muted>
        {visibilityHint(value)}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
});
