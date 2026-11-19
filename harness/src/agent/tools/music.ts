import { z } from "zod";
import { musicPath, parseMusic } from "@dreamsy/format";
import { MODELS } from "../../llm/models.js";
import { defineTool } from "./tool.js";

const ROLES = ["title", "overworld", "level", "town", "cave", "battle", "boss", "shop", "victory", "gameover", "credits", "other"] as const;

const Song = z.object({
  id: z.string(),
  bpm: z.number(),
  steps: z.number(),
  loop: z.boolean(),
  order: z.array(z.number()),
  channels: z.array(
    z.object({
      wave: z.enum(["square", "saw", "triangle", "sine", "noise"]),
      volume: z.number(),
      duty: z.number(),
      notes: z.string(),
    }),
  ),
});
const Composition = z.object({ tracks: z.array(Song) });

export const COMPOSER_GUIDE = `You are the composer for a small 2D game, writing chiptune music for a 4-channel tracker (like the NES/Game Boy).
Write ORIGINAL melodies in the spirit of classic game soundtracks (Undertale, Pokémon, Mega Man, Zelda, Kirby, Celeste): catchy,
hummable leads, clear chord movement, a bass that walks, and drums with a groove. Never copy existing songs.

Format of one song:
- bpm 40..240. One step = a 16th note. steps = steps per pattern (16 = one 4/4 bar, 32 = two bars, 64 = four bars).
- 1..4 channels: { wave: square|triangle|saw|sine|noise, volume 0..1, duty 0.05..0.95 (squares only), notes }.
- notes is ONE whitespace-separated string of tokens: a note "C4", "F#3", "Bb5" (C0..B8), "-" holds the previous note one
  more step, "." is silence. Noise channels: the note is brightness (C2..E2 = kick, C5..C7 = hat/snare).
- Every channel's notes has exactly steps × P tokens (P = number of patterns; the same P for every channel).
  Pattern i is tokens i*steps .. i*steps+steps-1. order lists pattern indices to play, e.g. [0,0,1,0,2,1]; loop true/false.

How to make it sound like a real game soundtrack:
- Channel roles: ch1 lead square (duty 0.25 or 0.125, volume 0.3), ch2 harmony/arpeggio square (duty 0.5, volume 0.2),
  ch3 bass triangle (volume 0.45), ch4 drums noise (volume 0.1-0.15). Use all four for loops; jingles may use fewer.
- Write 2-4 different patterns (A, B, sometimes a bridge) and an order that repeats and returns, e.g. [0,1,0,2]. Never a
  single repeated bar. Use steps 32 or 64 so phrases breathe.
- Melody: phrases of 2 or 4 bars, question/answer, a memorable rhythmic hook, mostly stepwise motion with a few leaps,
  rests between phrases, holds ("-") on long notes. Keep the lead in octaves 4-5, bass in 2-3.
- Harmony: pick a key and a progression (I–V–vi–IV, i–VI–III–VII, ii–V–I…). Fast arpeggios on ch2 (16ths through the chord)
  give the classic chiptune shimmer. The bass plays roots and fifths, octave jumps on upbeats.
- Fit the role and the game's world:
  title 100-120 bpm, inviting · overworld/level 110-140 bpm, bright and adventurous · town 90-110, warm · cave 80-100, sparse,
  minor · battle 150-180, driving, minor · boss 160-200, intense, chromatic bass · shop 100-120, playful · victory a short
  jingle (loop false, 1-2 patterns of 16-32 steps, rising) · gameover a slow descending jingle (loop false) · credits gentle.
- Match the setting: cozy/forest → major, triangle-heavy; space/neon → saw or thin squares, fast arps; spooky → minor,
  chromatic, sparse drums; ocean → slower, sine/triangle.
Return every requested track. Keep each track's id exactly as given.`;

export const composeMusic = defineTool({
  name: "compose_music",
  label: "composing music",
  description:
    "Compose (or rework) chiptune music tracks with a dedicated composer model and save them as data/music/<id>.json. Give the game's setting and one entry per track with its role (title, level, battle, boss, victory, gameover…). For a new game ask for 3-5 tracks (e.g. title, main level, boss or battle, victory jingle, game over jingle) so the game doesn't have just one song. To change existing music, pass the same ids with what to change; the composer gets the current songs. Afterwards play them with music.play(id) at the right places in scripts.",
  strict: true,
  input: z.object({
    setting: z.string().max(600).describe("The game's world, mood and genre in a sentence or two, e.g. 'cozy forest platformer about a frog, bright and bouncy'."),
    tracks: z
      .array(
        z.object({
          id: z.string().describe("lowercase_snake song id, e.g. title_theme, forest_level, boss_battle."),
          role: z.enum(ROLES),
          brief: z.string().max(400).describe("What this track should feel like, or what to change about the existing one."),
        }),
      )
      .min(1)
      .max(8),
  }),
  enabled: (ctx) => !!ctx.critic,
  async run(d, { ws, critic, cost, emit, signal }) {
    const bad = d.tracks.find((t) => !/^[a-z][a-z0-9_]{0,40}$/.test(t.id));
    if (bad) return { text: `Invalid song id "${bad.id}": use lowercase_snake.`, isError: true };
    const existing = d.tracks
      .map((t) => ({ id: t.id, text: ws.pkg.text(musicPath(t.id)) }))
      .filter((t): t is { id: string; text: string } => !!t.text);
    const request = [
      `Game: ${d.setting}`,
      "",
      "Tracks to write:",
      ...d.tracks.map((t) => `- ${t.id} (${t.role}): ${t.brief}`),
      ...(existing.length ? ["", "Current versions to rework (keep what works, change what was asked):", ...existing.map((e) => `## ${e.id}\n${e.text}`)] : []),
    ].join("\n");

    let feedback = "";
    const saved: string[] = [];
    const problems: string[] = [];
    for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
      const todo = d.tracks.filter((t) => !saved.includes(t.id));
      if (!todo.length) break;
      let out: z.infer<typeof Composition>;
      try {
        const r = await critic!.json({
          model: MODELS.haiku,
          system: COMPOSER_GUIDE,
          content: [{ type: "text", text: feedback ? `${request}\n\nYour previous attempt had problems; fix them and return only these tracks: ${todo.map((t) => t.id).join(", ")}\n${feedback}` : request }],
          schema: Composition,
          effort: "low",
          maxTokens: 16000,
        });
        cost.add(r.model, r.usage);
        out = r.value;
      } catch (e) {
        problems.push(`composer error: ${(e as Error).message}`);
        break;
      }
      const errors: string[] = [];
      const ops: { op: "write_file"; path: string; content: string }[] = [];
      for (const t of todo) {
        const song = out.tracks.find((s) => s.id === t.id);
        if (!song) {
          errors.push(`${t.id}: missing`);
          continue;
        }
        const { id: _id, ...body } = song;
        const clean = { ...body, ...(body.order.length ? {} : { order: undefined }), channels: body.channels.map((c) => (c.wave === "square" ? c : { wave: c.wave, volume: c.volume, notes: c.notes })) };
        const text = `${JSON.stringify(clean, null, 2)}\n`;
        const parsed = parseMusic(text);
        if (parsed.errors.length) {
          errors.push(`${t.id}: ${parsed.errors.slice(0, 4).join("; ")}`);
          continue;
        }
        ops.push({ op: "write_file", path: musicPath(t.id), content: text });
      }
      if (ops.length) {
        const r = ws.applyOps(ops, "compose music");
        if (r.applied) saved.push(...ops.map((o) => o.path.slice("data/music/".length, -".json".length)));
        else errors.push(r.text.slice(0, 400));
      }
      feedback = errors.join("\n");
      if (!errors.length) break;
      if (attempt === 1) problems.push(...errors);
    }
    if (saved.length) await emit("music", { ids: saved });
    if (!saved.length) return { text: `No music saved. ${problems.join(" ") || "The composer returned nothing usable."}`, isError: true };
    return {
      text: `Saved ${saved.length} track${saved.length === 1 ? "" : "s"}: ${saved.map((s) => musicPath(s)).join(", ")}.${problems.length ? ` Not saved: ${problems.join(" ")}` : ""} Play them with music.play("<id>") (title on the title scene, level tracks at the top of each level script, victory/gameover when those happen).`,
    };
  },
});
