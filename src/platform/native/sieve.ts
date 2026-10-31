/**
 * The filter server (ManageSieve) bridge over the apps' native side
 * (`src-tauri/src/imap/sieve.rs`): JSON commands per mail server account.
 */
import type {
  SieveBridge,
  SieveScript,
  SieveServerInfo,
} from "../../providers/sieve/bridge";
import { toMailServerError } from "./imap";
import type { Invoke } from "./nativeFetch";

/** See the module docs. */
export function createNativeSieveBridge(invoke: Invoke): SieveBridge {
  const call = async <T>(
    command: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    try {
      return await invoke<T>(command, args);
    } catch (error) {
      throw toMailServerError(error);
    }
  };
  return {
    find: (key) => call<SieveServerInfo>("sieve_find", { key }),
    setServer: (key, server) =>
      call<SieveServerInfo | null>("sieve_set_server", {
        key,
        server: server ? { host: server.host, port: server.port } : null,
      }),
    known: (key) => call<SieveServerInfo | null>("sieve_known", { key }),
    read: (key) => call<SieveScript>("sieve_read", { key }),
    write: (key, request) =>
      call<undefined>("sieve_write", {
        key,
        request: {
          name: request.name,
          script: request.script,
          expected: request.expected,
          activate: request.activate,
        },
      }),
  };
}
