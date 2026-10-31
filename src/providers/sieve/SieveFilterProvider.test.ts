import { describe, expect, it } from "vitest";
import { MailServerError } from "../../accounts/mailServer";
import { MailError } from "../../core/errors";
import { NO_ACTIONS, NO_CONDITIONS, type FilterSpec } from "../../core/filters";
import { asMailboxId } from "../../core/ids";
import type { Mailbox } from "../../core/model";
import { fakeSieveBridge, type FakeSieveOptions } from "../../test/sieveBridge";
import { SieveFilterProvider, sieveCapabilities } from "./SieveFilterProvider";

const KEY = "imap:me@example.org";

const folder = (path: string, role?: Mailbox["role"]): Mailbox => ({
  id: asMailboxId(`f:${path}`),
  name: path,
  kind: "folder",
  ...(role ? { role } : {}),
  selectable: true,
  hidden: false,
  assignable: true,
});

const MAILBOXES = [
  folder("INBOX", "inbox"),
  folder("Papierkorb", "trash"),
  folder("Shopping"),
];

const SCRIPT = [
  'require ["fileinto"];',
  "# rule:[Newsletters]",
  'if header :contains "from" "news@shop.at"',
  "{",
  '\tfileinto "Shopping";',
  "}",
  'if header :contains "X-Spam" "YES" { fileinto "Junk"; }',
  "",
].join("\r\n");

function setup(options: FakeSieveOptions = {}) {
  const fake = fakeSieveBridge(options);
  const provider = new SieveFilterProvider({
    bridge: fake.bridge,
    key: KEY,
    service: "imap.example.org",
    addresses: () => Promise.resolve(["me@example.org", "info@example.org"]),
    mailboxes: () => Promise.resolve(MAILBOXES),
  });
  return { ...fake, provider };
}

const spec = (overrides: Partial<FilterSpec> = {}): FilterSpec => ({
  name: "Anna",
  enabled: true,
  conditions: { ...NO_CONDITIONS, from: ["anna@example.org"] },
  actions: { ...NO_ACTIONS, markRead: true },
  ...overrides,
});

describe("Sieve filters", () => {
  it("says when the mail server has no filter server", async () => {
    const { provider } = setup({ server: null });
    const error = await provider.load().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect(error).toMatchObject({
      code: "unavailable",
      reason: "noFilterServer",
      params: { service: "imap.example.org" },
    });
  });

  it("lists the rules and what the server can do", async () => {
    const { provider } = setup({ script: SCRIPT });
    const setup_ = await provider.load();
    expect(setup_.filters).toMatchObject([
      {
        name: "Newsletters",
        enabled: true,
        conditions: { from: ["news@shop.at"] },
        actions: { moveTo: "f:Shopping" },
        more: false,
      },
      {
        enabled: true,
        custom: 'if header :contains "X-Spam" "YES" { fileinto "Junk"; }',
      },
    ]);
    expect(setup_.capabilities).toMatchObject({
      names: true,
      toggle: true,
      order: true,
      forward: "any",
      maxForward: 4,
      scope: "inbox",
      autoReply: { subject: true, html: false, schedule: true },
    });
    expect(setup_.capabilities.actions).toContain("trash");
    expect(setup_.autoReply).toMatchObject({ enabled: false });
  });

  it("offers only what the server's extensions allow", () => {
    const bare = sieveCapabilities(["fileinto"], false);
    expect(bare.conditions).toEqual(["from", "to", "subject", "size"]);
    expect(bare.actions).toEqual(["moveTo", "stop"]);
    expect(bare.forward).toBeUndefined();
    expect(bare.autoReply).toBeUndefined();
    const noDates = sieveCapabilities(["vacation"], false);
    expect(noDates.autoReply?.schedule).toBe(false);
  });

  it("creates the first script, activates it and requires what it uses", async () => {
    const { provider, state } = setup();
    const created = await provider.create(
      spec({
        actions: { ...NO_ACTIONS, trash: true, star: true },
      }),
    );
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      name: "action0",
      activate: true,
      expected: "",
    });
    expect(state.script).toBe(
      [
        'require ["imap4flags", "fileinto"];',
        "# rule:[Anna]",
        'if header :contains "from" "anna@example.org"',
        "{",
        '\taddflag "\\\\Flagged";',
        '\tfileinto "Papierkorb";',
        "}",
        "",
      ].join("\r\n"),
    );
    expect(created).toMatchObject({
      name: "Anna",
      actions: { trash: true, star: true },
    });
    const { filters } = await provider.load();
    expect(filters[0]?.id).toBe(created.id);
  });

  it("creates at a place, edits, switches, reorders and deletes", async () => {
    const { provider, state } = setup({ script: SCRIPT });
    const created = await provider.create(spec(), 0);
    let { filters } = await provider.load();
    expect(filters.map((f) => f.name)).toEqual([
      "Anna",
      "Newsletters",
      undefined,
    ]);
    expect(filters[0]?.id).toBe(created.id);

    const edited = await provider.update(
      created.id,
      spec({
        name: "Anna B.",
        conditions: { ...NO_CONDITIONS, to: ["me@x.org"] },
      }),
    );
    ({ filters } = await provider.load());
    expect(filters[0]).toMatchObject({
      id: edited.id,
      name: "Anna B.",
      conditions: { to: ["me@x.org"], from: [] },
    });

    await provider.setEnabled(edited.id, false);
    ({ filters } = await provider.load());
    expect(filters[0]?.enabled).toBe(false);
    expect(state.script).toContain(
      'if false # header :contains ["to", "cc"] "me@x.org"',
    );

    const custom = filters[2];
    if (!custom) throw new Error("no custom rule");
    await provider.setEnabled(custom.id, false);
    ({ filters } = await provider.load());
    expect(filters[2]).toMatchObject({ enabled: false });
    expect(state.script).toContain(
      'if false # header :contains "X-Spam" "YES"\r\n{ fileinto "Junk"; }',
    );

    const [first, second, third] = filters;
    if (!first || !second || !third) throw new Error("no rules");
    await provider.reorder([third.id, first.id, second.id]);
    ({ filters } = await provider.load());
    expect(filters.map((f) => f.name)).toEqual([
      undefined,
      "Anna B.",
      "Newsletters",
    ]);

    const newsletters = filters[2];
    if (!newsletters) throw new Error("no rule");
    await provider.remove(newsletters.id);
    ({ filters } = await provider.load());
    expect(filters.map((f) => f.name)).toEqual([undefined, "Anna B."]);
    expect(state.script).not.toContain("Newsletters");
    expect(
      state.script.startsWith('require ["fileinto", "imap4flags"];\r\n'),
    ).toBe(true);
  });

  it("refuses to edit a rule that changed elsewhere meanwhile", async () => {
    const { provider, state } = setup({ script: SCRIPT });
    const { filters } = await provider.load();
    const [first] = filters;
    if (!first) throw new Error("no rule");
    state.script = state.script.replace("news@shop.at", "deals@shop.at");
    await expect(provider.update(first.id, spec())).rejects.toMatchObject({
      reason: "filtersChanged",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("says so when the script changes between reading and writing", async () => {
    const { state, bridge } = setup({ script: SCRIPT });
    const original = state.script;
    const provider = new SieveFilterProvider({
      bridge: {
        ...bridge,
        // Someone else writes right after action0 read.
        read: async (key) => {
          const script = await bridge.read(key);
          state.script = `${original}# edited elsewhere\r\n`;
          return script;
        },
      },
      key: KEY,
      service: "imap.example.org",
      addresses: () => Promise.resolve([]),
      mailboxes: () => Promise.resolve(MAILBOXES),
    });
    await expect(provider.create(spec())).rejects.toMatchObject({
      reason: "filtersChanged",
    });
    expect(state.writes).toHaveLength(0);
  });

  it("refuses to edit custom rules, which can only be switched or deleted", async () => {
    const { provider } = setup({ script: SCRIPT });
    const { filters } = await provider.load();
    const custom = filters[1];
    if (!custom) throw new Error("no custom rule");
    await expect(provider.update(custom.id, spec())).rejects.toBeInstanceOf(
      MailError,
    );
  });

  it("writes the automatic reply with the account's addresses and switches it off", async () => {
    const { provider, state } = setup({ script: SCRIPT });
    await provider.setAutoReply({
      enabled: true,
      start: "2026-12-20",
      end: "2027-01-06",
      subject: "Holidays",
      text: "Back in January.",
      contactsOnly: false,
    });
    expect(state.script).toContain(
      'vacation :days 1 :subject "Holidays" :addresses ["me@example.org", "info@example.org"] "Back in January.";',
    );
    expect(state.script.split("\r\n")[0]).toBe(
      'require ["fileinto", "vacation", "date", "relational"];',
    );
    expect(await provider.autoReply()).toEqual({
      enabled: true,
      start: "2026-12-20",
      end: "2027-01-06",
      subject: "Holidays",
      text: "Back in January.",
      contactsOnly: false,
    });
    await provider.setAutoReply({
      enabled: false,
      subject: "Holidays",
      text: "Back in January.",
      contactsOnly: false,
    });
    expect((await provider.load()).autoReply).toMatchObject({
      enabled: false,
      text: "Back in January.",
    });
    // Rules are untouched by it.
    expect((await provider.load()).filters).toHaveLength(2);
  });

  it("writes nothing for a switched-off automatic reply that never existed", async () => {
    const { provider, state } = setup({ script: SCRIPT });
    await provider.setAutoReply({
      enabled: false,
      subject: "",
      text: "",
      contactsOnly: false,
    });
    expect(state.writes).toHaveLength(0);
  });

  it("knows the automatic reply only once the filter server was found", async () => {
    const { provider } = setup({ script: SCRIPT });
    expect(await provider.autoReply()).toBeUndefined();
    await provider.load();
    expect(await provider.autoReply()).toMatchObject({ enabled: false });
  });

  it("passes the server's refusal on", async () => {
    const { provider, state } = setup({ script: SCRIPT });
    await provider.load();
    state.failNext = new MailServerError("auth", "Login refused", {
      server: "sieve",
    });
    await expect(provider.load()).rejects.toMatchObject({
      code: "auth-required",
    });
  });

  it("uses another filter server when the user chooses one, and forgets it again", async () => {
    const { provider, state } = setup({
      server: null,
      script: SCRIPT,
      reachable: (server) => server.host === "sieve.example.org",
    });
    await expect(provider.load()).rejects.toMatchObject({
      reason: "noFilterServer",
    });
    expect(await provider.filterServer.current()).toBeUndefined();
    await expect(
      provider.filterServer.choose({ host: "nowhere.example.org", port: 4190 }),
    ).rejects.toMatchObject({ code: "network", reason: "unreachable" });
    await provider.filterServer.choose({
      host: "sieve.example.org",
      port: 4190,
    });
    expect(await provider.filterServer.current()).toEqual({
      host: "sieve.example.org",
      port: 4190,
      chosen: true,
    });
    expect((await provider.load()).filters).toHaveLength(2);
    await provider.filterServer.choose(null);
    expect(state.kept).toBeUndefined();
    await expect(provider.load()).rejects.toMatchObject({
      reason: "noFilterServer",
    });
  });

  it("searches like the filter, in IMAP's search words", () => {
    const { provider } = setup();
    expect(
      provider.searchOf({
        from: ["news@shop.at", "deals@shop.at"],
        to: ["Anna Berger"],
        subject: ["sale"],
        words: ["50% off"],
        notWords: ["unsubscribe", "-x"],
        hasAttachment: true,
        size: { compare: "larger", bytes: 1048576 },
      }),
    ).toBe(
      'from:news@shop.at to:"Anna Berger" subject:sale "50% off" -unsubscribe -"-x" larger:1048576',
    );
  });
});
