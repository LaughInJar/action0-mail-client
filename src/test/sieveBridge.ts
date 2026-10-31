import { MailServerError } from "../accounts/mailServer";
import type {
  SieveBridge,
  SieveServer,
  SieveServerInfo,
  SieveWrite,
} from "../providers/sieve/bridge";

/** What a Dovecot (Pigeonhole) server usually offers. */
export const DOVECOT_EXTENSIONS: readonly string[] = [
  "fileinto",
  "reject",
  "envelope",
  "encoded-character",
  "vacation",
  "subaddress",
  "comparator-i;ascii-numeric",
  "relational",
  "regex",
  "imap4flags",
  "copy",
  "include",
  "variables",
  "body",
  "enotify",
  "environment",
  "mailbox",
  "date",
  "index",
  "ihave",
  "duplicate",
  "mime",
  "foreverypart",
  "extracttext",
];

/** Options of {@link fakeSieveBridge}. */
export interface FakeSieveOptions {
  /** The active script ("" or undefined: none is active). */
  readonly script?: string;
  /** The active script's name (default "roundcube" when there's a script). */
  readonly name?: string;
  readonly extensions?: readonly string[];
  /**
   * The server {@link SieveBridge.find} finds (default: the IMAP host on
   * 4190); `null`: none answers.
   */
  readonly server?: SieveServerInfo | null;
  /** Servers "Use another server" can reach (default: any). */
  readonly reachable?: (server: SieveServer) => boolean;
}

/**
 * An in-memory ManageSieve server behind the bridge: one active script,
 * writes recorded, `expected` honoured (`changed` otherwise). With
 * `server: null` nothing is found until "Use another server" chooses a
 * reachable one. Tests change `state.script` to simulate edits made
 * elsewhere, and set `state.failNext` to make the next call fail.
 */
export function fakeSieveBridge(options: FakeSieveOptions = {}) {
  const extensions = options.extensions ?? DOVECOT_EXTENSIONS;
  const found =
    options.server === undefined
      ? { host: "imap.example.com", port: 4190, extensions, chosen: false }
      : options.server;
  const state: {
    script: string;
    name: string | undefined;
    /** The server kept for the account (found or chosen). */
    kept: SieveServerInfo | undefined;
    found: SieveServerInfo | null;
    writes: SieveWrite[];
    failNext: MailServerError | undefined;
  } = {
    script: options.script ?? "",
    name: options.script ? (options.name ?? "roundcube") : undefined,
    kept: undefined,
    found,
    writes: [],
    failNext: undefined,
  };
  // Like the native side: anything that talks to the server finds and keeps it.
  const keep = () => {
    if (!state.kept && state.found) state.kept = state.found;
    return state.kept;
  };
  /** Runs a call, unless the test set `failNext`: then that's the answer. */
  const answer = <T>(call: () => Promise<T>): Promise<T> => {
    const error = state.failNext;
    state.failNext = undefined;
    return error ? Promise.reject(error) : call();
  };
  const notFound = () =>
    new MailServerError(
      "notFound",
      "No filter server (ManageSieve) answered.",
      { server: "sieve" },
    );
  const bridge: SieveBridge = {
    find: () =>
      answer(() => {
        const kept = keep();
        return kept ? Promise.resolve(kept) : Promise.reject(notFound());
      }),
    setServer: (_key, server) =>
      answer(() => {
        if (server === null) {
          state.kept = undefined;
          return Promise.resolve(null);
        }
        if (options.reachable && !options.reachable(server))
          return Promise.reject(
            new MailServerError(
              "unreachable",
              `Couldn't reach ${server.host}:${server.port}`,
              { server: "sieve" },
            ),
          );
        state.kept = { ...server, extensions, chosen: true };
        return Promise.resolve(state.kept);
      }),
    known: () => answer(() => Promise.resolve(state.kept ?? null)),
    read: () =>
      answer(() => {
        if (!keep()) return Promise.reject(notFound());
        return Promise.resolve({
          ...(state.name === undefined ? {} : { name: state.name }),
          script: state.script,
          extensions,
        });
      }),
    write: (_key, request) =>
      answer(() => {
        if (!keep()) return Promise.reject(notFound());
        if (request.expected !== state.script)
          return Promise.reject(
            new MailServerError(
              "changed",
              "The script was changed meanwhile.",
              { server: "sieve" },
            ),
          );
        state.writes.push(request);
        state.script = request.script;
        state.name = request.name;
        return Promise.resolve();
      }),
  };
  return { bridge, state };
}
