import * as Haptics from 'expo-haptics';

// Haptics on iOS / Android; no-ops on web (haptics.web.ts). Never throws.

/** Light tick for taps and selections. */
export const selection = () => void Haptics.selectionAsync().catch(() => {});
/** Success buzz (coins in, invite, QR read). */
export const success = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
