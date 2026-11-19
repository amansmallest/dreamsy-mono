import type { BuildEvent } from "./editor-types";

export interface Step {
  key: string;
  kind: string;
  label: string;
  text?: string;
  bad?: boolean;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);
const human = (id: string) => id.replace(/[_-]+/g, " ").trim();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function timeline(events: BuildEvent[]) {
  const steps: Step[] = [];
  let working: string | null = null;
  let usd: number | null = null;
  const tail = () => steps[steps.length - 1];
  const sprites = { ids: [] as string[], pending: [] as string[], failed: [] as string[] };
  const ops = { added: 0, changed: 0, removed: 0, scripts: 0 };

  events.forEach((e, i) => {
    const d = e.data;
    const key = String(i);
    if (e.event !== "working" && e.event !== "heartbeat" && e.event !== "cost") working = null;
    switch (e.event) {
      case "route": {
        const k = str(d.kind);
        const label =
          k === "new_game" ? "New game" : k === "feature" ? "New feature" : k === "tweak" ? "Quick tweak" : k === "asset" ? "New art" : k === "reject" ? "Can't build that" : "Planning";
        steps.push({ key, kind: "route", label, text: str(d.reason) || undefined, bad: k === "reject" });
        break;
      }
      case "template":
        steps.push({ key, kind: "template", label: `Started from the ${str(d.kit)} kit` });
        break;
      case "plan":
        steps.push({ key, kind: "plan", label: "Plan", text: str(d.text) });
        break;
      case "note": {
        const t = tail();
        if (t?.kind === "note") t.text = `${t.text}\n\n${str(d.text)}`;
        else steps.push({ key, kind: "note", label: "Notes", text: str(d.text) });
        break;
      }
      case "ops": {
        ops.added += num(d.added);
        ops.changed += num(d.changed);
        ops.removed += num(d.removed);
        ops.scripts += num(d.scripts);
        const parts = [
          ops.added && `+${plural(ops.added, "entity", "entities")}`,
          ops.changed && `${ops.changed} changed`,
          ops.removed && `−${ops.removed} removed`,
          ops.scripts && plural(ops.scripts, "script"),
        ].filter(Boolean);
        const label = parts.length ? parts.join(" · ") : "Editing";
        const t = tail();
        if (t?.kind === "ops") t.label = label;
        else steps.push({ key, kind: "ops", label });
        break;
      }
      case "sprite":
      case "asset.started":
      case "asset.done":
      case "asset.failed": {
        const id = str(d.id);
        if (e.event === "asset.started") sprites.pending.push(id);
        else {
          sprites.pending = sprites.pending.filter((p) => p !== id);
          if (e.event === "asset.failed") sprites.failed.push(id);
          else if (!sprites.ids.includes(id)) sprites.ids.push(id);
        }
        const label = sprites.pending.length ? `Drawing ${human(sprites.pending[0]!)}…` : `Drew ${plural(sprites.ids.length, "sprite")}`;
        const t = tail();
        if (t?.kind === "sprites") t.label = label;
        else steps.push({ key, kind: "sprites", label });
        break;
      }
      case "content": {
        const label = `Building ${plural(num(d.items), human(str(d.kind)) || "item")}`;
        const t = tail();
        if (t?.kind === "content") t.label = label;
        else steps.push({ key, kind: "content", label });
        break;
      }
      case "playtest":
        steps.push({ key, kind: "playtest", label: `Playtested${num(d.seconds) ? ` for ${num(d.seconds)}s` : ""}` });
        break;
      case "validate":
        steps.push({ key, kind: "validate", label: num(d.errors) ? `Found ${plural(num(d.errors), "problem")}, fixing` : "Checked, all good", bad: num(d.errors) > 0 });
        break;
      case "review":
        steps.push({ key, kind: "review", label: "Reviewing the art…" });
        break;
      case "review.done": {
        const label = `Art review: ${num(d.score)}/10${str(d.verdict) === "polish" && num(d.fixes) ? ` · ${plural(num(d.fixes), "fix", "fixes")}` : " · approved"}`;
        const t = [...steps].reverse().find((s) => s.kind === "review");
        if (t) t.label = label;
        else steps.push({ key, kind: "review", label });
        break;
      }
      case "escalate":
        steps.push({ key, kind: "escalate", label: "Trying again with a stronger model" });
        break;
      case "working": {
        const what = str(d.what);
        working = what === "thinking" ? "Thinking…" : what === "writing" ? "Writing…" : what ? `${what[0]!.toUpperCase()}${what.slice(1)}…` : null;
        break;
      }
      case "cloud.saved":
        steps.push({ key, kind: "cloud", label: `Saved to the cloud as version ${num(d.version)}` });
        break;
      case "cloud.failed":
        steps.push({ key, kind: "cloud", label: "Cloud save failed, kept on this computer", text: str(d.error), bad: true });
        break;
      case "cost":
        usd = num(d.usd);
        break;
      case "cost.final":
        usd = num(d.usd);
        break;
    }
  });
  return { steps, working, usd };
}
