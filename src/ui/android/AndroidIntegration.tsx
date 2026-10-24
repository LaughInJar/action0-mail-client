import { useEffect, useState } from "react";
import { asAccountId, asMessageId } from "../../core/ids";
import { useFetchMailboxes } from "../../data/hooks";
import { useT } from "../../i18n/context";
import { usePlatform } from "../../platform/context";
import type { AvailableRelease, MobileControls } from "../../platform/types";
import { useRouter, useUi } from "../../state/context";
import type { ComposeActions } from "../composer/useComposeActions";
import { hexColor, shareMailto } from "./helpers";

/** How often the app looks for a newer release (besides at start). */
const RELEASE_CHECK_MS = 24 * 60 * 60 * 1000;

/**
 * What the Android app does besides the web app's job: turns the
 * background check on or off with the notifications setting (with its
 * texts in the interface's language), writes a mail with what other apps
 * share, opens the message a notification is about, and says when a
 * newer release is out. Renders that bar (Android only).
 */
export function AndroidIntegration({ compose }: { compose: ComposeActions }) {
  const platform = usePlatform();
  const { mobile } = platform;
  const notifications = useUi((state) => state.settings.notifications);
  const t = useT();
  const router = useRouter();
  const fetchMailboxes = useFetchMailboxes();
  const { composeFrom, attachFiles } = compose;

  useEffect(() => {
    void mobile
      ?.configureBackground({
        enabled: notifications,
        texts: {
          newMessages: t.android.newMessages,
          noSubject: t.common.noSubject,
        },
      })
      .catch(() => undefined);
  }, [mobile, notifications, t]);

  // The status and navigation bars follow the theme (light, dark, system).
  useEffect(() => {
    if (!mobile) return;
    const root = document.documentElement;
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const follow = () => {
      const theme = root.getAttribute("data-theme");
      const dark = theme === "dark" || (theme !== "light" && system.matches);
      mobile.setTheme(
        dark,
        hexColor(getComputedStyle(document.body).backgroundColor),
      );
    };
    follow();
    const observer = new MutationObserver(follow);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    system.addEventListener("change", follow);
    return () => {
      observer.disconnect();
      system.removeEventListener("change", follow);
    };
  }, [mobile]);

  useEffect(
    () =>
      platform.onShare?.((shared) => {
        composeFrom(shareMailto(shared));
        if (shared.files.length > 0) attachFiles(shared.files);
      }),
    [platform, composeFrom, attachFiles],
  );

  useEffect(
    () =>
      platform.onOpen?.((target) => {
        const accountId = asAccountId(target.accountId);
        void fetchMailboxes(accountId)
          .then((mailboxes) => {
            const inbox = mailboxes.find((mailbox) => mailbox.role === "inbox");
            if (!inbox) return;
            router.navigate({
              accountId,
              mailboxId: inbox.id,
              ...(target.messageId === undefined
                ? {}
                : { messageId: asMessageId(target.messageId) }),
            });
          })
          .catch(() => undefined);
      }),
    [platform, fetchMailboxes, router],
  );

  return mobile ? <ReleaseBar mobile={mobile} /> : null;
}

/** Says when a newer release is out: looked for at start and once a day. */
function ReleaseBar({ mobile }: { mobile: MobileControls }) {
  const [release, setRelease] = useState<AvailableRelease | null>(null);
  const [hidden, setHidden] = useState(false);
  const { openExternal } = usePlatform();
  const t = useT();
  const a = t.android;

  useEffect(() => {
    let stopped = false;
    const look = () => {
      void mobile.checkForUpdate().then((found) => {
        if (!stopped && found) setRelease(found);
      });
    };
    look();
    const timer = setInterval(look, RELEASE_CHECK_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [mobile]);

  if (!release || hidden) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100"
    >
      <span className="min-w-0 flex-1">
        {a.releaseAvailable(release.version)}
      </span>
      <button
        type="button"
        onClick={() => {
          openExternal(release.url);
        }}
        className="rounded-md bg-blue-600 px-3 py-1 font-medium text-white hover:bg-blue-700 pointer-coarse:min-h-11"
      >
        {a.download}
      </button>
      <button
        type="button"
        onClick={() => {
          setHidden(true);
        }}
        className="rounded-md px-3 py-1 hover:bg-blue-100 dark:hover:bg-blue-900 pointer-coarse:min-h-11"
      >
        {a.later}
      </button>
    </div>
  );
}
