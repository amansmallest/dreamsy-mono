// engine-web/core/kits.ts uses Vite's `import.meta.glob` (bundled builds); under tsx it falls back
// to reading kit sources from disk. Declare it so this non-Vite program typechecks engine sources.
interface ImportMeta {
  glob(pattern: string, opts?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
