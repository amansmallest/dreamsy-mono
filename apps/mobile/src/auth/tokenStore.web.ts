// Web (PWA): the API token in localStorage (no keychain in the browser). Private mode / blocked
// storage degrades to signed-out on reload instead of throwing.

export async function getToken(key: string): Promise<string | null> {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export async function setToken(key: string, value: string): Promise<void> {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

export async function deleteToken(key: string): Promise<void> {
  try {
    window.localStorage.removeItem(key);
  } catch {}
}
