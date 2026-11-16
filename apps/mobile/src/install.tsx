// "Install Dreamsy" for the web app (install.web.tsx): Chrome's install prompt, the iOS Safari
// "Add to Home Screen" sheet. The native apps are already installed, so everything here is inert.

export type InstallState = { canInstall: boolean; install: () => void };

export function useInstall(): InstallState {
  return { canInstall: false, install: () => {} };
}

/** Home: dismissible install banner (web). */
export function InstallBanner(_props: { ready: boolean }) {
  return null;
}

/** Root layout: the iOS "Add to Home Screen" sheet (web). */
export function InstallHost() {
  return null;
}
