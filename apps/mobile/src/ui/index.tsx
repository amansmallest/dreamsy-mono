import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { font, hairline, ink, radius } from '../theme';
import { PixelSparkle } from './pixel';

export { PixelCloud, PixelSky, PixelSparkle } from './pixel';

// The Sky kit (apps/DESIGN.md). Every screen builds from these.

export type IconName = ComponentProps<typeof Ionicons>['name'];

export const tap = () => void Haptics.selectionAsync().catch(() => {});

/** Brand sparkle (pixel). Kept under its old name; `color` defaults to the accent. */
export function Sparkle({ size = 16, color, style }: { size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  return <PixelSparkle size={size} color={color} style={style} />;
}

const TEXT: Record<TxtVariant, TextStyle> = {
  display: { fontFamily: font.display, fontSize: 34, letterSpacing: -1, lineHeight: 38 },
  title: { fontFamily: font.display, fontSize: 24, letterSpacing: -0.6, lineHeight: 28 },
  heading: { fontFamily: font.semibold, fontSize: 16, letterSpacing: -0.2, lineHeight: 21 },
  body: { fontFamily: font.body, fontSize: 15, lineHeight: 21 },
  meta: { fontFamily: font.medium, fontSize: 13, lineHeight: 17 },
  /** Small UI label (buttons in rows, section titles). */
  label: { fontFamily: font.semibold, fontSize: 13, letterSpacing: -0.1 },
  /** Strong UI text (header titles, button labels). */
  pixel: { fontFamily: font.displayBold, fontSize: 16, letterSpacing: -0.3 },
  /** Pixel-font badge: LIVE, NEW, v3. */
  badge: { fontFamily: font.pixel, fontSize: 10, letterSpacing: 0.6, textTransform: 'uppercase' },
};

export type TxtVariant = 'display' | 'title' | 'heading' | 'body' | 'meta' | 'label' | 'pixel' | 'badge';

export function Txt({
  variant = 'body',
  color,
  muted,
  center,
  style,
  ...rest
}: TextProps & { variant?: TxtVariant; color?: string; muted?: boolean; center?: boolean }) {
  return (
    <Text
      {...rest}
      style={[TEXT[variant], { color: color ?? (muted ? ink.muted : ink.fg) }, center && { textAlign: 'center' }, style]}
    />
  );
}

/** Pressable that sinks a little when touched. */
export function Pressy({ style, children, haptic = true, onPress, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean }) {
  return (
    <Pressable
      {...rest}
      onPress={(e) => {
        if (haptic) tap();
        onPress?.(e);
      }}
      style={({ pressed }) => [style, { transform: [{ scale: pressed ? 0.97 : 1 }], opacity: pressed ? 0.92 : 1 }]}
    >
      {children}
    </Pressable>
  );
}

type ButtonProps = {
  label: string;
  onPress?: () => void;
  /** solid = blue (primary), dark = navy, outline = white with hairline, ghost = text only. */
  variant?: 'solid' | 'dark' | 'outline' | 'ghost';
  icon?: IconName;
  /** A pixel sparkle before the label (for the one hero action on a screen). */
  sparkles?: boolean;
  busy?: boolean;
  disabled?: boolean;
  size?: 'lg' | 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

const HEIGHT = { lg: 52, md: 44, sm: 34 } as const;

export function Button({ label, onPress, variant = 'solid', icon, sparkles, busy, disabled, size = 'lg', style, accessibilityLabel }: ButtonProps) {
  const bg = { solid: ink.accent, dark: ink.navy, outline: ink.card, ghost: 'transparent' }[variant];
  const fg = variant === 'solid' || variant === 'dark' ? ink.accentFg : variant === 'ghost' ? ink.accent : ink.fg;
  const off = disabled || busy;
  return (
    <Pressy
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={[
        styles.button,
        {
          height: HEIGHT[size],
          paddingHorizontal: size === 'sm' ? 14 : 20,
          borderRadius: size === 'sm' ? radius.sm : radius.md,
          backgroundColor: bg,
          borderWidth: variant === 'outline' ? hairline : 0,
          opacity: disabled ? 0.4 : 1,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.buttonInner}>
          {sparkles && <PixelSparkle size={12} color={fg} />}
          {icon && <Ionicons name={icon} size={size === 'sm' ? 15 : 18} color={fg} />}
          <Txt variant="pixel" color={fg} style={size === 'sm' ? styles.buttonSm : size === 'md' ? styles.buttonMd : undefined} numberOfLines={1}>
            {label}
          </Txt>
        </View>
      )}
    </Pressy>
  );
}

/** Old name for Button. */
export const InkButton = Button;

/** Round icon button. */
export function RoundButton({
  icon,
  onPress,
  size = 56,
  filled,
  label,
  disabled,
  color,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  filled?: boolean;
  label: string;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <Pressy
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={6}
      style={[
        styles.round,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: filled ? ink.accent : ink.card, borderWidth: filled ? 0 : hairline, opacity: disabled ? 0.4 : 1 },
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.42)} color={color ?? (filled ? ink.accentFg : ink.fg)} />
    </Pressy>
  );
}

/** Plain icon button (header corners, toolbars). */
export function SquareButton({ icon, onPress, label, size = 40, children }: { icon?: IconName; onPress?: () => void; label: string; size?: number; children?: ReactNode }) {
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={label} onPress={onPress} hitSlop={8} style={[styles.square, { width: size, height: size }]}>
      {children ?? (icon && <Ionicons name={icon} size={24} color={ink.fg} />)}
    </Pressy>
  );
}

export const IconButton = SquareButton;

/** White card with a hairline. */
export function Card({ children, style, onPress, accessibilityLabel }: { children: ReactNode; style?: StyleProp<ViewStyle>; onPress?: () => void; accessibilityLabel?: string }) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressy accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} haptic={false} style={[styles.card, style]}>
      {children}
    </Pressy>
  );
}

/**
 * Screen header. Without `left`: a big left-aligned title (Instagram tab style). With `left`: a
 * compact centered title between the corners.
 */
export function Header({ title, subtitle, left, right, style }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode; style?: StyleProp<ViewStyle> }) {
  if (!left) {
    return (
      <View style={[styles.header, style]}>
        <View style={styles.headerBig}>
          <Txt variant="title" numberOfLines={1}>
            {title}
          </Txt>
          {!!subtitle && (
            <Txt variant="meta" muted numberOfLines={1}>
              {subtitle}
            </Txt>
          )}
        </View>
        {right && <View style={styles.headerRight}>{right}</View>}
      </View>
    );
  }
  return (
    <View style={[styles.header, style]}>
      <View style={styles.headerSide}>{left}</View>
      <View style={styles.headerMid}>
        <Txt variant="pixel" center numberOfLines={1}>
          {title}
        </Txt>
        {!!subtitle && (
          <Txt variant="meta" muted center numberOfLines={1}>
            {subtitle}
          </Txt>
        )}
      </View>
      <View style={[styles.headerSide, styles.headerSideRight]}>{right}</View>
    </View>
  );
}

/** Text tabs; the selected one is ink with a blue underline. */
export function Pills<T extends string>({ options, value, onChange, style }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; style?: StyleProp<ViewStyle> }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.pills, style]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) tap();
              onChange(o.value);
            }}
            hitSlop={6}
            style={[styles.pill, on && styles.pillOn]}
          >
            <Txt variant="label" color={on ? ink.accentFg : ink.muted}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Blue progress on a mist track (0..1). */
export function ProgressBar({ value, height = 8, style }: { value: number; height?: number; style?: StyleProp<ViewStyle> }) {
  const pct = Math.max(0, Math.min(1, value));
  const w = useRef(new Animated.Value(pct)).current;
  useEffect(() => {
    Animated.timing(w, { toValue: pct, duration: 500, useNativeDriver: false }).start();
  }, [pct, w]);
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }, style]}>
      <Animated.View
        style={{
          width: w.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
          height: '100%',
          backgroundColor: ink.accent,
          borderRadius: height / 2,
        }}
      />
    </View>
  );
}

/** Text field on a white surface. */
export function Field({ style, prefix, ...props }: TextInputProps & { prefix?: string }) {
  return (
    <View style={[styles.field, props.multiline && styles.fieldMulti, style as StyleProp<ViewStyle>]}>
      {!!prefix && <Txt variant="heading" muted>{prefix}</Txt>}
      <TextInput placeholderTextColor={ink.faint} selectionColor={ink.accent} {...props} style={[styles.fieldInput, props.multiline && styles.fieldInputMulti]} />
    </View>
  );
}

/** Pixel clouds + message for empty and error states. */
export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyArt}>
        <PixelSparkle size={22} />
      </View>
      <Txt variant="heading" center>
        {title}
      </Txt>
      {!!body && (
        <Txt variant="body" muted center>
          {body}
        </Txt>
      )}
      {action}
    </View>
  );
}

export function Loading({ style }: { style?: StyleProp<ViewStyle> }) {
  return <ActivityIndicator color={ink.accent} style={[{ marginTop: 32 }, style]} />;
}

/** Shimmering placeholder block. */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={[styles.skeleton, { opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] }) }, style]} />;
}

/** Small pill with an optional icon. */
export function Chip({ label, icon, onPress, filled }: { label: string; icon?: IconName; onPress?: () => void; filled?: boolean }) {
  const fg = filled ? ink.accentFg : ink.navy;
  return (
    <Pressy disabled={!onPress} onPress={onPress} hitSlop={4} style={[styles.chip, filled && styles.chipOn]}>
      {icon && <Ionicons name={icon} size={13} color={fg} />}
      <Txt variant="meta" color={fg} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Txt>
    </Pressy>
  );
}

/** Pixel-font badge: LIVE, NEW, v3, BUILDING. */
export function Badge({ label, tone = 'sky', style }: { label: string; tone?: 'sky' | 'blue' | 'navy' | 'ok' | 'white'; style?: StyleProp<ViewStyle> }) {
  const bg = { sky: ink.wash, blue: ink.accent, navy: ink.navy, ok: ink.ok, white: ink.card }[tone];
  const fg = tone === 'sky' || tone === 'white' ? ink.navy : ink.accentFg;
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      <Txt variant="badge" color={fg}>
        {label}
      </Txt>
    </View>
  );
}

export function Divider({ style }: { style?: StyleProp<ViewStyle> }) {
  return <View style={[{ height: hairline, backgroundColor: ink.border }, style]} />;
}

export const inkStyles = StyleSheet.create({
  outline: { borderWidth: hairline, borderColor: ink.border },
});

const styles = StyleSheet.create({
  button: { alignItems: 'center', justifyContent: 'center', flexDirection: 'row', borderColor: ink.border },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buttonMd: { fontSize: 15 },
  buttonSm: { fontSize: 13 },
  round: { borderColor: ink.border, alignItems: 'center', justifyContent: 'center' },
  square: { alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: ink.card, borderWidth: hairline, borderColor: ink.border, borderRadius: radius.lg, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8, minHeight: 52, gap: 8 },
  headerBig: { flex: 1, gap: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  headerSide: { width: 56, flexDirection: 'row' },
  headerSideRight: { justifyContent: 'flex-end' },
  headerMid: { flex: 1, alignItems: 'center', gap: 1 },
  pills: { gap: 6, paddingVertical: 2 },
  pill: { paddingHorizontal: 14, height: 32, borderRadius: radius.pill, justifyContent: 'center', backgroundColor: ink.card, borderWidth: hairline, borderColor: ink.border },
  pillOn: { backgroundColor: ink.navy, borderColor: ink.navy },
  track: { backgroundColor: ink.wash, overflow: 'hidden' },
  field: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: hairline, borderColor: ink.border, borderRadius: radius.md, backgroundColor: ink.card, paddingHorizontal: 14, minHeight: 48 },
  fieldMulti: { alignItems: 'flex-start', paddingVertical: 10 },
  fieldInput: { flex: 1, fontFamily: font.medium, fontSize: 16, color: ink.fg, paddingVertical: 0 },
  fieldInputMulti: { minHeight: 64, textAlignVertical: 'top' },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 32, paddingVertical: 40 },
  emptyArt: { width: 64, height: 64, borderRadius: 32, backgroundColor: ink.wash, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  skeleton: { backgroundColor: ink.wash, borderRadius: radius.md },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: ink.wash, borderRadius: radius.pill, paddingHorizontal: 11, paddingVertical: 6, maxWidth: '100%' },
  chipOn: { backgroundColor: ink.accent },
  badge: { alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 3 },
});
