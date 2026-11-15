import { StyleSheet, Text, View } from 'react-native';

export function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  title: { fontSize: 22, fontWeight: '600', color: '#888' },
  body: { fontSize: 15, color: '#888', textAlign: 'center' },
});
