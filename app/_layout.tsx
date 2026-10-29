/**
 * THE ENTIRE INTEGRATION IS THIS FILE.
 *
 * Wrap the app root in <AnnoKitProvider> and you are done — no navigation
 * changes, no instrumenting the components you want to annotate, no calls
 * anywhere else in the tree.
 *
 * Mount exactly ONE, at the root. The provider owns the session, the marker
 * anchors, the event stream and the viewer identity for the whole app; a
 * second one (nested, or side by side) would share and overwrite all of it.
 * The package notices and warns in development rather than failing in ways
 * that are hard to attribute.
 *
 * It is also a strict no-op unless `__DEV__` is true AND an endpoint and a
 * session id resolve (see .env.local.example). In a production build the
 * children render untouched with zero overhead, so leaving this in place is
 * safe — the gate is absolute, not a flag you have to remember to flip.
 */
import { AnnoKitProvider } from "@joinearlybird/annokit";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <AnnoKitProvider>
      <Stack screenOptions={{ headerShown: false }} />
      <StatusBar style="auto" />
    </AnnoKitProvider>
  );
}
