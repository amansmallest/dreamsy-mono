import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { useColors } from '../theme';

/** Horizontal pill tabs (feed tabs, market sort). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const c = useColors();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={[styles.pill, { backgroundColor: on ? c.fg : c.card }]}
          >
            <Text style={[styles.label, { color: on ? c.bg : c.fg }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: 8, paddingVertical: 2 },
  pill: { paddingHorizontal: 14, height: 32, borderRadius: 16, justifyContent: 'center' },
  label: { fontSize: 14, fontWeight: '600' },
});
