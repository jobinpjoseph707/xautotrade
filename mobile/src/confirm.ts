import { Alert, Platform } from 'react-native';

/**
 * Alert.alert() is a documented no-op on react-native-web (the browser
 * preview served at localhost:8081) -- react-native-web's Alert module is
 * `class Alert { static alert() {} }`. Every confirm dialog and every
 * "Failed: ..." error popup in this app went through Alert.alert, so on web
 * every one of them silently did nothing: the button's onPress handler ran,
 * hit Alert.alert(), and stopped there -- nothing ever appeared, and nothing
 * the user could press ever fired the real action underneath (logout, stop
 * all bots, close position, delete strategy, etc). It works fine in Expo Go
 * on a phone, because that's the real native Alert.
 *
 * These two helpers keep the native behaviour on iOS/Android and fall back
 * to window.confirm/alert on web, so every screen behaves the same on both.
 */

/** A single-button info/error message. */
export function notify(title: string, message?: string): void {
  if (Platform.OS === 'web') {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

/** A Cancel/Confirm dialog. onConfirm only runs if the user confirms. */
export function confirmAction(
  title: string,
  message: string,
  confirmLabel: string,
  onConfirm: () => void | Promise<void>,
  opts?: { destructive?: boolean; onCancel?: () => void },
): void {
  if (Platform.OS === 'web') {
    if (window.confirm(message ? `${title}\n\n${message}` : title)) {
      void onConfirm();
    } else {
      opts?.onCancel?.();
    }
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel', onPress: opts?.onCancel },
    { text: confirmLabel, style: opts?.destructive ? 'destructive' : 'default', onPress: () => void onConfirm() },
  ]);
}
