import { createContext, useContext } from "react";
import type { ContactCards } from "../core/contacts";

/** Reading and writing vCard files (wired in `src/app`). */
export const ContactCardsContext = createContext<ContactCards | null>(null);

/** vCard import and export, if the app has them. */
export function useContactCards(): ContactCards | null {
  return useContext(ContactCardsContext);
}
