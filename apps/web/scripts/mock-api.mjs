// Fake services/api for the screenshot pass (Playwright route interception). Shapes follow services/api.
import { SPRITE_NAMES, spriteSvg, thumbnailSvg } from './mock-art.mjs';

const now = Date.now();
const ago = (min) => new Date(now - min * 60_000).toISOString();
const user = { id: 'u_demo', handle: 'apoorv', bio: 'Making tiny worlds.', createdAt: ago(60 * 24 * 40) };

const gen = (o) => ({
  imageIds: [], selection: [], assetIds: [], attempts: 1, error: null, etaSeconds: null, progress: null, metrics: null,
  startedAt: o.createdAt, finishedAt: null, resultVersion: null, ...o,
});

const SCENE = { g_swords: 'swords', g_slime: 'slime', g_neon: 'neon', g_candy: 'candy', g_farm: 'farm', g_dungeon: 'neon' };

const activeSwords = gen({
  id: 'gen_s5', gameId: 'g_swords', prompt: 'continue — build the next milestones: the Hollow Wood region, the wisp boss and the sword-forging quest',
  baseVersion: 12, status: 'running', createdAt: ago(16), startedAt: ago(15), etaSeconds: 1080, progress: { round: 2, rounds: 5, phase: 'building_the_next_milestones' },
});
const activeSlime = gen({
  id: 'gen_k3', gameId: 'g_slime', prompt: 'Edit sprites slime_green, slime_blue: give them a glossy highlight and a darker outline',
  assetIds: ['slime_green', 'slime_blue'], baseVersion: 4, status: 'running', createdAt: ago(1), startedAt: ago(1),
});

const games = [
  { id: 'g_swords', name: 'Broken Swords', status: 'published', latestVersion: 12, publishedVersion: 11, orientation: 'portrait', activeGeneration: activeSwords, updatedAt: ago(15), stats: { plays: 1843, likes: 212, remixes: 9 } },
  { id: 'g_slime', name: 'Slime Kingdom', status: 'draft', latestVersion: 4, publishedVersion: null, orientation: 'portrait', activeGeneration: activeSlime, updatedAt: ago(1) },
  { id: 'g_neon', name: 'Neon Drift', status: 'published', latestVersion: 7, publishedVersion: 7, orientation: 'landscape', activeGeneration: null, updatedAt: ago(60 * 5) },
  { id: 'g_farm', name: 'Moonlit Farm', status: 'published', latestVersion: 21, publishedVersion: 21, orientation: 'portrait', activeGeneration: null, updatedAt: ago(60 * 26) },
  { id: 'g_candy', name: 'Candy Towers', status: 'draft', latestVersion: 2, publishedVersion: null, orientation: 'landscape', activeGeneration: null, updatedAt: ago(60 * 50) },
  { id: 'g_dungeon', name: 'Untitled dungeon', status: 'draft', latestVersion: 0, publishedVersion: null, orientation: 'portrait',
    activeGeneration: gen({ id: 'gen_d1', gameId: 'g_dungeon', prompt: 'roguelike dungeon crawler', baseVersion: 0, status: 'queued', createdAt: ago(0.5), startedAt: null }), updatedAt: ago(0.5) },
].map((g) => ({
  ownerId: 'u_demo', description: '', publishedAt: g.publishedVersion ? ago(60 * 24 * 3) : null, hidden: false, createdAt: ago(60 * 24 * 9),
  thumbnailUrl: g.latestVersion ? `/v1/games/${g.id}/versions/${g.latestVersion}/thumbnail` : null,
  creator: { id: 'u_demo', handle: 'apoorv' }, stats: { plays: 0, likes: 0, remixes: 0 }, remixOf: null, viewer: { liked: false }, ...g,
}));

const SUMMARIES = ['First playable: overworld, knight, slimes', 'Added the village and three NPCs', 'Combat feel: knockback, hit-stop', 'Dialog trees + shop', 'New region: Mossy Caves',
  'Inventory and potions', 'Boss: the Rust Golem', 'Save system and checkpoints', 'Art pass: palette + outlines', 'Quest log', 'Sword forging mini-game', 'Round 1: Hollow Wood map and wisps'];
const versionsOf = (g) => Array.from({ length: g.latestVersion }, (_, i) => {
  const v = g.latestVersion - i;
  return { gameId: g.id, version: v, sha256: 'x', sizeBytes: 180_000 + v * 41_000, manifest: { style: { preset: 'pixel' } },
    summary: g.id === 'g_swords' ? SUMMARIES[v - 1] : `Version ${v}`, generationId: `gen_${v}`, createdBy: 'u_demo', createdAt: ago(60 * (g.latestVersion - v + 0.3) * 3) };
});

const gensOf = (g) => {
  if (g.id === 'g_swords') return [activeSwords,
    gen({ id: 'gen_s4', gameId: 'g_swords', prompt: 'Edit sprite sword_rusty: make the blade look chipped and rusty, keep the gold hilt', assetIds: ['sword_rusty'], baseVersion: 10, status: 'succeeded', resultVersion: 11, createdAt: ago(200), finishedAt: ago(197), metrics: { artScore: 8.6, costUsd: 0.21, minutes: 3 } }),
    gen({ id: 'gen_s3', gameId: 'g_swords', prompt: 'Add a quest log the player can open from the pause menu', baseVersion: 9, status: 'succeeded', resultVersion: 10, createdAt: ago(400), finishedAt: ago(388), metrics: { artScore: 8.1, costUsd: 0.94, minutes: 12 } }),
    gen({ id: 'gen_s2', gameId: 'g_swords', prompt: 'Make the slimes split into two smaller slimes when hit', baseVersion: 8, status: 'failed', error: 'playtest: slimes fall through the floor after splitting (3 attempts)', createdAt: ago(600), finishedAt: ago(590) }),
  ];
  if (g.id === 'g_slime') return [activeSlime, gen({ id: 'gen_k2', gameId: 'g_slime', prompt: 'A cozy slime-raising game in a pink kingdom', baseVersion: 0, status: 'succeeded', resultVersion: 4, createdAt: ago(300), finishedAt: ago(270), metrics: { artScore: 7.9, costUsd: 2.4, minutes: 30 } })];
  return g.activeGeneration ? [g.activeGeneration] : [];
};

let eid = 0;
const ev = (type, data = {}) => ({ id: String(++eid), type, data });
const EVENTS = {
  gen_s5: [
    ev('queued'), ev('started', { attempt: 1 }),
    ev('eta', { etaSeconds: 2400, round: 1, rounds: 5, phase: 'planning and building' }),
    ev('memory', { hits: 7, lessonsUsed: ['rpg dialog pacing', 'slime hitboxes', 'forest palettes'] }),
    ev('route', { kind: 'feature', reason: 'multi-region content milestone' }),
    ev('plan', { text: 'Round plan: extend the world graph with the Hollow Wood (3 maps, 2 warps), add the Wisp enemy family and a boss, then the forging quest that gates the Old Bridge.\nI\'ll write data/design/hollow_wood.json first, then fan out content builders for creatures and items.' }),
    ev('content', { kind: 'creature', items: 8, workers: 2, done: 0 }), ev('content', { kind: 'creature', items: 8, workers: 2, done: 8 }),
    ev('ops', { reason: 'Hollow Wood maps + warps', added: 46, changed: 12, removed: 2, files: 9, scripts: 3 }),
    ev('sprite', { id: 'ghost_wisp' }), ev('sprite', { id: 'bat_cave' }), ev('sprite', { id: 'tree_oak' }), ev('sprite', { id: 'key_brass' }),
    ev('playtest', { seconds: 45, shots: 3 }), ev('validate', { errors: 0 }),
    ev('review', { phase: 'art director' }), ev('review.done', { score: 8.4, verdict: 'approve', fixes: 0 }),
    ev('checkpoint', { version: 12, summary: 'Round 1: Hollow Wood map and wisps' }),
    ev('eta', { etaSeconds: 1080, round: 2, rounds: 5, phase: 'building the next milestones' }),
    ev('plan', { text: 'Round 2: the Wisp Queen boss arena and the forging quest chain.' }),
    ev('ops', { reason: 'boss arena scene', added: 18, changed: 4, removed: 0, files: 3, scripts: 2 }),
    ev('asset.started', { id: 'boss_wisp_queen', prompt: 'a towering ghostly queen made of blue flame' }),
    ev('working', { what: 'drawing sprites', turn: 6 }),
  ],
  gen_k3: [ev('queued'), ev('started', { attempt: 1 }), ev('route', { kind: 'asset' }), ev('working', { what: 'redrawing slime_green', turn: 1 })],
  gen_s4: [ev('queued'), ev('started'), ev('route', { kind: 'asset' }), ev('sprite', { id: 'sword_rusty' }), ev('validate', { errors: 0 }), ev('review.done', { score: 8.6, verdict: 'approve', fixes: 0 }), ev('metrics', { artScore: 8.6, costUsd: 0.21, minutes: 3 }), ev('succeeded', { version: 11 })],
  gen_s3: [ev('queued'), ev('started'), ev('memory', { hits: 3 }), ev('route', { kind: 'feature' }), ev('plan', { text: 'Add a QuestLog UI panel bound to the rpg kit quest state.' }), ev('ops', { added: 9, changed: 3, scripts: 2, reason: 'quest log panel' }), ev('playtest', { seconds: 20, shots: 2 }), ev('validate', { errors: 0 }), ev('metrics', { artScore: 8.1, costUsd: 0.94, minutes: 12 }), ev('succeeded', { version: 10 })],
  gen_s2: [ev('queued'), ev('started'), ev('route', { kind: 'tweak' }), ev('ops', { changed: 4, scripts: 1 }), ev('playtest', { seconds: 15, shots: 2 }), ev('validate', { errors: 2 }), ev('failed', { error: 'playtest: slimes fall through the floor after splitting (3 attempts)' })],
};

const ASSET_PROMPTS = {
  hero_knight: 'a small knight in steel armor with a blue tabard, cyan visor glow, 16px pixel art, side view',
  slime_green: 'a friendly green slime with big eyes and a little blush, bouncy',
  sword_rusty: 'a chipped, rusty short sword with a gold hilt',
  ghost_wisp: 'a pale floating wisp ghost with tiny pink cheeks',
};
const assetsOf = (g, v) => SPRITE_NAMES.map((id) => ({
  id, kind: 'image', file: `assets/${id}.svg`, url: `/v1/games/${g}/versions/${v}/files/${id}.svg`,
  prompt: ASSET_PROMPTS[id] ?? `${id.replace(/_/g, ' ')}, pixel art, game palette`, model: id.includes('tile') || id.includes('wall') || id.includes('path') ? 'draw_sprite' : 'gemini-image', sizeBytes: 900 + id.length * 97,
}));

function insights(scale, seed) {
  const days = 30;
  const daily = Array.from({ length: days }, (_, i) => {
    const t = i / (days - 1);
    const wob = Math.sin(i * 1.7 + seed) * 0.35;
    const builds = Math.round((scale ? 40 + 50 * t : 2 + 4 * t) + Math.sin(i + seed) * (scale ? 6 : 1.5));
    const rate = 0.68 + 0.22 * t + Math.sin(i * 2.1 + seed) * 0.04;
    return {
      date: new Date(now - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
      builds, succeeded: Math.round(builds * rate), failed: builds - Math.round(builds * rate),
      avgArtScore: +(6.4 + 1.9 * t + wob).toFixed(2), avgCostUsd: +(1.9 - 0.8 * t + wob * 0.2).toFixed(2), avgMinutes: +(24 - 7 * t + wob * 3).toFixed(1),
      avgMemoryHits: +(0.5 + 6.5 * t + wob).toFixed(2), spritesReusedPct: +(8 + 34 * t + wob * 4).toFixed(1),
    };
  });
  if (!scale) for (const d of daily) if ((d.date.charCodeAt(9) + seed) % 4 === 0) Object.assign(d, { builds: 0, succeeded: 0, failed: 0, avgArtScore: null });
  return {
    daily,
    byKit: [{ kit: 'rpg', builds: 412, avgArtScore: 8.1, avgCostUsd: 1.4 }, { kit: 'platformer', builds: 318, avgArtScore: 7.8, avgCostUsd: 1.1 }, { kit: 'topdown', builds: 207, avgArtScore: 7.6, avgCostUsd: 1.3 },
      { kit: 'tower-defense', builds: 141, avgArtScore: 7.9, avgCostUsd: 0.9 }, { kit: 'tycoon', builds: 96, avgArtScore: 7.2, avgCostUsd: 0.7 }],
    totals: scale ? { builds: 1874, succeeded: 1503, avgArtScore: 7.6, avgCostUsd: 1.42, memoryItems: 3290 } : { builds: 94, succeeded: 81, avgArtScore: 8.0, avgCostUsd: 1.18 },
  };
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const svg = (body) => ({ status: 200, contentType: 'image/svg+xml', body });

export function handle(method, url, headers) {
  const u = new URL(url);
  const p = u.pathname;
  let m;
  if (p === '/v1/auth/guest') return json({ user, token: 'tok_demo' }, 201);
  if (p === '/v1/me' && method === 'PATCH') return json({ user });
  if (p === '/v1/me') return json({ user });
  if (p === '/v1/me/quota') return json({ quota: { limit: 10, used: 3, remaining: 7, resetsAt: null } });
  if (p === '/v1/me/wallet') return json({ wallet: { balance: 1250, currency: 'stars' }, recent: [
    { delta: 150, balanceAfter: 1250, kind: 'sale', gameId: 'g_swords', itemId: 'vip_pass', createdAt: ago(90) },
    { delta: 150, balanceAfter: 1100, kind: 'sale', gameId: 'g_swords', itemId: 'vip_pass', createdAt: ago(60 * 7) },
    { delta: -50, balanceAfter: 950, kind: 'purchase', gameId: 'g_neon', itemId: 'turbo_skin', createdAt: ago(60 * 30) },
    { delta: 1000, balanceAfter: 1000, kind: 'starter_grant', gameId: null, itemId: null, createdAt: ago(60 * 24 * 40) },
  ] });
  if (p === '/v1/me/games') return json({ games });
  if (p === '/v1/me/insights') return json(insights(false, 2));
  if (p === '/v1/insights/engine') return json(insights(true, 0));
  if (p === '/v1/me/activity') {
    const items = games.flatMap((g) => gensOf(g).map((x) => ({ generation: x, game: { id: g.id, name: g.name, thumbnailUrl: g.thumbnailUrl } })))
      .sort((a, b) => b.generation.createdAt.localeCompare(a.generation.createdAt));
    return json({ items, next: null });
  }
  if ((m = p.match(/^\/v1\/games\/([^/]+)\/versions\/(\d+)\/thumbnail$/))) {
    const g = games.find((x) => x.id === m[1]);
    return svg(thumbnailSvg(SCENE[m[1]], Number(m[2]), g?.orientation === 'landscape'));
  }
  if ((m = p.match(/^\/v1\/games\/([^/]+)\/versions\/(\d+)\/files\/(\w+)\.svg$/))) return svg(spriteSvg(m[3]));
  if ((m = p.match(/^\/v1\/games\/([^/]+)\/versions\/(\d+)\/assets$/))) return json({ assets: assetsOf(m[1], Number(m[2])) });
  if ((m = p.match(/^\/v1\/games\/([^/]+)\/versions$/))) return json({ versions: versionsOf(games.find((g) => g.id === m[1])) });
  if ((m = p.match(/^\/v1\/games\/([^/]+)\/generations$/))) return json({ generations: gensOf(games.find((g) => g.id === m[1])) });
  if ((m = p.match(/^\/v1\/games\/([^/]+)$/))) return json({ game: games.find((g) => g.id === m[1]) });
  if ((m = p.match(/^\/v1\/generations\/([^/]+)\/events$/))) {
    const after = Number(headers['last-event-id'] ?? 0);
    const body = (EVENTS[m[1]] ?? []).filter((e) => Number(e.id) > after).map((e) => `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
    return { status: 200, contentType: 'text/event-stream', body };
  }
  if ((m = p.match(/^\/v1\/generations\/([^/]+)$/))) {
    const all = games.flatMap(gensOf);
    return json({ generation: all.find((x) => x.id === m[1]) });
  }
  return json({ error: `mock: no route for ${method} ${p}` }, 404);
}
