import { InkAvatar } from '../avatar';
import type { AvatarParts } from '../api';

/** A person's ink avatar in a circle (their own, or one derived from their id). */
export function Avatar({ user, size = 32 }: { user: { id: string; avatar?: AvatarParts | null }; size?: number }) {
  return <InkAvatar avatar={user.avatar} seed={user.id} size={size} />;
}
