# dreamsy-engine

The game player is implemented as a plain WebView in `src/components/EngineView.tsx` (no native
module needed, works in Expo Go); see "Engine view" in `apps/mobile/README.md` for the URL and the
engine → app messages (ready / error / quit / purchase).

Still planned on this bridge:

- app → engine: pause/resume, settings, load a local zip.
- engine → app: tapped entity ids (tap-to-select to scope edits); a native Stars purchase sheet
  instead of the engine page's HTML one.
- Bundling the engine page into the app (offline) instead of loading it from a URL.
