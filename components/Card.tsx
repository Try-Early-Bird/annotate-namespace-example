import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

export function Card({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#e2e8f0",
  },
  title: { fontSize: 17, fontWeight: "700", color: "#0f172a" },
});
