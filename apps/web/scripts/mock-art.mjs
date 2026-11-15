// Pixel-art SVGs for the screenshot mocks (sprites + composed thumbnails). Not shipped in the app.
export const PAL = {
  k: '#1a1c2c', p: '#5d275d', r: '#b13e53', o: '#ef7d57', y: '#ffcd75', l: '#a7f070', g: '#38b764', t: '#257179',
  b: '#29366f', B: '#3b5dc9', c: '#41a6f6', C: '#73eff7', w: '#f4f4f4', s: '#94b0c2', S: '#566c86', d: '#333c57',
  m: '#f2a7c3', M: '#d36b9b', n: '#8b5a2b', N: '#c08552', v: '#7b4fd6', V: '#b893ff',
};

const MAPS = {
  hero_knight: `
....kkkk....
...kssssk...
..ksswsssk..
..kssSSSsk..
..kSkCkCSk..
..kSSSSSSk..
...kSSSSk...
..kBBBBBBk..
.kyBBcBBByk.
kskkBBBBkksk
kswkBBBBkwsk
.kk.BBBB.kk.
...kbbbbk...
...kbk.kbk..
...kbk.kbk..
..kkdk.kdkk.
..kkkk.kkkk.`,
  slime_green: `
.....kkk.....
....klllk....
...klllllk...
..kllwlllgk..
..klwwllllgk.
.kllkllkllgk.
.kllkllkllggk
.klllrrlllggk
kgllllllllgggk
kggggggggggggk
.kkkkkkkkkkkk.`,
  slime_blue: `
.....kkk.....
....kCCCk....
...kCCCCCk...
..kCCwCCCck..
..kCwwCCCCck.
.kCCkCCkCCck.
.kCCkCCkCCcck
.kCCCrrCCCcck
kcCCCCCCCCccck
kcccccccccccck
.kkkkkkkkkkkk.`,
  heart_full: `
.kk...kk.
krrk.krrk
krwrkrrrk
krrrrrrrk
.krrrrrk.
..krrrk..
...krk...
....k....`,
  coin_gold: `
..kkkk..
.kyyyyk.
kyywyyok
kyywyyok
kyyyyyok
kyyyyyok
.koyyok.
..kkkk..`,
  chest_wood: `
.kkkkkkkkkk.
knNNNNNNNNnk
kNNNNNNNNNNk
kkkkkyykkkkk
knnnnykynnnk
knnnnyyynnnk
knnnnnnnnnnk
kkkkkkkkkkkk`,
  sword_rusty: `
.........kk
........kwk
.......kwsk
......kwsk.
.....kwsk..
.kk.kwsk...
.kykwsk....
..kysk.....
.kykyk.....
kyk.kk.....
kk.........`,
  tree_oak: `
....kkkk....
..kkggggkk..
.kgglggggk..
kgglllgggggk
kggllgggggtk
kgggggggtggk
.kgggggttgk.
..kkgtggkk..
....knnk....
....knnk....
...knnnnk...`,
  ghost_wisp: `
...kkkkk...
..kwwwwwk..
.kwwwwwwwk.
.kwkwwwkwk.
.kwkwwwkwk.
.kwwwwwwwk.
.kwwmwmwwk.
.kwwwwwwwk.
.kwkwkwkwk.
.kk.k.k.kk.`,
  bat_cave: `
k.........k
kk..k.k..kk
kvk.kkk.kvk
kvvkVkVkvvk
.kvkwkwkvk.
..kvvvvvk..
...kvkvk...
....k.k....`,
  npc_wizard: `
.....kk.....
....kVVk....
...kVVVVk...
..kVVyVVVk..
.kkkkkkkkkk.
...kNNNNk...
...kNkNkk...
...kwwwwk...
..kvwwwwvk..
.kvvvwwvvvk.
.kvvvvvvvvk.
..kvvvvvvk..
...kk..kk...`,
  icon_star: `
....k....
...kyk...
kkkkyykkk
kyyyyyyyk
.kyyyyyk.
..kyyyk..
.kyykyyk.
kyk...kyk
kk.....kk`,
  potion_red: `
...kk...
...kk...
..kwwk..
.krrrrk.
krwrrrrk
krrrrrrk
krrrrrrk
.kkkkkk.`,
  key_brass: `
.kkk......
kyyyk.....
kykyk.....
kyyykkkkkk
.kkkyyyyyk
....kykkyk
....kk.kk.`,
};

const rowsOf = (map) => map.trim().split('\n');

export function spriteGroup(name, scale = 1, dx = 0, dy = 0) {
  const rows = rowsOf(MAPS[name]);
  let out = `<g transform="translate(${dx} ${dy}) scale(${scale})" shape-rendering="crispEdges">`;
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== '.' && PAL[ch]) out += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${PAL[ch]}"/>`;
  }));
  return `${out}</g>`;
}

export function spriteSvg(name) {
  if (MAPS[name]) {
    const rows = rowsOf(MAPS[name]);
    const w = Math.max(...rows.map((r) => r.length));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${rows.length}" width="${w * 8}" height="${rows.length * 8}">${spriteGroup(name)}</svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="128" height="128" shape-rendering="crispEdges">${tile(name)}</svg>`;
}

function rng(seed) {
  let s = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 16×16 procedural tiles. */
export function tile(name, dx = 0, dy = 0) {
  const r = rng(name + dx + dy);
  let o = `<g transform="translate(${dx} ${dy})" shape-rendering="crispEdges">`;
  const px = (x, y, c) => { o += `<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${c}"/>`; };
  if (name.includes('grass')) {
    o += `<rect width="16" height="16" fill="${PAL.g}"/>`;
    for (let i = 0; i < 22; i++) px(Math.floor(r() * 16), Math.floor(r() * 16), r() > 0.5 ? PAL.l : PAL.t);
  } else if (name.includes('water')) {
    o += `<rect width="16" height="16" fill="${PAL.B}"/>`;
    for (let y = 2; y < 16; y += 5) for (let x = 0; x < 16; x++) if ((x + y) % 6 < 3) px(x, y + (x % 6 < 3 ? 0 : 1), PAL.c);
    px(3, 9, PAL.C); px(11, 4, PAL.C);
  } else if (name.includes('wall') || name.includes('stone')) {
    o += `<rect width="16" height="16" fill="${PAL.S}"/>`;
    for (let y = 0; y < 16; y += 4) { for (let x = 0; x < 16; x++) px(x, y, PAL.d); for (let x = (y / 4) % 2 ? 4 : 0; x < 16; x += 8) for (let k = 0; k < 4; k++) px(x, y + k, PAL.d); }
    for (let i = 0; i < 8; i++) px(Math.floor(r() * 16), Math.floor(r() * 16), PAL.s);
  } else if (name.includes('dirt') || name.includes('path')) {
    o += `<rect width="16" height="16" fill="${PAL.N}"/>`;
    for (let i = 0; i < 18; i++) px(Math.floor(r() * 16), Math.floor(r() * 16), r() > 0.5 ? PAL.n : PAL.y);
  } else if (name.includes('button')) {
    o += `<rect x="0" y="3" width="16" height="10" rx="0" fill="${PAL.k}"/><rect x="1" y="4" width="14" height="7" fill="${PAL.r}"/><rect x="1" y="4" width="14" height="2" fill="${PAL.o}"/>`;
  } else {
    o += `<rect width="16" height="16" fill="${PAL.v}"/>`;
  }
  return `${o}</g>`;
}

const SCENES = {
  swords: { sky: ['#29366f', '#3b5dc9'], ground: 'grass', props: ['tree_oak', 'hero_knight', 'slime_green', 'coin_gold', 'ghost_wisp'] },
  slime: { sky: ['#5d275d', '#b13e53'], ground: 'dirt', props: ['slime_blue', 'slime_green', 'chest_wood', 'potion_red', 'bat_cave'] },
  neon: { sky: ['#1a1c2c', '#5d275d'], ground: 'wall', props: ['bat_cave', 'icon_star', 'ghost_wisp', 'key_brass', 'coin_gold'] },
  candy: { sky: ['#d36b9b', '#f2a7c3'], ground: 'dirt', props: ['icon_star', 'potion_red', 'heart_full', 'coin_gold', 'npc_wizard'] },
  farm: { sky: ['#257179', '#73eff7'], ground: 'grass', props: ['tree_oak', 'npc_wizard', 'chest_wood', 'tree_oak', 'coin_gold'] },
};

/** A composed "screenshot" of a game, portrait 360×560 or landscape 640×400. */
export function thumbnailSvg(scene = 'swords', version = 1, landscape = false) {
  const s = SCENES[scene] ?? SCENES.swords;
  const W = landscape ? 160 : 90;
  const H = landscape ? 100 : 140;
  const r = rng(scene + version);
  let o = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 4}" height="${H * 4}" shape-rendering="crispEdges">`;
  o += `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${s.sky[0]}"/><stop offset="1" stop-color="${s.sky[1]}"/></linearGradient></defs>`;
  o += `<rect width="${W}" height="${H}" fill="url(#sky)"/>`;
  for (let i = 0; i < 14; i++) o += `<rect x="${Math.floor(r() * W)}" y="${Math.floor(r() * H * 0.45)}" width="1" height="1" fill="#f4f4f4" opacity="${0.4 + r() * 0.6}"/>`;
  const groundY = Math.floor(H * 0.62);
  for (let x = 0; x < W; x += 16) for (let y = groundY; y < H; y += 16) o += tile(y === groundY ? s.ground : s.ground === 'grass' ? 'dirt' : 'stone_wall', x, y);
  if (!landscape) for (let x = 0; x < W; x += 16) o += tile('water', x, H - 16);
  const slots = landscape ? [[8, -11, 2], [46, -17, 1.5], [82, -11, 1.4], [116, -26, 1], [134, -14, 1]] : [[2, -11, 1.6], [34, -17, 1.6], [62, -11, 1.4], [20, -40, 1], [66, -46, 1]];
  s.props.forEach((p, i) => {
    const [x, dy, sc] = slots[i];
    o += spriteGroup(p, sc, x, groundY + dy * sc + (i >= 3 ? -10 : 0));
  });
  for (let i = 0; i < 3; i++) o += spriteGroup('heart_full', 0.7, 4 + i * 7.5, 4);
  o += spriteGroup('coin_gold', 0.8, W - 22, 4);
  o += `<rect x="${W - 14}" y="5" width="11" height="5" fill="#1a1c2c" opacity="0.6"/>`;
  return `${o}</svg>`;
}

export const SPRITE_NAMES = [...Object.keys(MAPS), 'grass_tile', 'water_tile', 'stone_wall', 'dirt_path', 'ui_button_play'];
