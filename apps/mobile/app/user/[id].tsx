import { Stack, useLocalSearchParams } from 'expo-router';
import { ProfileView } from '@/components/ProfileView';

/** A creator's public profile. */
export default function UserScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: '' }} />
      <ProfileView userId={id} />
    </>
  );
}
