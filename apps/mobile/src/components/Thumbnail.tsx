import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { absoluteApiUrl } from '../api';
import { ink } from '../theme';
import { Sparkle, Txt } from '../ui';

export type ThumbnailProps = {
  /** thumbnailUrl from the API (absolute or API-relative); null = drawn fallback. */
  url: string | null | undefined;
  /** Seeds the fallback layout. */
  seed: string;
  /** Shown on the fallback. */
  name?: string;
  headers?: Record<string, string>;
  style?: StyleProp<ViewStyle>;
  /** Fallback title size. */
  size?: 'sm' | 'lg';
};

const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Game thumbnail; without one (or if it fails), paper with sparkles and the name in pixel caps. */
export function Thumbnail({ url, seed, name, headers, style, size = 'sm' }: ThumbnailProps) {
  const uri = absoluteApiUrl(url);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [uri]);
  const h = hash(seed);
  const showImage = !!uri && !failed;

  return (
    <View style={[styles.box, style]}>
      {!showImage && (
        <View style={styles.fallback}>
          <Sparkle size={size === 'lg' ? 26 : 14} style={{ position: 'absolute', left: `${10 + (h % 30)}%`, top: '14%' }} />
          <Sparkle size={size === 'lg' ? 14 : 8} style={{ position: 'absolute', right: `${12 + (h % 25)}%`, bottom: '18%' }} />
          {!!name && (
            <Txt variant="pixel" center numberOfLines={3} style={size === 'lg' ? styles.nameLg : styles.name}>
              {name}
            </Txt>
          )}
        </View>
      )}
      {showImage && (
        <Image
          source={{ uri, headers }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          transition={150}
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
  fallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  name: { fontSize: 12 },
  nameLg: { fontSize: 20, lineHeight: 24, paddingHorizontal: 24 },
});
