import { lazy, Suspense } from "react";
import { useRouter, useSettingsOpen } from "../../state/context";

// Settings (and its signature editor) load when first opened.
const SettingsDialog = lazy(() =>
  import("./SettingsDialog").then((module) => ({
    default: module.SettingsDialog,
  })),
);

/** Shows Settings while the URL says it's open. */
export function SettingsHost() {
  const open = useSettingsOpen();
  const router = useRouter();
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <SettingsDialog onClose={router.closeSettings} />
    </Suspense>
  );
}
