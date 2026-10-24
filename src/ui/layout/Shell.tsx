import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { useAccounts } from "../../accounts/context";
import {
  useCalendarRoute,
  useRoute,
  useRouter,
  useUi,
  useUiStore,
} from "../../state/context";
import { useActionCommands } from "../actions/useActionCommands";
import { useMailActions, type MailActions } from "../actions/useMailActions";
import { useUndo, type Undo } from "../actions/useUndo";
import { ComposerHost } from "../composer/ComposerHost";
import { SendQueueBar } from "../composer/SendQueueBar";
import { useComposeActions } from "../composer/useComposeActions";
import { useComposeCommands } from "../composer/useComposeCommands";
import { useComposerEffects } from "../composer/useComposerEffects";
import { useFileDrop } from "../composer/useFileDrop";
import { NotificationsBar } from "../sync/NotificationsBar";
import { notifyArrivals } from "../sync/notifications";
import { usePlatform } from "../../platform/context";
import { DesktopIntegration } from "../desktop/DesktopIntegration";
import { Reminders } from "../reminders/Reminders";
import { useDocumentTitle } from "../sync/useDocumentTitle";
import { useMailSync } from "../sync/useMailSync";
import { ShortcutHelp } from "../help/ShortcutHelp";
import { Sidebar } from "../mailboxes/Sidebar";
import { MessageListPane } from "../messages/MessageListPane";
import { useListController } from "../messages/useListController";
import { ReaderPane } from "../reader/ReaderPane";
import { Welcome } from "../welcome/Welcome";
import { Drawer } from "./Drawer";
import { ReconnectBar } from "./ReconnectBar";
import { ResizableColumns } from "./ResizableColumns";
import { AddAccountDialog } from "../accounts/AddAccountDialog";
import { ConfirmHost } from "../common/ConfirmDialog";
import { QuestionHost } from "../common/QuestionDialog";
import { SettingsHost } from "../settings/SettingsHost";
import { LabelDialogHost } from "../labels/LabelDialog";
import { LabelMenuHost } from "../labels/LabelMenu";
import { ManageLabelsHost } from "../labels/ManageLabelsDialog";
import { MailboxPickerHost } from "../pickers/MailboxPicker";
import { ToastHost } from "./ToastHost";
import { useApplyTheme } from "./useApplyTheme";
import { useBreakpoint, type Breakpoint } from "./useBreakpoint";
import { useCommands } from "../../keyboard/context";
import type { Command } from "../../keyboard/registry";
import { useGlobalCommands } from "./useGlobalCommands";
import { useNavigationDefaults } from "./useNavigationDefaults";
import { useRememberAccountColors } from "../accounts/accountColors";
import { useT } from "../../i18n/context";

/** The calendar, loaded when it's first opened. */
const CalendarApp = lazy(() =>
  import("../calendar/CalendarApp").then((module) => ({
    default: module.CalendarApp,
  })),
);

/** The app's top-level layout: the welcome screen, or the mail UI. */
export function Shell() {
  const accounts = useAccounts();
  useApplyTheme();
  return accounts.length === 0 ? <Welcome /> : <MailApp />;
}

/**
 * Three columns on wide screens, a folder drawer plus two columns on medium
 * screens, and one pane at a time (chosen by the URL) on phones.
 */
function MailApp() {
  const breakpoint = useBreakpoint();
  const t = useT();
  const route = useRoute();
  const calendar = useCalendarRoute();
  const drawerOpen = useUi((state) => state.drawerOpen);
  const setDrawerOpen = useUi((state) => state.setDrawerOpen);
  useNavigationDefaults(breakpoint);
  useGlobalCommands(breakpoint);
  const actions = useMailActions();
  const compose = useComposeActions();
  useComposerEffects(breakpoint, compose);
  useComposeCommands(compose);
  const fileDrop = useFileDrop(compose);
  const router = useRouter();
  const store = useUiStore();
  const platform = usePlatform();
  useMailSync((arrivals) => {
    if (store.getState().settings.notifications)
      notifyArrivals(arrivals, router, t, platform.notifications);
  });
  useDocumentTitle();
  useRememberAccountColors();
  const undo = useUndo(actions, compose);

  useEffect(() => {
    if (breakpoint !== "medium") setDrawerOpen(false);
  }, [breakpoint, setDrawerOpen]);

  let content: ReactNode;
  if (calendar !== null) {
    content = (
      <Suspense fallback={null}>
        <CalendarApp breakpoint={breakpoint} />
      </Suspense>
    );
  } else if (breakpoint === "wide") {
    content = (
      <ResizableColumns
        columns={[
          {
            id: "tree",
            label: t.layout.folders,
            widthIndex: 0,
            content: <Sidebar />,
          },
          {
            id: "list",
            label: t.layout.messageList,
            widthIndex: 1,
            content: <MessageListPane breakpoint={breakpoint} />,
          },
          {
            id: "reader",
            label: t.layout.message,
            content: <ReaderPane breakpoint={breakpoint} />,
          },
        ]}
      />
    );
  } else if (breakpoint === "medium") {
    content = (
      <>
        <Drawer
          open={drawerOpen}
          label={t.layout.folders}
          onClose={() => {
            setDrawerOpen(false);
          }}
        >
          <Sidebar
            onNavigate={() => {
              setDrawerOpen(false);
            }}
          />
        </Drawer>
        <ResizableColumns
          columns={[
            {
              id: "list",
              label: t.layout.messageList,
              widthIndex: 1,
              content: <MessageListPane breakpoint={breakpoint} />,
            },
            {
              id: "reader",
              label: t.layout.message,
              content: <ReaderPane breakpoint={breakpoint} />,
            },
          ]}
        />
      </>
    );
  } else {
    let pane: ReactNode;
    if (route === null) pane = <Sidebar />;
    else if (route.messageId === undefined)
      pane = <MessageListPane breakpoint={breakpoint} />;
    else pane = <ReaderPane breakpoint={breakpoint} />;
    content = <div className="min-h-0 min-w-0 flex-1">{pane}</div>;
  }

  return (
    <div className="flex h-dvh flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <ReconnectBar />
      <NotificationsBar />
      <DesktopIntegration compose={compose} />
      <div className="flex min-h-0 flex-1">{content}</div>
      {calendar === null ? (
        <MailCommands breakpoint={breakpoint} actions={actions} undo={undo} />
      ) : (
        <UndoCommand undo={undo} />
      )}
      <ShortcutHelp />
      <MailboxPickerHost />
      <LabelMenuHost />
      <ManageLabelsHost />
      <LabelDialogHost />
      <SettingsHost />
      <ConfirmHost />
      <QuestionHost />
      <AddAccountDialog />
      <ComposerHost breakpoint={breakpoint} actions={compose} />
      <SendQueueBar actions={compose} />
      {fileDrop && (
        <div className="pointer-events-none fixed inset-3 z-[60] grid place-items-center rounded-2xl border-4 border-dashed border-blue-500 bg-blue-50/80 text-lg font-semibold text-blue-900 dark:bg-blue-950/80 dark:text-blue-100">
          {t.layout.dropToCompose}
        </div>
      )}
      <Reminders />
      <ToastHost onUndo={undo.undo} />
    </div>
  );
}

/**
 * The mail list's and the mail actions' shortcuts: only while mail is
 * shown, so the calendar's keys never act on a hidden selection.
 */
function MailCommands({
  breakpoint,
  actions,
  undo,
}: {
  breakpoint: Breakpoint;
  actions: MailActions;
  undo: Undo;
}) {
  useListController(breakpoint);
  useActionCommands(actions, undo);
  return null;
}

/** `z` in the calendar: undoes the latest change (e.g. an answer). */
function UndoCommand({ undo }: { undo: Undo }) {
  const t = useT();
  useCommands(
    useMemo(
      (): Command[] => [
        {
          id: "calendar.undo",
          group: "general",
          description: t.shortcuts.undo,
          keys: ["z"],
          run: () => {
            undo.undo();
          },
        },
      ],
      [undo, t],
    ),
  );
  return null;
}
