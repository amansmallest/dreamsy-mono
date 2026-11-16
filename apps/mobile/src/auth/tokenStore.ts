import * as SecureStore from 'expo-secure-store';

// Where the API token lives: the keychain / keystore on iOS and Android, localStorage on web
// (tokenStore.web.ts).

export const getToken = (key: string): Promise<string | null> => SecureStore.getItemAsync(key);
export const setToken = (key: string, value: string): Promise<void> => SecureStore.setItemAsync(key, value);
export const deleteToken = (key: string): Promise<void> => SecureStore.deleteItemAsync(key);
