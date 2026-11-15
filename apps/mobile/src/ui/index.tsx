import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { font, ink, radius, stroke } from '../theme';

// The ink kit: every screen builds from these so the look stays consistent.

export type IconName = ComponentProps<typeof Ionicons>['name'];

const tap = () => void Haptics.selectionAsync().catch(() => {});

/** Four-point sparkle, the brand mark. */
export function Sparkle({ size = 16, color = ink.fg, style }: { size?: number; color?: string; style?: StyleProp<ViewStyle> }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" style={style as never}>
      <Path d="M12 0 C13 8 16 11 24 12 C16 13 13 16 12 24 C11 16 8 13 0 12 C8 11 11 8 12 0 Z" fill={color} />
    </Svg>
  );
}

const TEXT: Record<string, TextStyle> = {
  display: { fontFamily: font.bold, fontSize: 32, letterSpacing: -0.8, lineHeight: 36 },
  title: { fontFamily: font.bold, fontSize: 24, letterSpacing: -0.5, lineHeight: 28 },
  heading: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: font.body, fontSize: 16, lineHeight: 22 },
  meta: { fontFamily: font.medium, fontSize: 13, lineHeight: 17 },
  label: { fontFamily: font.pixel, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  pixel: { fontFamily: font.pixelBold, fontSize: 14, letterSpacing: 0.4, textTransform: 'uppercase' },
};

export type TxtVariant = 'display' | 'title' | 'heading' | 'body' | 'meta' | 'label' | 'pixel';

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
      style={[
        TEXT[variant],
        { color: color ?? (muted ? ink.muted : ink.fg) },
        center && { textAlign: 'center' },
        style,
      ]}
    />
  );
}

type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'solid' | 'outline';
  icon?: IconName;
  /** Sparkles at both ends (the hero button). */
  sparkles?: boolean;
  busy?: boolean;
  disabled?: boolean;
  size?: 'lg' | 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

const HEIGHT = { lg: 58, md: 48, sm: 38 } as const;

/** Pill button: solid ink (primary) or outlined paper. */
export function InkButton({
  label,
  onPress,
  variant = 'solid',
  icon,
  sparkles,
  busy,
  disabled,
  size = 'lg',
  style,
  accessibilityLabel,
}: ButtonProps) {
  const solid = variant === 'solid';
  const fg = solid ? ink.accentFg : ink.fg;
  const off = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      disabled={off}
      onPress={() => {
        tap();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.button,
        {
          height: HEIGHT[size],
          paddingHorizontal: size === 'sm' ? 14 : 22,
          backgroundColor: solid ? (pressed ? '#333' : ink.fg) : pressed ? ink.wash : ink.card,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        style,
      ]}
    >
      {sparkles && <Sparkle size={14} color={fg} style={styles.sparkleLeft} />}
      {busy ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.buttonInner}>
          {icon && <Ionicons name={icon} size={size === 'sm' ? 15 : 18} color={fg} />}
          <Txt variant="pixel" color={fg} style={size === 'sm' && { fontSize: 12 }} numberOfLines={1}>
            {label}
          </Txt>
        </View>
      )}
      {sparkles && <Sparkle size={14} color={fg} style={styles.sparkleRight} />}
    </Pressable>
  );
}

/** Round outlined icon button (the reference's bottom row). */
export function RoundButton({
  icon,
  onPress,
  size = 64,
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        tap();
        onPress?.();
      }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.round,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: filled ? ink.fg : pressed ? ink.wash : ink.card,
          opacity: disabled ? 0.4 : 1,
          transform: [{ scale: pressed ? 0.95 : 1 }],
        },
      ]}
    >
      <Ionicons name={icon} size={Math.round(size * 0.4)} color={color ?? (filled ? ink.accentFg : ink.fg)} />
    </Pressable>
  );
}

/** Rounded-square outlined icon button (header corners). */
export function SquareButton({
  icon,
  onPress,
  label,
  size = 42,
  children,
}: {
  icon?: IconName;
  onPress?: () => void;
  label: string;
  size?: number;
  children?: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        styles.square,
        { width: size, height: size, backgroundColor: pressed ? ink.wash : ink.card },
      ]}
    >
      {children ?? (icon && <Ionicons name={icon} size={20} color={ink.fg} />)}
    </Pressable>
  );
}

/** Outlined paper card. */
export function Card({
  children,
  style,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  if (!onPress) return <View style={[styles.card, style]}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.card, { transform: [{ scale: pressed ? 0.985 : 1 }] }, style]}
    >
      {children}
    </Pressable>
  );
}

/** Screen header: corner buttons + centered pixel title with a small line under it. */
export function Header({
  title,
  subtitle,
  left,
  right,
  style,
}: {
  title: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
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
      <View style={[styles.headerSide, styles.headerRight]}>{right}</View>
    </View>
  );
}

/** Outlined pill tabs; the selected one is filled with ink. */
export function Pills<T extends string>({
  options,
  value,
  onChange,
  style,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
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
            style={[styles.pill, { backgroundColor: on ? ink.fg : ink.card }]}
          >
            <Txt variant="label" color={on ? ink.accentFg : ink.fg}>
              {o.label}
            </Txt>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** Outlined progress track with an ink fill (0..1). */
export function ProgressBar({ value, height = 16, style }: { value: number; height?: number; style?: StyleProp<ViewStyle> }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }, style]}>
      <View style={{ width: `${Math.max(pct > 0 ? 6 : 0, pct * 100)}%`, height: '100%', backgroundColor: ink.fg, borderRadius: height / 2 }} />
    </View>
  );
}

/** Outlined text field. */
export function Field({ style, prefix, ...props }: TextInputProps & { prefix?: string }) {
  return (
    <View style={[styles.field, props.multiline && styles.fieldMulti, style as StyleProp<ViewStyle>]}>
      {!!prefix && (
        <Txt variant="heading" muted>
          {prefix}
        </Txt>
      )}
      <TextInput placeholderTextColor={ink.muted} selectionColor={ink.fg} {...props} style={[styles.fieldInput, props.multiline && styles.fieldInputMulti]} />
    </View>
  );
}

/** Centered sparkle + message for empty and error states. */
export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyMarks}>
        <Sparkle size={22} />
        <Sparkle size={12} style={{ marginTop: 18 }} />
      </View>
      <Txt variant="pixel" center>
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
  return <ActivityIndicator color={ink.fg} style={[{ marginTop: 32 }, style]} />;
}

/** Small outlined chip with an optional icon. */
export function Chip({ label, icon, onPress, filled }: { label: string; icon?: IconName; onPress?: () => void; filled?: boolean }) {
  const fg = filled ? ink.accentFg : ink.fg;
  return (
    <Pressable
      disabled={!onPress}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [styles.chip, { backgroundColor: filled ? ink.fg : pressed ? ink.wash : ink.card }]}
    >
      {icon && <Ionicons name={icon} size={13} color={fg} />}
      <Txt variant="meta" color={fg} numberOfLines={1} style={{ flexShrink: 1 }}>
        {label}
      </Txt>
    </Pressable>
  );
}

export const inkStyles = StyleSheet.create({
  outline: { borderWidth: stroke.base, borderColor: ink.fg },
});

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.pill,
    borderWidth: stroke.base,
    borderColor: ink.fg,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sparkleLeft: { position: 'absolute', left: 22 },
  sparkleRight: { position: 'absolute', right: 22 },
  round: { borderWidth: stroke.bold, borderColor: ink.fg, alignItems: 'center', justifyContent: 'center' },
  square: { borderWidth: stroke.base, borderColor: ink.fg, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: ink.card, borderWidth: stroke.base, borderColor: ink.fg, borderRadius: radius.lg, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 8, minHeight: 58 },
  headerSide: { width: 56, flexDirection: 'row' },
  headerRight: { justifyContent: 'flex-end' },
  headerMid: { flex: 1, alignItems: 'center', gap: 1 },
  pills: { gap: 8, paddingVertical: 2 },
  pill: { paddingHorizontal: 14, height: 34, borderRadius: radius.pill, justifyContent: 'center', borderWidth: stroke.base, borderColor: ink.fg },
  track: { borderWidth: stroke.base, borderColor: ink.fg, backgroundColor: ink.card, overflow: 'hidden', padding: 2 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: stroke.base,
    borderColor: ink.fg,
    borderRadius: radius.md,
    backgroundColor: ink.card,
    paddingHorizontal: 14,
    minHeight: 50,
  },
  fieldMulti: { alignItems: 'flex-start', paddingVertical: 10 },
  fieldInput: { flex: 1, fontFamily: font.medium, fontSize: 16, color: ink.fg, paddingVertical: 0 },
  fieldInputMulti: { minHeight: 64, textAlignVertical: 'top' },
  empty: { alignItems: 'center', gap: 10, paddingHorizontal: 32, paddingVertical: 40 },
  emptyMarks: { flexDirection: 'row', gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    borderWidth: stroke.thin,
    borderColor: ink.fg,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: '100%',
  },
});
