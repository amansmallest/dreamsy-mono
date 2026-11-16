// iOS / Android use the system Alert and share sheet. On web (dialogs.web.tsx), react-native-web's
// Alert.alert does nothing, so it is replaced with an in-app dialog rendered by <DialogHost />.

export function DialogHost() {
  return null;
}
