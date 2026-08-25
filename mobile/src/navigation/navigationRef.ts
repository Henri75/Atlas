import { createNavigationContainerRef } from '@react-navigation/native';

/**
 * A container-ref handle for imperative navigation from outside React
 * ("Search & Ask →" on Overview). Typed loosely: the tab names are strings
 * here by design, since the ref is created before the navigator mounts.
 */
export const navigationRef = createNavigationContainerRef();

export function jumpToTab(name: string) {
  if (navigationRef.isReady()) {
    navigationRef.navigate(name as never);
  }
}
