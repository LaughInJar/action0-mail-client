/**
 * The page Microsoft's sign-in returns to (`redirect.html`), in the popup
 * and in MSAL's hidden renewal iframe. It only hands the answer back to the
 * app; opened on its own, it goes to the app.
 */
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame().catch(() => {
  window.location.replace(import.meta.env.BASE_URL);
});
