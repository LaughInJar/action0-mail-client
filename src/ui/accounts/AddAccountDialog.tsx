import { useId } from "react";
import { useUi } from "../../state/context";
import { Sheet } from "../common/Sheet";
import { AddAccountFlow } from "./AddAccountFlow";

/** The Add account wizard as a dialog (a bottom sheet on phones). */
export function AddAccountDialog() {
  const open = useUi((state) => state.addAccountOpen);
  const setOpen = useUi((state) => state.setAddAccountOpen);
  const titleId = useId();
  if (!open) return null;

  const close = () => {
    setOpen(false);
  };
  return (
    <Sheet labelledBy={titleId} onEscape={close} size="lg">
      <div className="min-h-0 overflow-y-auto overscroll-contain p-5">
        <AddAccountFlow titleId={titleId} onConnected={close} />
      </div>
    </Sheet>
  );
}
