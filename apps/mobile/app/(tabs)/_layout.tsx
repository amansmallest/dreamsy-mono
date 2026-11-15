import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { font, ink, stroke } from '@/theme';
import type { IconName } from '@/ui';

const icon =
  (on: IconName, off: IconName) =>
  ({ focused }: { focused: boolean }) => <Ionicons name={focused ? on : off} color={ink.fg} size={24} />;

/** The middle tab is a big ink button: making games is the point. */
function CreateIcon({ focused }: { focused: boolean }) {
  return (
    <View style={[styles.create, focused && styles.createOn]}>
      <Ionicons name="add" size={28} color={focused ? ink.fg : ink.accentFg} />
    </View>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        sceneStyle: { backgroundColor: ink.bg },
        tabBarActiveTintColor: ink.fg,
        tabBarInactiveTintColor: ink.muted,
        tabBarStyle: styles.bar,
        tabBarLabelStyle: styles.label,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Play', tabBarIcon: icon('game-controller', 'game-controller-outline') }} />
      <Tabs.Screen name="create" options={{ title: 'Make', tabBarIcon: CreateIcon }} />
      <Tabs.Screen name="market" options={{ title: 'Shop', tabBarIcon: icon('bag-handle', 'bag-handle-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'Me', tabBarIcon: icon('person', 'person-outline') }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: ink.bg, borderTopWidth: stroke.base, borderTopColor: ink.fg, elevation: 0, height: 88, paddingTop: 8 },
  label: { fontFamily: font.pixel, fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', marginTop: 4 },
  create: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: ink.fg,
    borderWidth: stroke.base,
    borderColor: ink.fg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -8,
  },
  createOn: { backgroundColor: ink.card },
});
