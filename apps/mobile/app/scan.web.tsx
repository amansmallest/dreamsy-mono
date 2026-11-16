import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ink } from '@/theme';
import { Empty, SquareButton } from '@/ui';

/** Web (PWA): no QR scanning here; the entry points are hidden, this covers a direct /scan link. */
export default function ScanScreen() {
  const close = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return (
    <SafeAreaView style={styles.paper}>
      <View style={styles.topBar}>
        <SquareButton icon="close" label="Close" onPress={close} />
      </View>
      <Empty title="Scan in the phone app" body="Use the Dreamsy phone app to scan QR codes." />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  paper: { flex: 1, backgroundColor: ink.bg },
  topBar: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 8 },
});
