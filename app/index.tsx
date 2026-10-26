import { Link } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import { Card } from "../components/Card";
import { PrimaryButton } from "../components/PrimaryButton";

/**
 * A deliberately ordinary screen. Nothing here knows the overlay exists —
 * no hooks, no wrappers, no testIDs added for its benefit (the one on
 * PrimaryButton is there to show how a testID survives into the payload).
 */
export default function Home() {
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <View style={styles.header}>
        <Text style={styles.kicker}>ANNOTATE EXAMPLE</Text>
        <Text style={styles.heading}>Tap the pencil, then tap anything</Text>
        <Text style={styles.body}>
          The floating button arms annotate mode. Touch an element and it lights up
          with its component name; write what you mean, then choose who it is for —
          an agent task, or a team note.
        </Text>
      </View>

      <Card title="Try annotating this card">
        <Text style={styles.body}>
          Marks land on the element, not the screen, so they stay put when the list
          scrolls. Tap a marker to reopen, reply or resolve it.
        </Text>
      </Card>

      <Card title="Component identity">
        <Text style={styles.body}>
          Annotating the button below reports <Text style={styles.code}>PrimaryButton</Text>,
          not <Text style={styles.code}>View</Text> — the nearest component you would
          actually go and edit, with the file and line beside it.
        </Text>
        <PrimaryButton label="Annotate me" />
      </Card>

      <Card title="Notes travel between screens">
        <Text style={styles.body}>
          Leave a team note here, open the second screen, then use Comments in the
          overlay: tapping a note from another screen navigates there and opens it.
        </Text>
        <Link href="/second" style={styles.link}>
          Go to the second screen →
        </Link>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 20, gap: 16, paddingTop: 72, paddingBottom: 120, backgroundColor: "#f8fafc" },
  header: { gap: 8, marginBottom: 4 },
  kicker: { fontSize: 11, letterSpacing: 1.5, fontWeight: "700", color: "#2563eb" },
  heading: { fontSize: 28, fontWeight: "800", color: "#0f172a", lineHeight: 34 },
  body: { fontSize: 15, lineHeight: 22, color: "#475569" },
  code: { fontFamily: "Courier", color: "#0f172a" },
  link: { fontSize: 15, fontWeight: "600", color: "#2563eb", paddingTop: 4 },
});
