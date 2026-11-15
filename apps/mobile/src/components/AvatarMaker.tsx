import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { AVATAR_PARTS, InkAvatar, PART_ORDER, randomAvatar, type AvatarConfig, type AvatarPart } from '../avatar';
import { ink } from '../theme';
import { Chip, RoundButton, Sparkle, Txt, type IconName } from '../ui';

const PART_ICON: Record<AvatarPart, IconName> = {
  hat: 'school-outline',
  head: 'ellipse-outline',
  eyes: 'eye-outline',
  mouth: 'happy-outline',
  extra: 'glasses-outline',
  body: 'shirt-outline',
};

/** Big figure with sparkles, as on the profile hero. */
export function AvatarHero({ avatar, seed, size = 220 }: { avatar: AvatarConfig | Record<string, number> | null | undefined; seed: string; size?: number }) {
  return (
    <View style={[styles.hero, { width: size + 80, height: size }]}>
      <Sparkle size={size * 0.15} style={{ position: 'absolute', left: 10, top: size * 0.08 }} />
      <Sparkle size={size * 0.07} style={{ position: 'absolute', left: size * 0.2, top: size * 0.24 }} />
      <Sparkle size={size * 0.13} style={{ position: 'absolute', right: 14, bottom: size * 0.18 }} />
      <Sparkle size={size * 0.07} style={{ position: 'absolute', right: size * 0.02, bottom: size * 0.38 }} />
      <InkAvatar avatar={avatar} seed={seed} size={size} framed={false} />
    </View>
  );
}

/** Pick a category (round buttons), then cycle its options with the arrows. */
export function AvatarMaker({ value, onChange, seed }: { value: AvatarConfig; onChange: (a: AvatarConfig) => void; seed: string }) {
  const [part, setPart] = useState<AvatarPart>('hat');
  const options = AVATAR_PARTS[part];
  const index = value[part];
  const step = (d: number) => onChange({ ...value, [part]: (index + d + options.length) % options.length });

  return (
    <View style={styles.maker}>
      <AvatarHero avatar={value} seed={seed} />

      <View style={styles.pickerRow}>
        <RoundButton icon="chevron-back" size={46} label={`Previous ${part}`} onPress={() => step(-1)} />
        <View style={styles.pickerText}>
          <Txt variant="title" center numberOfLines={1}>
            {options[index]}
          </Txt>
          <Txt variant="meta" muted center>
            {part} {index + 1} of {options.length}
          </Txt>
        </View>
        <RoundButton icon="chevron-forward" size={46} label={`Next ${part}`} onPress={() => step(1)} />
      </View>

      <View style={styles.parts}>
        {PART_ORDER.map((p) => (
          <View key={p} style={styles.part}>
            <RoundButton icon={PART_ICON[p]} size={50} filled={p === part} label={p} onPress={() => setPart(p)} />
            <Txt variant="label" color={p === part ? ink.fg : ink.muted}>
              {p}
            </Txt>
          </View>
        ))}
      </View>

      <View style={styles.roll}>
        <Chip icon="dice-outline" label="Surprise me" onPress={() => onChange(randomAvatar())} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  maker: { alignItems: 'center', gap: 18 },
  hero: { alignItems: 'center', justifyContent: 'center' },
  pickerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'stretch' },
  pickerText: { flex: 1, gap: 2 },
  parts: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, rowGap: 12 },
  part: { alignItems: 'center', gap: 5, width: 54 },
  roll: { alignItems: 'center' },
});
