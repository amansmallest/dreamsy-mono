import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { api, thumbnailUrlFor, type Game, type Visibility } from '../api';
import { shareGame } from '../social';
import { errorMessage, ink, radius } from '../theme';
import { Button as InkButton, Field, Header, PixelSky, Sparkle, SquareButton, Txt } from '../ui';
import { Thumbnail } from './Thumbnail';
import { VisibilitySwitch } from './VisibilitySwitch';

type Props = {
  visible: boolean;
  game: Game;
  headers: Record<string, string> | undefined;
  onClose: () => void;
  /** Called with the updated game after a rename/describe or a publish. */
  onChange: (game: Game) => void;
};

/** Publish flow: check the name, description and cover, go live, then share. */
export function PublishSheet({ visible, game, headers, onClose, onChange }: Props) {
  const [name, setName] = useState(game.name);
  const [description, setDescription] = useState(game.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Game | null>(null);
  // §11.8: APIs that send `visibility` get the Public/Private switch; opening the sheet means "go public".
  const hasVisibility = game.visibility !== undefined;
  const [visibility, setVisibility] = useState<Visibility>('public');

  useEffect(() => {
    if (!visible) return;
    setName(game.name);
    setDescription(game.description);
    setError(null);
    setLive(null);
    setVisibility('public');
    // Only when opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const wasLive = game.status === 'published' && game.publishedVersion != null;
  const v = game.latestVersion;

  const publish = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let g = game;
      if (name.trim() !== game.name || description.trim() !== game.description) {
        g = (await api.updateGame(game.id, { name: name.trim(), description: description.trim() })).game;
      }
      if (hasVisibility && visibility === 'private') {
        g = (await api.updateGame(game.id, { visibility: 'private' })).game;
        onChange(g);
        onClose();
        return;
      }
      g = (await api.publish(game.id)).game; // also makes the game public
      onChange(g);
      setLive(g);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <Header
          title={live ? "You're live" : wasLive ? 'Update game' : 'Publish'}
          subtitle={live ? `v${live.publishedVersion}` : `v${v}`}
          left={<SquareButton icon="close" label="Close" onPress={onClose} />}
          style={styles.header}
        />
        {live ? (
          <View style={styles.done}>
            <PixelSky dense style={styles.doneSky} />
            <View style={styles.marks}>
              <Sparkle size={36} />
              <Sparkle size={16} style={{ marginTop: 26 }} />
            </View>
            <Txt variant="display" center>
              {live.name}
            </Txt>
            <Txt variant="body" muted center>
              {wasLive ? 'Players now get the new version.' : "It's in the feed now."}
            </Txt>
            <View style={styles.doneActions}>
              <InkButton label="Share" icon="share-outline" sparkles onPress={() => void shareGame(live)} />
              <InkButton
                label="See game page"
                variant="outline"
                onPress={() => {
                  onClose();
                  router.push({ pathname: '/discover/[id]', params: { id: live.id } });
                }}
              />
            </View>
          </View>
        ) : (
          <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Thumbnail
                url={v > 0 ? (game.thumbnailUrl ?? thumbnailUrlFor(game.id, v)) : null}
                headers={headers}
                seed={game.id}
                name={name}
                size="lg"
                style={styles.cover}
              />
              <Txt variant="meta" muted center>
                Cover comes from the last playtest.
              </Txt>
              <Txt variant="label" muted>
                Name
              </Txt>
              <Field value={name} onChangeText={setName} maxLength={80} placeholder="Game name" />
              <Txt variant="label" muted>
                Description
              </Txt>
              <Field
                value={description}
                onChangeText={setDescription}
                multiline
                maxLength={500}
                placeholder="One or two lines"
              />
              {hasVisibility && <VisibilitySwitch value={visibility} onChange={setVisibility} disabled={busy} style={styles.visibility} />}
              {wasLive && (!hasVisibility || visibility === 'public') && (
                <Txt variant="meta" muted>
                  Live now: v{game.publishedVersion}. Publishing switches players to v{v}.
                </Txt>
              )}
              {error && (
                <Txt variant="meta" color={ink.danger}>
                  {error}
                </Txt>
              )}
            </ScrollView>
            <View style={styles.footer}>
              <InkButton
                label={hasVisibility && visibility === 'private' ? 'Keep private' : wasLive ? `Update to v${v}` : 'Publish'}
                icon="rocket-outline"
                sparkles
                busy={busy}
                disabled={!name.trim() || (v === 0 && !(hasVisibility && visibility === 'private'))}
                onPress={publish}
              />
            </View>
          </KeyboardAvoidingView>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: ink.card },
  header: { paddingTop: 16 },
  flex: { flex: 1 },
  body: { padding: 20, gap: 10 },
  cover: { aspectRatio: 16 / 10, borderRadius: radius.lg },
  footer: { padding: 20, paddingBottom: 36 },
  visibility: { marginTop: 8 },
  done: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  doneSky: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%' },
  marks: { flexDirection: 'row', gap: 6 },
  doneActions: { alignSelf: 'stretch', gap: 12, marginTop: 16 },
});
