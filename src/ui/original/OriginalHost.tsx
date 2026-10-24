import { lazy, Suspense } from "react";
import { useOriginal, useRouter } from "../../state/context";

// The original's view loads when first opened.
const OriginalView = lazy(() =>
  import("./OriginalView").then((module) => ({
    default: module.OriginalView,
  })),
);

/** Shows a message's original while the URL says it's open. */
export function OriginalHost() {
  const message = useOriginal();
  const router = useRouter();
  if (!message) return null;
  return (
    <Suspense fallback={null}>
      <OriginalView
        key={`${message.accountId}/${message.messageId}`}
        message={message}
        onClose={router.closeOriginal}
      />
    </Suspense>
  );
}
