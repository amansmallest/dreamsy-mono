// engine-web/core uses Vite's import.meta.glob (kit sources); in Node it falls back to the filesystem.
interface ImportMeta { glob(pattern: string, opts?: unknown): Record<string, unknown> }
