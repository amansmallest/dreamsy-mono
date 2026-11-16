import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  activeGenerationIdFrom,
  api,
  ApiError,
  authHeader,
  isActiveGeneration,
  orientationOf,
  quotaFrom,
  type Game,
  type GameVersion,
  type Generation,
  type LocalImage,
  type Quota,
} from '@/api';
import { CREATE_PRICE, formatCoins, insufficientFrom, OutOfCoinsSheet, useCreatePrice } from '@/coins';
import { BuildTurn } from '@/components/BuildCard';
import { openInvite } from '@/friends';
import { PlayersBadge, RemixBadge } from '@/components/GameCard';
import { GamePreview } from '@/components/GamePreview';
import { PublishSheet } from '@/components/PublishSheet';
import { ShareWithGroupSheet } from '@/components/ShareWithGroupSheet';
import { VersionsSheet } from '@/components/VersionsSheet';
import { useGenerationProgress } from '@/generationProgress';
import { shareGame } from '@/social';
import { errorMessage, floating, font, hairline, ink, radius } from '@/theme';
import { showToast } from '@/toast';
import { Button as InkButton, Card, Chip, Empty, Loading, PixelCoin, Sparkle, Txt } from '@/ui';
import { walletChanged } from '@/wallet';

const MAX_IMAGES = 8; // API limit per generation
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // API upload limit

type Attachment = LocalImage & { key: string; uploadId?: string };

type TimelineItem =
  | { kind: 'generation'; key: string; at: string; generation: Generation }
  | { kind: 'revert'; key: string; at: string; version: GameVersion };

/** One-tap edits: each is a single quick build (~30–60s). */
const QUICK_EDITS: { label: string; prompt: string }[] = [
  { label: 'Harder', prompt: 'Make it harder' },
  { label: 'Faster hero', prompt: 'Make the hero faster' },
  { label: 'New level', prompt: 'Add a new level' },
  { label: 'Boss fight', prompt: 'Add a boss at the end' },
  { label: 'More juice', prompt: 'More juice: particles and screen shake' },
  { label: 'Music + sfx', prompt: 'Add music and sound effects' },
  { label: 'Sunset palette', prompt: 'Sunset color palette' },
  { label: 'Keep building', prompt: 'continue building the next milestones' },
];

/** Starter ideas for an empty game. */
const STARTERS = [
  'A pixel platformer where a cat collects coins',
  'Top-down dungeon crawler with keys and a dragon boss',
  'Cozy farming game on a tiny island',
  'Endless runner through a neon city',
];

/**
 * `dreamsy://game/<id>?room=CODE[&spectate=1]` (the web studio's Join / Spectate QR codes, cold start or
 * while running): straight into the player in that room instead of the workspace. Join goes through the
 * play gate, Spectate is free (src/friends.tsx `openInvite` -> joinRoom / spectateRoom).
 */
export default function GameRoute() {
  const { id, room, spectate } = useLocalSearchParams<{ id: string; room?: string; spectate?: string }>();
  if (typeof room === 'string' && room.trim()) return <RoomHandoff gameId={id} code={room.trim().toUpperCase()} spectate={spectate === '1' || spectate === 'true'} />;
  return <GameWorkspaceScreen />;
}

function RoomHandoff({ gameId, code, spectate }: { gameId: string; code: string; spectate: boolean }) {
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Swap this route for the player: leave it first, then open the room on top of whatever was there.
    if (router.canGoBack()) router.back();
    else router.replace('/');
    const t = setTimeout(() => void openInvite({ gameId, roomCode: code, spectate }), 0);
    return () => clearTimeout(t);
  }, [gameId, code, spectate]);
  return (
    <View style={{ flex: 1, backgroundColor: ink.bg, alignItems: 'center', justifyContent: 'center' }}>
      <Stack.Screen options={{ title: '' }} />
      <Loading />
    </View>
  );
}

/** Create workspace: live preview on top, the conversation with Claude below, composer at the bottom. */
function GameWorkspaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();

  const [game, setGame] = useState<Game | null>(null);
  const [generations, setGenerations] = useState<Generation[] | null>(null);
  const [versions, setVersions] = useState<GameVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState<string | null>(null); // status line while sending
  const [composerError, setComposerError] = useState<string | null>(null);
  const [canceling, setCanceling] = useState(false);

  const [quota, setQuota] = useState<Quota | null>(null);
  const [renaming, setRenaming] = useState(false);

  const [versionsOpen, setVersionsOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [familyOpen, setFamilyOpen] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);

  const [imageHeaders, setImageHeaders] = useState<Record<string, string> | undefined>(undefined);
  const [remixName, setRemixName] = useState<string | null>(null);
  const [toast, setToast] = useState<{ version: number; text: string } | null>(null);
  const createPrice = useCreatePrice();
  const [outOfCoins, setOutOfCoins] = useState<{ balance: number; price: number } | null>(null);

  useEffect(() => {
    void authHeader().then(setImageHeaders, () => {});
  }, []);

  const loadGame = useCallback(async () => {
    const r = await api.game(id);
    // This screen is owner-only; the API returns the full Game to the owner.
    if ('latestVersion' in r.game) setGame(r.game);
    else throw new ApiError(404, 'game not found');
  }, [id]);
  const loadGenerations = useCallback(async () => {
    setGenerations((await api.generations(id)).generations);
  }, [id]);
  const loadVersions = useCallback(async () => {
    setVersions((await api.versions(id)).versions);
  }, [id]);

  const loadQuota = useCallback(async () => {
    // Informational only; never blocks the screen.
    await api.quota().then((r) => setQuota(r.quota), () => {});
  }, []);

  const loadAll = useCallback(async () => {
    void loadQuota();
    try {
      await Promise.all([loadGame(), loadGenerations(), loadVersions()]);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [loadGame, loadGenerations, loadVersions, loadQuota]);

  // Builds can run for an hour: the user leaves and comes back. Re-fetch on focus and on app resume
  // (the progress stream resumes by itself; this catches checkpoints/finish that happened meanwhile).
  useFocusEffect(
    useCallback(() => {
      void loadAll();
    }, [loadAll]),
  );
  useEffect(() => {
    const sub = AppState.addEventListener('change', (st) => st === 'active' && void loadAll());
    return () => sub.remove();
  }, [loadAll]);

  // Owner views may carry remixOf without the source's name.
  const remixOf = game?.remixOf ?? null;
  useEffect(() => {
    if (!remixOf) return setRemixName(null);
    if (remixOf.name) return setRemixName(remixOf.name);
    let cancelled = false;
    api.publicGame(remixOf.gameId).then(
      (r) => !cancelled && setRemixName(r.game.name),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [remixOf]);

  const active = useMemo(
    () => generations?.find((g) => isActiveGeneration(g.status)) ?? null,
    [generations],
  );

  const onFinished = useCallback(
    (g: Generation) => {
      setGenerations((list) => list?.map((x) => (x.id === g.id ? g : x)) ?? list);
      void loadAll();
    },
    [loadAll],
  );
  // A checkpoint is a new playable version while the build keeps going: reload the preview to it.
  const latestRef = useRef(0);
  latestRef.current = game?.latestVersion ?? 0;
  const onCheckpoint = useCallback(
    (version: number) => {
      // The event stream replays history on connect; only versions newer than what we show count.
      if (version <= latestRef.current) return;
      latestRef.current = version;
      setGame((g) => (g && version > g.latestVersion ? { ...g, latestVersion: version } : g));
      setToast({ version, text: `Version ${version} ready — play it while I keep building` });
      void loadVersions().catch(() => {});
    },
    [loadVersions],
  );
  const progress = useGenerationProgress(active, onFinished, onCheckpoint);

  const latestManifest = versions?.find((v) => v.version === game?.latestVersion)?.manifest;
  const orientation = latestManifest === undefined ? undefined : orientationOf(latestManifest);
  const playLatest = (version = game?.latestVersion ?? 0) =>
    router.push({
      pathname: '/play/[id]',
      params: { id, version: String(version), ...(orientation ? { orientation } : {}) },
    });

  // Newest first; the list is inverted so the newest sits right above the composer.
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = (generations ?? []).map((g) => ({
      kind: 'generation',
      key: g.id,
      at: g.createdAt,
      generation: g,
    }));
    for (const v of versions ?? []) {
      if (!v.generationId) items.push({ kind: 'revert', key: `v${v.version}`, at: v.createdAt, version: v });
    }
    return items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [generations, versions]);

  const versionByGeneration = useMemo(() => {
    const m = new Map<string, GameVersion>();
    for (const v of versions ?? []) if (v.generationId) m.set(v.generationId, v);
    return m;
  }, [versions]);

  // ---------- composer ----------

  const pickImages = async () => {
    setComposerError(null);
    const room = MAX_IMAGES - attachments.length;
    if (room <= 0) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      selectionLimit: room,
      quality: 0.8,
    });
    if (res.canceled) return;
    const picked: Attachment[] = [];
    let tooBig = 0;
    for (const a of res.assets.slice(0, room)) {
      if (a.fileSize && a.fileSize > MAX_IMAGE_BYTES) {
        tooBig++;
        continue;
      }
      const ext = (a.fileName ?? a.uri).split('.').pop()?.toLowerCase() ?? 'jpg';
      const mimeType = a.mimeType ?? (ext === 'png' ? 'image/png' : ext === 'heic' ? 'image/heic' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
      picked.push({
        key: `${a.assetId ?? a.uri}-${Date.now()}`,
        uri: a.uri,
        mimeType,
        fileName: a.fileName ?? `reference.${ext}`,
      });
    }
    if (tooBig) setComposerError(`${tooBig === 1 ? 'An image is' : `${tooBig} images are`} over 10 MB and was skipped.`);
    setAttachments((cur) => [...cur, ...picked].slice(0, MAX_IMAGES));
  };

  const send = async (override?: string) => {
    const text = (override ?? prompt).trim();
    if (!text || sending || active) return;
    setComposerError(null);
    try {
      // Upload attachments not uploaded yet (kept on failure so a retry doesn't re-upload).
      const imageIds: string[] = [];
      for (let i = 0; i < attachments.length; i++) {
        const a = attachments[i]!;
        if (a.uploadId) {
          imageIds.push(a.uploadId);
          continue;
        }
        setSending(`Uploading image ${i + 1} of ${attachments.length}…`);
        try {
          const { upload } = await api.upload(a);
          imageIds.push(upload.id);
          setAttachments((cur) => cur.map((x) => (x.key === a.key ? { ...x, uploadId: upload.id } : x)));
        } catch (e) {
          throw new Error(`Couldn't upload an image: ${errorMessage(e)}`);
        }
      }
      setSending('Sending…');
      const { generation, charged } = await api.generate(id, { prompt: text, imageIds });
      setGenerations((list) => [generation, ...(list ?? [])]);
      setPrompt('');
      setAttachments([]);
      void loadQuota();
      if (charged) {
        showToast({ kind: 'charge', title: formatCoins(-charged, true) });
        walletChanged();
      }
    } catch (e) {
      const broke = insufficientFrom(e, createPrice ?? CREATE_PRICE);
      if (broke) {
        setOutOfCoins(broke);
        walletChanged();
      } else if (e instanceof ApiError && e.status === 409) {
        setComposerError('A build is already running. Wait for it or stop it.');
        await attachToActive(activeGenerationIdFrom(e));
      } else if (e instanceof ApiError && e.status === 429) {
        const q = quotaFrom(e);
        if (q) setQuota(q);
        setComposerError(
          q?.resetsAt
            ? `You're out of builds for now. Next build at ${formatTime(q.resetsAt)}.`
            : "You're out of builds for now. Try again later.",
        );
      } else {
        setComposerError(errorMessage(e));
      }
    } finally {
      setSending(null);
    }
  };

  /** Show (and follow) the generation the API says is already running on this game. */
  const attachToActive = async (genId: string | null) => {
    try {
      if (!genId) return await loadGenerations();
      const { generation } = await api.generation(genId);
      setGenerations((list) => [generation, ...(list ?? []).filter((x) => x.id !== generation.id)]);
    } catch {}
  };

  const rename = async (name: string) => {
    const trimmed = name.trim();
    setRenaming(false);
    if (!trimmed || trimmed === game?.name) return;
    try {
      const { game: g } = await api.updateGame(id, { name: trimmed });
      setGame(g);
    } catch (e) {
      Alert.alert("Couldn't rename", errorMessage(e));
    }
  };

  const cancel = async () => {
    if (!active || canceling) return;
    setCanceling(true);
    try {
      const { generation } = await api.cancelGeneration(active.id);
      setGenerations((list) => list?.map((x) => (x.id === generation.id ? generation : x)) ?? list);
      void loadAll();
    } catch (e) {
      Alert.alert("Couldn't cancel", errorMessage(e));
    } finally {
      setCanceling(false);
    }
  };

  // ---------- versions sheet ----------

  const restore = (version: number) => {
    Alert.alert(`Restore version ${version}?`, 'Saved as a new version. Nothing is lost.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Restore',
        onPress: async () => {
          setRestoring(version);
          try {
            await api.revert(id, version);
            await loadAll();
            setVersionsOpen(false);
          } catch (e) {
            const msg =
              e instanceof ApiError && e.status === 409 ? 'Wait for the current build to finish first.' : errorMessage(e);
            Alert.alert("Couldn't restore", msg);
          } finally {
            setRestoring(null);
          }
        },
      },
    ]);
  };

  // ---------- render ----------

  if (!game) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: '' }} />
        {loadError ? (
          <Empty title="Couldn't open" body={loadError} action={<InkButton label="Try again" size="sm" variant="outline" onPress={loadAll} />} />
        ) : (
          <Loading />
        )}
      </View>
    );
  }

  const canSend = !!prompt.trim() && !sending && !active;
  // Only a game's first build costs coins; edits after it are free.
  const firstBuildPrice = createPrice && game.latestVersion === 0 && !active ? createPrice : null;
  const live = game.status === 'published' && game.publishedVersion != null;
  const upToDate = live && game.publishedVersion === game.latestVersion;
  const empty = game.latestVersion === 0 && generations !== null && timeline.length === 0;

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={insets.top + 44}
    >
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable accessibilityRole="button" accessibilityHint="Rename game" onPress={() => setRenaming(true)} hitSlop={8} style={styles.headerTitleRow}>
              <Txt variant="pixel" numberOfLines={1} style={styles.headerTitle}>
                {game.name}
              </Txt>
              <Ionicons name="pencil" size={13} color={ink.muted} />
            </Pressable>
          ),
          headerRight: () => (
            <View style={styles.headerIcons}>
              {game.latestVersion > 0 && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Share with family"
                  onPress={() => setFamilyOpen(true)}
                  hitSlop={8}
                  style={styles.headerIcon}
                >
                  <Ionicons name="people-outline" size={19} color={ink.navy} />
                </Pressable>
              )}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Versions"
                onPress={() => {
                  setVersionsOpen(true);
                  void loadVersions().catch(() => {});
                }}
                hitSlop={8}
                style={styles.headerIcon}
              >
                <Ionicons name="time-outline" size={19} color={ink.navy} />
              </Pressable>
            </View>
          ),
        }}
      />

      <View style={styles.top}>
        {/* Keyed by version: a finished generation or a restore bumps it and reloads the game. */}
        <GamePreview key={`${game.id}@${game.latestVersion}`} gameId={game.id} version={game.latestVersion} />
        {game.latestVersion > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Play full screen"
            onPress={() => playLatest()}
            hitSlop={6}
            style={({ pressed }) => [styles.playPill, { opacity: pressed ? 0.75 : 1 }]}
          >
            <Ionicons name="expand" size={13} color={ink.accentFg} />
            <Txt variant="label" color={ink.accentFg}>
              Play
            </Txt>
          </Pressable>
        )}
        {toast && (
          <Toast
            key={toast.version}
            text={toast.text}
            onPress={() => {
              setToast(null);
              playLatest(toast.version);
            }}
            onDone={() => setToast(null)}
          />
        )}

        {game.latestVersion > 0 && (
          <View style={styles.statusRow}>
            <View style={styles.status}>
              <View style={[styles.statusDot, live && styles.statusDotLive]} />
              <Txt variant="label">{live ? (upToDate ? `Live · v${game.publishedVersion}` : `Live v${game.publishedVersion} · new v${game.latestVersion}`) : `Draft · v${game.latestVersion}`}</Txt>
              <PlayersBadge game={game} tone="sky" />
            </View>
            {upToDate ? (
              <InkButton label="Share" icon="share-outline" size="sm" variant="outline" onPress={() => void shareGame(game)} />
            ) : (
              <InkButton label={live ? 'Update' : 'Publish'} icon="rocket-outline" size="sm" disabled={!!active} onPress={() => setPublishOpen(true)} />
            )}
          </View>
        )}
        {remixOf && (
          <RemixBadge
            name={remixName ?? undefined}
            onPress={() => router.push({ pathname: '/discover/[id]', params: { id: remixOf.gameId } })}
          />
        )}
      </View>

      {empty ? (
        <ScrollView style={styles.flex} contentContainerStyle={styles.starters} keyboardShouldPersistTaps="handled">
          <View style={styles.marks}>
            <Sparkle size={24} />
            <Sparkle size={12} style={{ marginTop: 16 }} />
          </View>
          <Txt variant="title" center>
            What are we making?
          </Txt>
          <Txt variant="body" muted center>
            Describe it in a sentence. Add pictures for the look.
          </Txt>
          {STARTERS.map((s) => (
            <Card key={s} onPress={() => setPrompt(s)} style={styles.starter} accessibilityLabel={s}>
              <Txt variant="body" style={styles.flex}>
                {s}
              </Txt>
              <Ionicons name="arrow-down" size={16} color={ink.accent} />
            </Card>
          ))}
        </ScrollView>
      ) : (
        <FlatList
          style={styles.flex}
          inverted
          data={timeline}
          keyExtractor={(item) => item.key}
          contentContainerStyle={styles.timeline}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          renderItem={({ item }) =>
            item.kind === 'revert' ? (
              <View style={styles.system}>
                <View style={styles.systemLine} />
                <Txt variant="label" muted numberOfLines={1}>
                  {item.version.summary || 'Restored an earlier version'} · v{item.version.version}
                </Txt>
                <View style={styles.systemLine} />
              </View>
            ) : (
              <BuildTurn
                generation={item.generation}
                version={versionByGeneration.get(item.generation.id)}
                progress={active?.id === item.generation.id ? progress : null}
                gameId={game.id}
                imageHeaders={imageHeaders}
                onCancel={cancel}
                canceling={canceling}
                onPlay={(v) => playLatest(v)}
              />
            )
          }
        />
      )}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        {composerError || sending ? (
          <Txt variant="label" color={composerError ? ink.danger : ink.muted} center>
            {composerError ?? sending}
          </Txt>
        ) : firstBuildPrice ? (
          <View style={styles.price}>
            <Txt variant="label" color={ink.navy}>
              Create ·
            </Txt>
            <PixelCoin size={12} color={ink.accent} />
            <Txt variant="label" color={ink.navy}>
              {formatCoins(firstBuildPrice, true)}
            </Txt>
            <Txt variant="label" muted>
              · edits are free
            </Txt>
          </View>
        ) : quota && quota.remaining <= 5 ? (
          <Txt variant="label" muted center>
            {quota.remaining > 0
              ? `${quota.remaining} of ${quota.limit} builds left today`
              : quota.resetsAt
                ? `Out of builds. Next one at ${formatTime(quota.resetsAt)}`
                : 'Out of builds for now'}
          </Txt>
        ) : null}
        {attachments.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
            {attachments.map((a) => (
              <View key={a.key}>
                <Image source={{ uri: a.uri }} style={styles.thumb} />
                {!sending && (
                  <Pressable
                    accessibilityLabel="Remove image"
                    onPress={() => setAttachments((cur) => cur.filter((x) => x.key !== a.key))}
                    style={styles.thumbRemove}
                    hitSlop={6}
                  >
                    <Ionicons name="close" size={12} color={ink.accentFg} />
                  </Pressable>
                )}
              </View>
            ))}
          </ScrollView>
        )}
        {!active && !sending && !prompt && game.latestVersion > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} keyboardShouldPersistTaps="handled">
            {QUICK_EDITS.map((q) => (
              <Chip key={q.label} label={q.label} icon="sparkles-outline" onPress={() => void send(q.prompt)} />
            ))}
          </ScrollView>
        )}
        <View style={styles.inputRow}>
          <Pressable
            accessibilityLabel="Attach reference images"
            onPress={pickImages}
            disabled={!!sending || attachments.length >= MAX_IMAGES}
            hitSlop={6}
            style={[styles.circle, { opacity: sending || attachments.length >= MAX_IMAGES ? 0.4 : 1 }]}
          >
            <Ionicons name="image-outline" size={19} color={ink.navy} />
          </Pressable>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder={active ? 'Next idea' : game.latestVersion ? 'What should change?' : 'Describe your game'}
            placeholderTextColor={ink.muted}
            selectionColor={ink.accent}
            multiline
            maxLength={60000}
            style={styles.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={firstBuildPrice ? `Create, ${formatCoins(firstBuildPrice, true)}` : 'Send'}
            onPress={() => void send()}
            disabled={!canSend}
            style={[styles.circle, styles.send, { opacity: canSend ? 1 : 0.35 }]}
          >
            <Ionicons name="arrow-up" size={20} color={ink.accentFg} />
          </Pressable>
        </View>
      </View>

      <OutOfCoinsSheet state={outOfCoins} what="Creating a game" onClose={() => setOutOfCoins(null)} />

      <RenameDialog visible={renaming} initial={game.name} onDone={rename} />

      <VersionsSheet
        visible={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        game={game}
        versions={versions}
        headers={imageHeaders}
        generating={!!active}
        busy={restoring}
        onRestore={restore}
        onPlay={(v) => {
          setVersionsOpen(false);
          playLatest(v);
        }}
      />
      <ShareWithGroupSheet visible={familyOpen} game={game} onClose={() => setFamilyOpen(false)} />

      <PublishSheet
        visible={publishOpen}
        game={game}
        headers={imageHeaders}
        onClose={() => setPublishOpen(false)}
        onChange={setGame}
      />
    </KeyboardAvoidingView>
  );
}

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${time} tomorrow`;
};

/** Cross-platform text prompt (Alert.prompt is iOS-only). onDone(current text), or onDone('') to cancel. */
function RenameDialog({ visible, initial, onDone }: { visible: boolean; initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  useEffect(() => {
    if (visible) setValue(initial);
  }, [visible, initial]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onDone('')}>
      <View style={styles.backdrop}>
        <Card style={styles.dialog}>
          <Txt variant="pixel">Rename game</Txt>
          <TextInput
            value={value}
            onChangeText={setValue}
            autoFocus
            maxLength={80}
            returnKeyType="done"
            onSubmitEditing={() => onDone(value)}
            selectionColor={ink.accent}
            style={styles.dialogInput}
          />
          <View style={styles.dialogActions}>
            <InkButton label="Cancel" variant="outline" size="md" onPress={() => onDone('')} style={styles.flex} />
            <InkButton label="Save" size="md" disabled={!value.trim()} onPress={() => onDone(value)} style={styles.flex} />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

/** Checkpoint toast over the preview; tap to play that version. Auto-hides. */
function Toast({ text, onPress, onDone }: { text: string; onPress: () => void; onDone: () => void }) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }),
      Animated.delay(5000),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => finished && onDone());
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Animated.View style={[styles.toast, { opacity }]}>
      <Pressable accessibilityRole="button" onPress={onPress} style={styles.toastInner}>
        <Ionicons name="play-circle" size={18} color={ink.accentFg} />
        <Txt variant="meta" color={ink.accentFg} numberOfLines={2} style={styles.flex}>
          {text}
        </Txt>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: ink.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.bg },
  flex: { flex: 1 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: 230 },
  headerTitle: { flexShrink: 1 },
  headerIcons: { flexDirection: 'row', gap: 8 },
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.wash },
  top: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 12, gap: 10, backgroundColor: ink.card, borderBottomWidth: hairline, borderBottomColor: ink.border },
  playPill: {
    position: 'absolute',
    top: 16,
    left: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(13,42,102,0.82)',
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingHorizontal: 4 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: ink.faint },
  statusDotLive: { backgroundColor: ink.ok },
  toast: { position: 'absolute', top: 14, left: 22, right: 22, borderRadius: radius.pill, backgroundColor: ink.navy, ...floating },
  toastInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  starters: { padding: 20, gap: 10, alignItems: 'stretch' },
  marks: { flexDirection: 'row', gap: 4, alignSelf: 'center' },
  starter: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12 },
  timeline: { paddingHorizontal: 12, paddingVertical: 16, gap: 16 },
  system: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  systemLine: { flex: 1, height: hairline, backgroundColor: ink.border },
  price: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  composer: { borderTopWidth: hairline, borderTopColor: ink.border, backgroundColor: ink.card, paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  chips: { gap: 8 },
  thumbs: { gap: 10, paddingTop: 6, paddingRight: 6 },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, borderWidth: hairline, borderColor: ink.border },
  thumbRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: ink.navy,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  circle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: ink.wash, marginBottom: 2 },
  send: { backgroundColor: ink.accent },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 16,
    fontFamily: font.body,
    color: ink.fg,
    backgroundColor: ink.bg,
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(13,42,102,0.35)', justifyContent: 'center', padding: 24 },
  dialog: { padding: 18, gap: 12, borderRadius: radius.xl, ...floating },
  dialogInput: {
    borderRadius: radius.md,
    paddingHorizontal: 14,
    height: 50,
    fontSize: 16,
    fontFamily: font.body,
    color: ink.fg,
    backgroundColor: ink.bg,
  },
  dialogActions: { flexDirection: 'row', gap: 10 },
});
