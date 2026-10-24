import {
  NativeAuthError,
  type NativeAccount,
  type NativeAuthBridge,
  type NativeAuthErrorKind,
  type NativeSignInRequest,
} from "../../auth/native/bridge";
import type { Invoke } from "./nativeFetch";

/** The page the browser shows after signing in. */
export interface SignedInPage {
  readonly done: string;
  readonly failed: string;
}

const KINDS = new Set<NativeAuthErrorKind>([
  "reauth",
  "scopes",
  "cancelled",
  "denied",
  "wrongAccount",
  "network",
  "provider",
]);

/** A native refusal (`{kind, message}`) as a {@link NativeAuthError}. */
export function toNativeError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const { kind, message } = error as { kind?: unknown; message?: unknown };
  return typeof kind === "string" && KINDS.has(kind as NativeAuthErrorKind)
    ? new NativeAuthError(
        kind as NativeAuthErrorKind,
        typeof message === "string" ? message : "",
      )
    : error;
}

/** The accounts the native side kept from earlier starts. */
export interface KeptAccounts {
  /** False without an OS keychain: accounts stay signed in until quitting. */
  readonly persistent: boolean;
  readonly accounts: readonly NativeAccount[];
}

/** The sign-in commands of `src-tauri/src/oauth`. */
export function createAuthBridge(
  invoke: Invoke,
  page: () => SignedInPage,
): NativeAuthBridge & { readonly kept: () => Promise<KeptAccounts> } {
  const call = async <T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw toNativeError(error);
    }
  };
  const request = (sign: NativeSignInRequest) => ({ ...sign, page: page() });
  return {
    kept: () => call("auth_accounts", {}),
    connect: (sign) => call("auth_connect", { request: request(sign) }),
    signIn: (key, sign) =>
      call("auth_sign_in", { key, request: request(sign) }),
    token: (key, scopes) => call("auth_token", { key, scopes }),
    signOut: (key) => call("auth_sign_out", { key }),
  };
}
