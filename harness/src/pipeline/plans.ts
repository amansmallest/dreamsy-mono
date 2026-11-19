import { MODELS, type ModelId } from "../llm/models.js";
import type { Route } from "./route.js";

export interface Plan {
  model: ModelId;
  effort: "low" | "medium" | "high";
  maxTurns: number;
  maxUsd: number;
  escalate: { model: ModelId; effort: "low" | "medium" | "high"; maxTurns: number; maxUsd: number } | null;
}

export const PLANS: Record<Exclude<Route["kind"], "reject">, Plan> = {
  new_game: { model: MODELS.opus, effort: "high", maxTurns: 60, maxUsd: 20, escalate: null },
  feature: { model: MODELS.opus, effort: "medium", maxTurns: 40, maxUsd: 20, escalate: { model: MODELS.opus, effort: "high", maxTurns: 30, maxUsd: 20 } },
  tweak: { model: MODELS.sonnet, effort: "low", maxTurns: 8, maxUsd: 0.3, escalate: { model: MODELS.opus, effort: "medium", maxTurns: 15, maxUsd: 1.5 } },
  asset: { model: MODELS.sonnet, effort: "medium", maxTurns: 20, maxUsd: 1.5, escalate: { model: MODELS.opus, effort: "medium", maxTurns: 25, maxUsd: 3 } },
};
