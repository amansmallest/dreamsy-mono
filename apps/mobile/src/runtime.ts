import Constants, { ExecutionEnvironment } from 'expo-constants';

/**
 * Running inside the Expo Go app (not a dev client / store build). Native modules that aren't
 * bundled in Expo Go (Google Sign-In) must not be imported there; see src/auth/native.ts.
 */
export const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
