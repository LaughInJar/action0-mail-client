import { MailError } from "../../core/errors";

/** The Google Identity Services OAuth 2.0 API (`google.accounts.oauth2`). */
export type GoogleOAuth2 = typeof google.accounts.oauth2;

const GIS_SRC = "https://accounts.google.com/gsi/client";

/** Returns the GIS API if the script has already loaded, without waiting. */
export function peekGis(): GoogleOAuth2 | undefined {
  const scope = globalThis as {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  };
  return scope.google?.accounts?.oauth2;
}

let loading: Promise<GoogleOAuth2> | undefined;

/**
 * Loads the GIS client script once. Call this early (e.g. at startup) so that
 * a later sign-in can open its popup synchronously inside the user gesture.
 */
export function loadGis(timeoutMs = 15_000): Promise<GoogleOAuth2> {
  const ready = peekGis();
  if (ready) return Promise.resolve(ready);

  loading ??= new Promise<GoogleOAuth2>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GIS_SRC;
    script.async = true;

    const fail = (cause: unknown) => {
      clearTimeout(timer);
      loading = undefined;
      script.remove();
      reject(
        new MailError("network", "Could not load Google sign-in.", {
          cause,
          reason: "signInUnavailable",
        }),
      );
    };
    const timer = setTimeout(() => {
      fail(new Error("Timed out"));
    }, timeoutMs);

    script.onload = () => {
      clearTimeout(timer);
      const api = peekGis();
      if (api) resolve(api);
      else fail(new Error("google.accounts.oauth2 missing after load"));
    };
    script.onerror = () => {
      fail(new Error("Script failed to load"));
    };
    document.head.append(script);
  });
  return loading;
}
