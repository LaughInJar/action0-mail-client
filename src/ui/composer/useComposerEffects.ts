import { useEffect, useRef } from "react";
import { sentBytes } from "../../compose/session";
import { asDraftId } from "../../core/ids";
import { useDraftSync } from "../../data/drafts";
import { useRoute, useRouter, useUi, useUiStore } from "../../state/context";
import type { Route } from "../../state/router";
import type { Breakpoint } from "../layout/useBreakpoint";
import {
  saveSession,
  sendQueued,
  type ComposeActions,
} from "./useComposeActions";
import { useT } from "../../i18n/context";

/** A draft saves this long after the last edit. */
export const AUTOSAVE_DELAY_MS = 2000;
/**
 * Drafts that carry big files save less often: providers replace
 * drafts as a whole, so every save uploads the files again.
 */
export const LARGE_AUTOSAVE_DELAY_MS = 30_000;
const LARGE_DRAFT_BYTES = 1_000_000;

const withoutCompose = (route: NonNullable<Route>): NonNullable<Route> => {
  const { compose, composeAccount, ...rest } = route;
  return rest;
};

/**
 * The composer's background work, independent of whether it's on screen:
 * autosaving, sending queued mail when its undo period ends, warning before
 * leaving the page with unsent or unsaved mail, and (on tablets and phones,
 * where the composer is full screen) keeping it in the URL so Back closes it.
 */
export function useComposerEffects(
  breakpoint: Breakpoint,
  actions: ComposeActions,
): void {
  const store = useUiStore();
  const sync = useDraftSync();
  const router = useRouter();
  const t = useT();
  const composer = useUi((state) => state.composer);
  const pendingSends = useUi((state) => state.pendingSends);

  // Autosave: after a pause in editing (re-armed by every edit).
  const dirty =
    composer !== null &&
    !composer.saving &&
    composer.revision > composer.savedRevision;
  const dirtyRevision = dirty ? `${composer.key}:${composer.revision}` : null;
  useEffect(() => {
    if (dirtyRevision === null) return;
    const session = store.getState().composer;
    if (!session) return;
    const delay =
      session.saveError !== undefined || sentBytes(session) > LARGE_DRAFT_BYTES
        ? LARGE_AUTOSAVE_DELAY_MS
        : AUTOSAVE_DELAY_MS;
    const timer = setTimeout(() => {
      const latest = store.getState().composer;
      if (latest) void saveSession(store, sync, latest, t);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [dirtyRevision, store, sync, t]);

  // Send queued mail when its undo period is over.
  useEffect(() => {
    const timers = pendingSends.map((pending) =>
      setTimeout(
        () => {
          sendQueued(store, sync, pending.id, t);
        },
        Math.max(0, pending.sendAt - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [pendingSends, store, sync, t]);

  // Ask before leaving with mail waiting to be sent or unsaved changes.
  const unsafe =
    pendingSends.length > 0 ||
    (composer !== null &&
      (composer.saving || composer.revision > composer.savedRevision));
  useEffect(() => {
    if (!unsafe) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [unsafe]);

  // The URL: `compose=new|<draftId>` while a full-screen composer is open.
  const fullScreen = breakpoint !== "wide";
  const routeCompose = useRoute()?.compose;
  const key = composer?.key;
  const draftId = composer?.draftId;
  const composerAccount = composer?.accountId;
  const url = useRef<{ key: number | null; started: boolean }>({
    key: null,
    started: false,
  });
  useEffect(() => {
    const state = url.current;
    const current = router.getRoute();
    if (!state.started) {
      state.started = true;
      // A reload with a composer in the URL: reopen its draft.
      if (current?.compose !== undefined && key === undefined) {
        if (current.compose === "new")
          router.navigate(withoutCompose(current), { replace: true });
        else
          actions.resumeDraft(
            current.composeAccount ?? current.accountId,
            asDraftId(current.compose),
          );
        return;
      }
    }
    if (!current) return;

    if (key === undefined) {
      // Closed: take the composer out of the URL again.
      if (current.compose !== undefined) {
        if (state.key !== null && router.canGoBack()) router.back();
        else router.navigate(withoutCompose(current), { replace: true });
      }
      state.key = null;
      return;
    }
    if (state.key === key && current.compose === undefined) {
      // Back was pressed: close (and save).
      state.key = null;
      actions.close();
      return;
    }
    if (!fullScreen) return;
    const value = draftId ?? "new";
    // The draft's account, when it isn't the one in context (a reload resumes it there).
    const composing = {
      ...withoutCompose(current),
      compose: value,
      ...(composerAccount !== undefined && composerAccount !== current.accountId
        ? { composeAccount: composerAccount }
        : {}),
    };
    if (state.key !== key) {
      state.key = key;
      router.navigate(composing, { replace: current.compose !== undefined });
    } else if (
      current.compose !== value ||
      current.composeAccount !== composing.composeAccount
    ) {
      router.navigate(composing, { replace: true });
    }
  }, [
    key,
    draftId,
    composerAccount,
    routeCompose,
    fullScreen,
    router,
    actions,
  ]);
}
