// Family/friends groups (docs/platform.md §13): invite links, the pending join from a deep link, and
// the user's group list.

import { useCallback, useEffect, useState } from 'react';
import { Share } from 'react-native';
import { api, ApiError, type Group } from './api';
import { errorMessage } from './theme';

/** Public invite link. The app opens it at app/join/[code].tsx (also dreamsy://join/<code>). */
export const inviteUrl = (code: string) => `https://dreamsy.dev/join/${encodeURIComponent(code)}`;

export async function shareInvite(group: { name: string }, code: string) {
  const url = inviteUrl(code);
  // iOS shows `url` as a link preview; Android only reads `message`.
  await Share.share({ message: `Join "${group.name}" on Dreamsy: ${url} (code ${code})`, url, title: group.name }).catch(() => {});
}

/** "abcd-2345" -> "ABCD2345", as the API normalizes it. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

// An invite opened while signed out (or before onboarding): joined once the user lands in the app.
let pending: string | null = null;
export const setPendingJoin = (code: string | null) => {
  pending = code;
};
export const hasPendingJoin = () => pending !== null;
export const takePendingJoin = (): string | null => {
  const c = pending;
  pending = null;
  return c;
};

/** GET /v1/me/groups, with a refresh. */
export function useMyGroups() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setGroups((await api.myGroups()).groups);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { groups, error, refresh };
}

/** POST /v1/groups/join errors in plain words. */
export function joinError(e: unknown): string {
  if (e instanceof ApiError && e.status === 404) return 'That invite doesn’t work any more. Ask for a new link.';
  if (e instanceof ApiError && e.status === 409) return 'That group is full (50 people).';
  if (e instanceof ApiError && e.status === 400) return 'Invite codes are 8 letters and numbers.';
  return errorMessage(e);
}
