import { lazy, Suspense } from "react";
import { useUi } from "../../state/context";
import type { Breakpoint } from "../layout/useBreakpoint";
import type { ComposeActions } from "./useComposeActions";

// The editor is only loaded when it's first needed.
const Composer = lazy(() =>
  import("./Composer").then((module) => ({ default: module.Composer })),
);

/** Shows the open composer (docked on desktop, full screen elsewhere). */
export function ComposerHost({
  breakpoint,
  actions,
}: {
  breakpoint: Breakpoint;
  actions: ComposeActions;
}) {
  const key = useUi((state) => state.composer?.key);
  if (key === undefined) return null;
  return (
    <Suspense fallback={null}>
      <Composer
        key={key}
        actions={actions}
        fullScreen={breakpoint !== "wide"}
      />
    </Suspense>
  );
}
