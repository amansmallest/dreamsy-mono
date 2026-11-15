export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function duration(from: string | null | undefined, to?: string | null): string {
  if (!from) return '';
  const s = Math.max(0, ((to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime()) / 1000);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const humanId = (id: string) => id.replace(/[_-]+/g, ' ').trim();

export type AssetCategory = 'characters' | 'tiles' | 'ui' | 'other';
const CHAR = /(player|hero|enemy|npc|char|slime|boss|knight|wizard|mage|monster|creature|mob|villager|king|queen|cat|dog|bird|fish|ghost|zombie|robot|goblin|orc|dragon|bat|frog|avatar|sprite_?man|girl|boy|pet|bunny|fox|bee)/;
const TILE = /(tile|ground|wall|grass|floor|water|bg|background|terrain|platform|block|brick|dirt|sand|stone|rock|tree|bush|cloud|sky|lava|ice|road|path|fence|door|bridge|plant|flower|mountain|parallax)/;
const UI = /(ui|button|btn|icon|heart|hud|panel|logo|font|cursor|arrow|frame|bar|badge|title|menu|coin_icon|star_icon|dialog|portrait)/;

export function assetCategory(id: string): AssetCategory {
  const s = id.toLowerCase();
  if (UI.test(s)) return 'ui';
  if (CHAR.test(s)) return 'characters';
  if (TILE.test(s)) return 'tiles';
  return 'other';
}

/** Leaderboard value: asc boards are times (mm:ss.cc, h:mm:ss.cc past an hour), desc boards are scores. */
export function boardValue(value: number, order: 'asc' | 'desc'): string {
  if (order === 'desc') return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const cs = Math.round(value * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${h ? `${h}:` : ''}${p2(m)}:${p2(s)}.${p2(c)}`;
}

export const inviteLink = (code: string) => `https://dreamsy.dev/join/${code}`;
