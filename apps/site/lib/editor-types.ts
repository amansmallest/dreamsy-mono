export interface BuildEvent {
  event: string;
  data: Record<string, unknown>;
  t: number;
}

export interface BuildRecord {
  id: string;
  prompt: string;
  images: number;
  at: number;
  status: "running" | "succeeded" | "failed" | "canceled";
  summary?: string;
  error?: string;
  usd?: number;
  seconds?: number;
  version?: number;
  cloud?: { gameId: string; version: number } | { error: string };
  events: BuildEvent[];
}

export interface VersionInfo {
  version: number;
  label: string;
  at: number;
  buildId?: string;
}

export interface GameFile {
  path: string;
  size: number;
}

export interface GameSummary {
  id: string;
  name: string;
  updated: number;
  builds: number;
  hasThumb: boolean;
  empty: boolean;
}

export interface GameDetail {
  id: string;
  name: string;
  orientation: "portrait" | "landscape";
  files: GameFile[];
  builds: BuildRecord[];
  versions: VersionInfo[];
  hasThumb: boolean;
}

export type Provider = "anthropic" | "openai" | "gemini";

export type KeyStatus = Record<Provider, string | null>;

export type StreamMessage =
  | { type: "event"; buildId: string; event: BuildEvent }
  | { type: "done"; build: BuildRecord }
  | { type: "idle" };
