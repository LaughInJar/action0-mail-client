/**
 * The page sign-ins return to (`redirect.html`): Microsoft's, in the popup
 * and in MSAL's hidden renewal iframe, and OpenRouter's (`?to=openrouter`,
 * the code in the query; MSAL's answer comes in the fragment). It only
 * hands the answer back to the app; opened on its own, it goes to the app.
 */
import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { OPENROUTER_CHANNEL } from "./ai/webBackend";

const query = new URLSearchParams(window.location.search);
const code = query.get("code");
if (query.get("to") === "openrouter" && code !== null) {
  const channel = new BroadcastChannel(OPENROUTER_CHANNEL);
  channel.postMessage({ code });
  channel.close();
  window.close();
} else {
  broadcastResponseToMainFrame().catch(() => {
    window.location.replace(import.meta.env.BASE_URL);
  });
}
