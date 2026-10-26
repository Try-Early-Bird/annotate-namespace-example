import { Link } from "expo-router";
import { ScrollView, StyleSheet, Text } from "react-native";

import { Card } from "../components/Card";

/**
 * A second route, so route-keyed markers have somewhere to differ.
 *
 * Marks made here are tagged with this screen's pathname, which is what
 * lets the overlay filter markers per screen and navigate to a note that
 * lives somewhere else. That comes from expo-router, an OPTIONAL peer —
 * without it everything still works, marks just are not filtered by route.
 */
export default function Second() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Text style={styles.heading}>Second screen</Text>
      <Card title="Marks are keyed to this route">
        <Text style={styles.body}>
          Annotate something here, then go back. Each screen shows only its own
          markers, and the Comments list groups notes by screen with the one you
          are on first.
        </Text>
      </Card>
      <Link href="/" style={styles.link}>
        ← Back
      </Link>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, paddingTop: 72, backgroundColor: "#f8fafc", flexGrow: 1 },
  heading: { fontSize: 28, fontWeight: "800", color: "#0f172a" },
  body: { fontSize: 15, lineHeight: 22, color: "#475569" },
  link: { fontSize: 15, fontWeight: "600", color: "#2563eb" },
});
