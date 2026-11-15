import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useAuth } from '@/auth';
import { Avatar } from '@/components/Avatar';
import { font, hairline, ink, radius } from '@/theme';
import type { IconName } from '@/ui';

const icon =
  (on: IconName, off: IconName) =>
  ({ focused }: { focused: boolean }) => <Ionicons name={focused ? on : off} color={focused ? ink.accent : ink.muted} size={24} />;

/** Create: a blue rounded square in the middle slot. */
function CreateIcon({ focused }: { focused: boolean }) {
  return (
    <View style={[styles.create, focused && styles.createOn]}>
      <Ionicons name="add" size={24} color={focused ? ink.accent : ink.accentFg} />
    </View>
  );
}

function MeIcon({ focused }: { focused: boolean }) {
  const { user } = useAuth();
  if (!user) return icon('person-circle', 'person-circle-outline')({ focused });
  return (
    <View style={[styles.me, focused && styles.meOn]}>
      <Avatar user={user} size={26} />
    </View>
  );
}

/** Five labelled slots: Home, Discover, Create, Shop, Me. */
export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: ink.accent,
        tabBarInactiveTintColor: ink.muted,
        tabBarLabelStyle: styles.label,
        sceneStyle: { backgroundColor: ink.bg },
        tabBarStyle: styles.bar,
        tabBarItemStyle: styles.item,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('home', 'home-outline') }} />
      <Tabs.Screen name="search" options={{ title: 'Discover', tabBarIcon: icon('compass', 'compass-outline') }} />
      <Tabs.Screen name="create" options={{ title: 'Create', tabBarIcon: CreateIcon }} />
      <Tabs.Screen name="market" options={{ title: 'Shop', tabBarIcon: icon('bag-handle', 'bag-handle-outline') }} />
      <Tabs.Screen name="profile" options={{ title: 'Me', tabBarIcon: MeIcon }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: { backgroundColor: ink.card, borderTopWidth: hairline, borderTopColor: ink.border, elevation: 0, height: 84, paddingTop: 8 },
  item: { paddingTop: 2 },
  label: { fontFamily: font.semibold, fontSize: 10, marginTop: 2 },
  create: { width: 40, height: 30, borderRadius: radius.sm, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  createOn: { backgroundColor: ink.wash },
  me: { borderRadius: 16, padding: 1.5, borderWidth: 1.5, borderColor: 'transparent' },
  meOn: { borderColor: ink.accent },
});
