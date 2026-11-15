import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { absoluteApiUrl } from '../api';
import { ink } from '../theme';
import { PixelSky, Txt } from '../ui';

export type ThumbnailProps = {
  /** thumbnailUrl from the API (absolute or API-relative); null = pixel-sky fallback. */
  url: string | null | undefined;
  /** Kept for callers; the fallback is the same sky for every game. */
  seed: string;
  /** Shown on the fallback. */
  name?: string;
  headers?: Record<string, string>;
  style?: StyleProp<ViewStyle>;
  /** Fallback title size. */
  size?: 'sm' | 'lg';
};

/** Game cover; without one (or if it fails), a pixel sky with the name. */
export function Thumbnail({ url, name, headers, style, size = 'sm' }: ThumbnailProps) {
  const uri = absoluteApiUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const showImage = !!uri && !failed;

  return (
    <View style={[styles.box, style]}>
      {!showImage && (
        <>
          <PixelSky style={StyleSheet.absoluteFill} />
          {!!name && (
            <View style={styles.center}>
              <Txt variant={size === 'lg' ? 'title' : 'heading'} color={ink.navy} center numberOfLines={3} style={size === 'sm' && styles.sm}>
                {name}
              </Txt>
            </View>
          )}
        </>
      )}
      {showImage && (
        <Image
          source={{ uri, headers }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={180}
          cachePolicy="memory-disk"
          recyclingKey={uri}
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: ink.wash },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 14 },
  sm: { fontSize: 13, lineHeight: 16 },
});
