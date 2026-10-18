import { useEffect, type ReactNode } from "react";
import { useAccounts } from "../../accounts/context";
import { useRoute, useRouter, useUi } from "../../state/context";
import { useActionCommands } from "../actions/useActionCommands";
import { useMailActions } from "../actions/useMailActions";
import { useUndo } from "../actions/useUndo";
import { ComposerHost } from "../composer/ComposerHost";
import { SendQueueBar } from "../composer/SendQueueBar";
import { useComposeActions } from "../composer/useComposeActions";
import { useComposeCommands } from "../composer/useComposeCommands";
import { useComposerEffects } from "../composer/useComposerEffects";
import { useFileDrop } from "../composer/useFileDrop";
import { NotificationsBar } from "../sync/NotificationsBar";
import { notifyArrivals } from "../sync/notifications";
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
import { LabelDialogHost } from "../labels/LabelDialog";
import { LabelMenuHost } from "../labels/LabelMenu";
import { ManageLabelsHost } from "../labels/ManageLabelsDialog";
import { MailboxPickerHost } from "../pickers/MailboxPicker";
import { ToastHost } from "./ToastHost";
import { useBreakpoint } from "./useBreakpoint";
import { useGlobalCommands } from "./useGlobalCommands";
import { useNavigationDefaults } from "./useNavigationDefaults";

/** The app's top-level layout: the welcome screen, or the mail UI. */
export function Shell() {
  const accounts = useAccounts();
  return accounts.length === 0 ? <Welcome /> : <MailApp />;
}

/**
 * Three columns on wide screens, a folder drawer plus two columns on medium
 * screens, and one pane at a time (chosen by the URL) on phones.
 */
function MailApp() {
  const breakpoint = useBreakpoint();
  const route = useRoute();
  const drawerOpen = useUi((state) => state.drawerOpen);
  const setDrawerOpen = useUi((state) => state.setDrawerOpen);
  useNavigationDefaults(breakpoint);
  useListController(breakpoint);
  useGlobalCommands(breakpoint);
  const actions = useMailActions();
  const compose = useComposeActions();
  useComposerEffects(breakpoint, compose);
  useComposeCommands(compose);
  const fileDrop = useFileDrop(compose);
  const router = useRouter();
  useMailSync((arrivals) => {
    notifyArrivals(arrivals, router);
  });
  useDocumentTitle();
  const undo = useUndo(actions, compose);
  useActionCommands(actions, undo);

  useEffect(() => {
    if (breakpoint !== "medium") setDrawerOpen(false);
  }, [breakpoint, setDrawerOpen]);

  let content: ReactNode;
  if (breakpoint === "wide") {
    content = (
      <ResizableColumns
        columns={[
          { id: "tree", label: "Folders", widthIndex: 0, content: <Sidebar /> },
          {
            id: "list",
            label: "Message list",
            widthIndex: 1,
            content: <MessageListPane breakpoint={breakpoint} />,
          },
          {
            id: "reader",
            label: "Message",
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
          label="Folders"
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
              label: "Message list",
              widthIndex: 1,
              content: <MessageListPane breakpoint={breakpoint} />,
            },
            {
              id: "reader",
              label: "Message",
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
      <div className="flex min-h-0 flex-1">{content}</div>
      <ShortcutHelp />
      <MailboxPickerHost />
      <LabelMenuHost />
      <ManageLabelsHost />
      <LabelDialogHost />
      <ConfirmHost />
      <AddAccountDialog />
      <ComposerHost breakpoint={breakpoint} actions={compose} />
      <SendQueueBar actions={compose} />
      {fileDrop && (
        <div className="pointer-events-none fixed inset-3 z-[60] grid place-items-center rounded-2xl border-4 border-dashed border-blue-500 bg-blue-50/80 text-lg font-semibold text-blue-900 dark:bg-blue-950/80 dark:text-blue-100">
          Drop to start a new mail with these files
        </div>
      )}
      <ToastHost onUndo={undo.undo} />
    </div>
  );
}
