import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { api, type Earnings } from '../api';
import { formatCoins, formatUsd } from '../coins';
import { compact } from '../social';
import { hairline, ink, radius } from '../theme';
import { PixelCoin, Txt } from '../ui';

/**
 * Creator earnings (§11.6): 9K coins each time someone plays your game. Hidden until it loads, and
 * stays hidden when GET /v1/me/earnings fails (an API without coins answers 404).
 * `reloadKey` changes = refetch (pull to refresh).
 */
export function EarningsCard({ reloadKey = 0 }: { reloadKey?: number }) {
  const [data, setData] = useState<Earnings | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      api.earnings().then(
        (r) => !cancelled && setData(r),
        () => !cancelled && setData(null),
      );
      return () => {
        cancelled = true;
      };
    }, [reloadKey]),
  );

  if (!data) return null;
  const top = [...(data.games ?? [])].sort((a, b) => b.coins - a.coins).slice(0, 5);

  return (
    <View style={styles.card}>
      <Txt variant="pixel">Earnings</Txt>
      <View style={styles.totalRow}>
        <View style={styles.coin}>
          <PixelCoin size={14} color={ink.accentFg} />
        </View>
        <View style={styles.flex}>
          <Txt variant="title" color={ink.navy} numberOfLines={1}>
            {formatCoins(data.totalCoins, true)}
            <Txt variant="title" muted>
              {' · '}
              {formatUsd(data.totalCoins, data.usd?.total)}
            </Txt>
          </Txt>
          <Txt variant="meta" muted>
            Total earned from plays
          </Txt>
        </View>
      </View>

      <View style={styles.stats}>
        <Stat value={`+${formatCoins(data.todayCoins)}`} sub={formatUsd(data.todayCoins, data.usd?.today)} label="Today" />
        <Stat value={compact(data.paidPlays)} label="Paid plays" />
      </View>

      {top.length === 0 ? (
        <Txt variant="meta" muted>
          You earn {formatCoins(9000, true)} each time someone plays one of your published games.
        </Txt>
      ) : (
        <View style={styles.list}>
          {top.map((g, i) => (
            <Pressable
              key={g.gameId}
              onPress={() => router.push({ pathname: '/discover/[id]', params: { id: g.gameId } })}
              style={[styles.row, i < top.length - 1 && styles.line]}
            >
              <View style={styles.flex}>
                <Txt variant="heading" numberOfLines={1}>
                  {g.name}
                </Txt>
                <Txt variant="meta" muted>
                  {compact(g.plays)} {g.plays === 1 ? 'play' : 'plays'}
                </Txt>
              </View>
              <Txt variant="label" color={ink.ok}>
                +{formatCoins(g.coins)}
              </Txt>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function Stat({ value, sub, label }: { value: string; sub?: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Txt variant="pixel" color={ink.navy} numberOfLines={1}>
        {value}
      </Txt>
      <Txt variant="meta" muted numberOfLines={1}>
        {sub ? `${label} · ${sub}` : label}
      </Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: ink.wash, borderRadius: radius.lg, padding: 12, gap: 10 },
  totalRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  coin: { width: 32, height: 32, borderRadius: 16, backgroundColor: ink.accent, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
  stats: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, gap: 2, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: ink.card },
  list: { borderRadius: radius.md, backgroundColor: ink.card, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  line: { borderBottomWidth: hairline, borderBottomColor: ink.border },
});
