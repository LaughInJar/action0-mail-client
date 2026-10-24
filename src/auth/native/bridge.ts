/**
 * The desktop app's sign-in, done natively (system browser, PKCE, refresh
 * tokens in the OS keychain). The UI only ever gets access tokens.
 * Implemented over Tauri commands in `src/platform/desktop`.
 */

/** The app's registration at the provider. */
export interface NativeClient {
  readonly id: string;
  /** Google's desktop clients have one (it isn't confidential). */
  readonly secret?: string;
}

/** What a browser sign-in asks for. */
export interface NativeSignInRequest {
  readonly provider: "google" | "microsoft";
  readonly client: NativeClient;
  /** Everything to ask for. */
  readonly scopes: readonly string[];
  /** Scopes without which the account is useless. */
  readonly required: readonly string[];
  readonly loginHint?: string;
  readonly prompt: "select_account" | "consent";
}

/** A signed-in account. */
export interface NativeAccount {
  /** The account id (`gmail:<email>`, `microsoft:<email>`). */
  readonly key: string;
  readonly email: string;
  /** Microsoft's tenant (personal accounts have a known one). */
  readonly tenant?: string | null;
  /** The scopes granted. */
  readonly scopes: readonly string[];
}

/** Why a native sign-in call failed. */
export type NativeAuthErrorKind =
  | "reauth"
  | "scopes"
  | "cancelled"
  | "denied"
  | "wrongAccount"
  | "network"
  | "provider";

/** What the bridge rejects with. */
export class NativeAuthError extends Error {
  override readonly name = "NativeAuthError";
  readonly kind: NativeAuthErrorKind;

  constructor(kind: NativeAuthErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** The native side of sign-in. */
export interface NativeAuthBridge {
  /** Signs a new account in (opens the browser). */
  readonly connect: (request: NativeSignInRequest) => Promise<NativeAccount>;
  /** Signs `key` in again (opens the browser); rejects for another account. */
  readonly signIn: (
    key: string,
    request: NativeSignInRequest,
  ) => Promise<NativeAccount>;
  /** An access token covering `scopes` (every granted one if empty). */
  readonly token: (
    key: string,
    scopes: readonly string[],
  ) => Promise<{ readonly accessToken: string; readonly expiresAt: number }>;
  /** Revokes and forgets the account. */
  readonly signOut: (key: string) => Promise<void>;
}

/** What a provider module needs to sign in natively (desktop app). */
export interface NativeSignIn {
  readonly bridge: NativeAuthBridge;
  readonly client: NativeClient;
  /** Accounts signed in at earlier starts, by account id. */
  readonly accounts: ReadonlyMap<string, NativeAccount>;
}
