/**
 * A named component, which is the point.
 *
 * The overlay reports the nearest USER component — "PrimaryButton", not
 * "View" — so what you annotate reads like the code you would go and edit.
 * Annotating one of these shows `PrimaryButton` in the composer and
 * `PrimaryButton.tsx:<line>` in the task detail.
 */
import { Pressable, StyleSheet, Text } from "react-native";

export function PrimaryButton({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable style={styles.button} onPress={onPress} testID="primary-button">
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: "#2563eb",
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: "center",
  },
  label: { color: "white", fontSize: 16, fontWeight: "600" },
});
