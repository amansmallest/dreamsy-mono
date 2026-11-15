import { FlatList, Modal, StyleSheet, View } from 'react-native';
import { thumbnailUrlFor, type Game, type GameVersion } from '../api';
import { ink, radius, stroke } from '../theme';
import { Chip, Header, InkButton, Loading, SquareButton, Txt } from '../ui';
import { Thumbnail } from './Thumbnail';

type Props = {
  visible: boolean;
  onClose: () => void;
  game: Game;
  versions: GameVersion[] | null;
  headers: Record<string, string> | undefined;
  /** A generation is running: restore is blocked by the API (409). */
  generating: boolean;
  /** Version currently being restored. */
  busy: number | null;
  onRestore: (version: number) => void;
  onPlay: (version: number) => void;
};

/** Every version as a timeline: play any of them, restore an older one. */
export function VersionsSheet({ visible, onClose, game, versions, headers, generating, busy, onRestore, onPlay }: Props) {
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Header
          title="Versions"
          subtitle={`${game.latestVersion} saved`}
          left={<SquareButton icon="close" label="Close" onPress={onClose} />}
          style={styles.header}
        />
        {generating && (
          <Txt variant="meta" muted center style={styles.note}>
            Restoring is paused while Claude is building.
          </Txt>
        )}
        {versions === null ? (
          <Loading />
        ) : (
          <FlatList
            data={versions}
            keyExtractor={(v) => String(v.version)}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <Txt variant="body" muted center>
                No versions yet.
              </Txt>
            }
            renderItem={({ item, index }) => {
              const current = item.version === game.latestVersion;
              const live = item.version === game.publishedVersion && game.status === 'published';
              return (
                <View style={styles.row}>
                  <View style={styles.rail}>
                    <View style={[styles.dot, current && styles.dotOn]} />
                    {index < versions.length - 1 && <View style={styles.line} />}
                  </View>
                  <View style={styles.card}>
                    <View style={styles.cardTop}>
                      <Thumbnail url={thumbnailUrlFor(game.id, item.version)} headers={headers} seed={`${game.id}@${item.version}`} style={styles.thumb} />
                      <View style={styles.cardMain}>
                        <View style={styles.tags}>
                          <Txt variant="pixel">v{item.version}</Txt>
                          {current && <Chip label="current" />}
                          {live && <Chip label="live" filled />}
                        </View>
                        <Txt variant="meta" muted>
                          {new Date(item.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </Txt>
                      </View>
                    </View>
                    <Txt variant="body" numberOfLines={3}>
                      {item.summary || 'No summary'}
                    </Txt>
                    <View style={styles.actions}>
                      <InkButton label="Play" icon="play" size="sm" variant="outline" onPress={() => onPlay(item.version)} style={styles.flex} />
                      {!current && (
                        <InkButton
                          label="Restore"
                          icon="arrow-undo"
                          size="sm"
                          busy={busy === item.version}
                          disabled={generating || (busy !== null && busy !== item.version)}
                          onPress={() => onRestore(item.version)}
                          style={styles.flex}
                        />
                      )}
                    </View>
                  </View>
                </View>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: ink.bg },
  header: { paddingTop: 16 },
  note: { marginHorizontal: 20 },
  list: { padding: 20, paddingBottom: 48 },
  row: { flexDirection: 'row', gap: 12 },
  rail: { width: 16, alignItems: 'center' },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: stroke.base, borderColor: ink.fg, backgroundColor: ink.card, marginTop: 18 },
  dotOn: { backgroundColor: ink.fg },
  line: { flex: 1, width: 2, backgroundColor: ink.fg, marginVertical: 2 },
  card: { flex: 1, backgroundColor: ink.card, borderWidth: stroke.base, borderColor: ink.fg, borderRadius: radius.lg, padding: 12, gap: 10, marginBottom: 14 },
  cardTop: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  thumb: { width: 72, aspectRatio: 16 / 10, borderRadius: radius.sm, borderWidth: stroke.thin, borderColor: ink.fg },
  cardMain: { flex: 1, gap: 4 },
  tags: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: 8 },
  flex: { flex: 1 },
});
