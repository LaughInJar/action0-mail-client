/**
 * Reading and writing Sieve scripts (RFC 5228) the way action0 needs: a
 * script becomes a list of chunks with their exact source text, so that
 * writing it back changes only what the user changed.
 *
 * - `require` commands (their extensions are added to, never removed).
 * - `rule`: an `if` action0 can show, with Roundcube's `# rule:[name]`
 *   marker before it if there is one. Roundcube's disabled form,
 *   `if false # <test>`, reads as a switched-off rule.
 * - `vacation`: the first rule whose only action is `vacation` (the
 *   automatic reply), optionally limited to days with `currentdate`.
 * - `custom`: any other `if` (with its `elsif`/`else`): kept as written,
 *   and only switched on or off or deleted.
 * - `text`: everything else (comments, whitespace, other commands).
 *
 * Rules action0 writes look like Roundcube's, so either can edit them.
 */
import {
  NO_ACTIONS,
  NO_CONDITIONS,
  type AutoReply,
  type FilterActions,
  type FilterConditions,
  type FilterSpec,
} from "../../core/filters";
import { asMailboxId, type MailboxId } from "../../core/ids";

// ---------------------------------------------------------------------------
// Lexing and parsing (the generic grammar of RFC 5228, section 8)

/** The script isn't Sieve action0 can read (a stray quote, a missing brace…). */
export class SieveSyntaxError extends Error {
  override readonly name = "SieveSyntaxError";
}

type Punct = "[" | "]" | "(" | ")" | "{" | "}" | "," | ";";

interface Token {
  readonly kind: "identifier" | "tag" | "number" | "string" | "punct";
  /** Identifier and tag names (lower case), numbers in bytes, decoded strings, punctuation. */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface Comment {
  readonly start: number;
  readonly end: number;
  /** `# …` up to (not including) the line end, or the whole bracket comment. */
  readonly text: string;
}

const MULTIPLIERS: Readonly<Record<string, number>> = {
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

function lex(source: string): { tokens: Token[]; comments: Comment[] } {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  let i = 0;
  const at = (offset = 0) => source.charAt(i + offset);
  while (i < source.length) {
    const c = at();
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i += 1;
    } else if (c === "#") {
      const start = i;
      while (i < source.length && at() !== "\n" && at() !== "\r") i += 1;
      comments.push({ start, end: i, text: source.slice(start, i) });
    } else if (c === "/" && at(1) === "*") {
      const start = i;
      const close = source.indexOf("*/", i + 2);
      if (close === -1) throw new SieveSyntaxError("Unclosed comment");
      i = close + 2;
      comments.push({ start, end: i, text: source.slice(start, i) });
    } else if (c === '"') {
      const start = i;
      let value = "";
      i += 1;
      for (;;) {
        if (i >= source.length) throw new SieveSyntaxError("Unclosed string");
        const d = at();
        if (d === '"') break;
        if (d === "\\") {
          value += at(1);
          i += 2;
        } else {
          value += d;
          i += 1;
        }
      }
      i += 1;
      tokens.push({
        kind: "string",
        value: value.replace(/\r\n/g, "\n"),
        start,
        end: i,
      });
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (/[A-Za-z0-9_]/.test(at())) i += 1;
      const name = source.slice(start, i).toLowerCase();
      if (name === "text" && at() === ":") {
        i = multiline(source, i + 1, start, tokens);
      } else {
        tokens.push({ kind: "identifier", value: name, start, end: i });
      }
    } else if (c === ":") {
      const start = i;
      i += 1;
      if (!/[A-Za-z_]/.test(at())) throw new SieveSyntaxError("Bad tag");
      while (/[A-Za-z0-9_]/.test(at())) i += 1;
      tokens.push({
        kind: "tag",
        value: source.slice(start + 1, i).toLowerCase(),
        start,
        end: i,
      });
    } else if (/[0-9]/.test(c)) {
      const start = i;
      while (/[0-9]/.test(at())) i += 1;
      let value = Number(source.slice(start, i));
      const unit = MULTIPLIERS[at().toLowerCase()];
      if (unit !== undefined) {
        value *= unit;
        i += 1;
      }
      tokens.push({ kind: "number", value: String(value), start, end: i });
    } else if ("[](){},;".includes(c)) {
      tokens.push({ kind: "punct", value: c, start: i, end: i + 1 });
      i += 1;
    } else {
      throw new SieveSyntaxError(`Unexpected “${c}”`);
    }
  }
  return { tokens, comments };
}

/** A `text:` string from just after the colon; returns where it ends. */
function multiline(
  source: string,
  from: number,
  start: number,
  tokens: Token[],
): number {
  // Up to the line end: blanks and maybe a comment.
  const lineEnd = source.indexOf("\n", from);
  if (lineEnd === -1) throw new SieveSyntaxError("Unclosed text:");
  const rest = source.slice(from, lineEnd).replace(/\r$/, "");
  if (!/^[ \t]*(#.*)?$/.test(rest)) throw new SieveSyntaxError("Bad text:");
  const lines: string[] = [];
  let i = lineEnd + 1;
  for (;;) {
    if (i >= source.length) throw new SieveSyntaxError("Unclosed text:");
    const next = source.indexOf("\n", i);
    const end = next === -1 ? source.length : next;
    const line = source.slice(i, end).replace(/\r$/, "");
    i = next === -1 ? source.length : next + 1;
    if (line === ".") break;
    lines.push(line.startsWith("..") ? line.slice(1) : line);
  }
  tokens.push({
    kind: "string",
    value: lines.map((line) => `${line}\n`).join(""),
    start,
    end: i,
  });
  return i;
}

/** An argument of a command or test. */
type Arg =
  | {
      readonly kind: "string";
      readonly value: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "list";
      readonly values: readonly string[];
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "number";
      readonly value: number;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: "tag";
      readonly name: string;
      readonly start: number;
      readonly end: number;
    };

interface Test {
  readonly name: string;
  readonly args: readonly Arg[];
  readonly tests: readonly Test[];
  readonly start: number;
  readonly end: number;
}

interface Command extends Test {
  readonly block?: readonly Command[];
}

class Parser {
  #i = 0;
  readonly #tokens: readonly Token[];

  constructor(tokens: readonly Token[]) {
    this.#tokens = tokens;
  }

  done(): boolean {
    return this.#i >= this.#tokens.length;
  }

  commands(inBlock: boolean): Command[] {
    const commands: Command[] = [];
    for (;;) {
      const token = this.#peek();
      if (!token) {
        if (inBlock) throw new SieveSyntaxError("Missing }");
        return commands;
      }
      if (token.kind === "punct" && token.value === "}") {
        if (!inBlock) throw new SieveSyntaxError("Unexpected }");
        return commands;
      }
      commands.push(this.command());
    }
  }

  command(): Command {
    const name = this.#take("identifier");
    const args = this.#args();
    const tests = this.#tests();
    const end = this.#peek();
    if (end?.kind === "punct" && end.value === ";") {
      this.#i += 1;
      return { name: name.value, args, tests, start: name.start, end: end.end };
    }
    if (end?.kind === "punct" && end.value === "{") {
      this.#i += 1;
      const block = this.commands(true);
      const close = this.#take("punct", "}");
      return {
        name: name.value,
        args,
        tests,
        block,
        start: name.start,
        end: close.end,
      };
    }
    throw new SieveSyntaxError(`Expected ; or { after ${name.value}`);
  }

  test(): Test {
    const name = this.#take("identifier");
    const args = this.#args();
    const tests = this.#tests();
    const last = tests.at(-1)?.end ?? args.at(-1)?.end ?? name.end;
    // A test list's closing parenthesis ends the test.
    const closing = this.#tokens[this.#i - 1];
    const end =
      closing?.kind === "punct" && closing.value === ")"
        ? Math.max(last, closing.end)
        : last;
    return { name: name.value, args, tests, start: name.start, end };
  }

  #tests(): Test[] {
    const token = this.#peek();
    if (token?.kind === "identifier") return [this.test()];
    if (token?.kind === "punct" && token.value === "(") {
      this.#i += 1;
      const tests = [this.test()];
      while (this.#peekPunct(",")) {
        this.#i += 1;
        tests.push(this.test());
      }
      this.#take("punct", ")");
      return tests;
    }
    return [];
  }

  #args(): Arg[] {
    const args: Arg[] = [];
    for (;;) {
      const token = this.#peek();
      if (!token) return args;
      if (token.kind === "string") {
        this.#i += 1;
        args.push({
          kind: "string",
          value: token.value,
          start: token.start,
          end: token.end,
        });
      } else if (token.kind === "number") {
        this.#i += 1;
        args.push({
          kind: "number",
          value: Number(token.value),
          start: token.start,
          end: token.end,
        });
      } else if (token.kind === "tag") {
        this.#i += 1;
        args.push({
          kind: "tag",
          name: token.value,
          start: token.start,
          end: token.end,
        });
      } else if (token.kind === "punct" && token.value === "[") {
        this.#i += 1;
        const values = [this.#take("string").value];
        while (this.#peekPunct(",")) {
          this.#i += 1;
          values.push(this.#take("string").value);
        }
        const close = this.#take("punct", "]");
        args.push({ kind: "list", values, start: token.start, end: close.end });
      } else {
        return args;
      }
    }
  }

  #peek(): Token | undefined {
    return this.#tokens[this.#i];
  }

  #peekPunct(value: Punct): boolean {
    const token = this.#peek();
    return token?.kind === "punct" && token.value === value;
  }

  #take(kind: Token["kind"], value?: string): Token {
    const token = this.#peek();
    if (token?.kind !== kind || (value && token.value !== value))
      throw new SieveSyntaxError(`Expected ${value ?? kind}`);
    this.#i += 1;
    return token;
  }
}

/** Parses one test, e.g. from a disabled rule's comment; undefined if it isn't one. */
function parseTest(source: string): Test | undefined {
  try {
    const { tokens } = lex(source);
    const parser = new Parser(tokens);
    const test = parser.test();
    return parser.done() ? test : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The document

/** A rule action0 can show and edit. */
export interface SieveRule {
  readonly name?: string;
  readonly enabled: boolean;
  readonly conditions: FilterConditions;
  readonly actions: FilterActions;
  /** Actions action0 doesn't show, as written; kept when the rule is rewritten. */
  readonly extras: readonly string[];
}

/** The automatic reply as the script has it. */
export interface SieveVacation {
  readonly name?: string;
  readonly enabled: boolean;
  /** "YYYY-MM-DD". */
  readonly start?: string;
  readonly end?: string;
  readonly subject: string;
  readonly text: string;
  readonly days?: number;
  /** Other arguments (`:from`, `:handle`, …), as written; kept. */
  readonly keep: readonly string[];
}

/** How a custom rule is switched on and off: its text around the test. */
interface CustomToggle {
  /** Marker and `if ` (or `if false # `, `if allof (false, `). */
  readonly before: string;
  /** The test as written (for a disabled rule: the one it had). */
  readonly test: string;
  /** From the end of the test (or the comment) to the end. */
  readonly after: string;
  /** How it's switched off: `if false # …`, `if allof (false, …)`, or a bare `if false` (can't be switched on). */
  readonly form: "on" | "comment" | "allof" | "bare";
}

/** A piece of a script with its exact text. */
export type Chunk =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "require";
      readonly text: string;
      readonly extensions: readonly string[];
    }
  | { readonly kind: "rule"; readonly text: string; readonly rule: SieveRule }
  | {
      readonly kind: "custom";
      readonly text: string;
      readonly name?: string;
      readonly enabled: boolean;
      /** Without the marker. */
      readonly code: string;
      readonly toggle: CustomToggle;
    }
  | {
      readonly kind: "vacation";
      readonly text: string;
      readonly vacation: SieveVacation;
    };

/** A filter chunk: what the list shows, in script order. */
export type FilterChunk = Extract<Chunk, { kind: "rule" | "custom" }>;

/** A parsed script. */
export interface SieveDocument {
  /** The line end the script uses ("\r\n" for new scripts). */
  readonly eol: string;
  readonly chunks: readonly Chunk[];
}

/** What reading a script needs to know about the account. */
export interface ReadOptions {
  /** The Trash folder's name: `fileinto` there means "Delete". */
  readonly trash?: string;
}

const MARKER = /^#\s*rule:\[(.*)\]\s*$/;

/** The folder's MailboxId for a Sieve mailbox name (IMAP ids are `f:<path>`). */
export const folderId = (name: string): MailboxId => asMailboxId(`f:${name}`);
/** The Sieve mailbox name of an IMAP folder id; undefined for other ids. */
export function folderName(id: MailboxId): string | undefined {
  return id.startsWith("f:") ? id.slice(2) : undefined;
}

/**
 * Splits a script into chunks. Throws {@link SieveSyntaxError} when it
 * isn't Sieve action0 can read.
 */
export function parseScript(
  source: string,
  options: ReadOptions = {},
): SieveDocument {
  const eol = source.includes("\r\n") || source === "" ? "\r\n" : "\n";
  const { tokens, comments } = lex(source);
  const parser = new Parser(tokens);
  const commands = parser.commands(false);
  const chunks: Chunk[] = [];
  let position = 0;
  let vacationSeen = false;
  const text = (to: number) => {
    if (to > position)
      chunks.push({ kind: "text", text: source.slice(position, to) });
  };
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    if (!command) break;
    if (command.name === "require") {
      text(command.start);
      chunks.push({
        kind: "require",
        text: source.slice(command.start, command.end),
        extensions: stringsOf(command.args[0]),
      });
      position = command.end;
      continue;
    }
    if (command.name === "vacation" && !vacationSeen) {
      const vacation = readVacationCommand(command, source, {
        enabled: true,
      });
      if (vacation) {
        vacationSeen = true;
        text(command.start);
        chunks.push({
          kind: "vacation",
          text: source.slice(command.start, command.end),
          vacation,
        });
        position = command.end;
        continue;
      }
    }
    if (command.name !== "if") continue;
    // An if with elsif/else: one custom rule.
    let last = command;
    while (
      commands[index + 1]?.name === "elsif" ||
      commands[index + 1]?.name === "else"
    ) {
      index += 1;
      last = commands[index] ?? last;
    }
    const chained = last !== command;
    // Roundcube's marker right before it.
    const marker = comments
      .filter(
        (comment) =>
          comment.start >= position &&
          comment.end <= command.start &&
          /^\s*$/.test(source.slice(comment.end, command.start)),
      )
      .at(-1);
    const name = marker ? MARKER.exec(marker.text)?.[1] : undefined;
    const start = name === undefined || !marker ? command.start : marker.start;
    text(start);
    const chunkText = source.slice(start, last.end);
    const head = source.slice(start, command.start);
    const read = chained
      ? undefined
      : readIf(command, source, comments, options, !vacationSeen);
    if (read?.kind === "vacation") {
      vacationSeen = true;
      chunks.push({
        kind: "vacation",
        text: chunkText,
        vacation: { ...read.vacation, ...(name ? { name } : {}) },
      });
    } else if (read?.kind === "rule") {
      chunks.push({
        kind: "rule",
        text: chunkText,
        rule: { ...read.rule, ...(name ? { name } : {}) },
      });
    } else {
      const toggle = customToggle(command, source, comments, head, last.end);
      chunks.push({
        kind: "custom",
        text: chunkText,
        ...(name ? { name } : {}),
        enabled: toggle.form === "on",
        code: source.slice(command.start, last.end),
        toggle,
      });
    }
    position = last.end;
  }
  text(source.length);
  return { eol, chunks };
}

/** The script's text again, with whatever changed. */
export function writeScript(document: SieveDocument): string {
  return document.chunks.map((chunk) => chunk.text).join("");
}

/** The rules and custom rules, in script order. */
export function filterChunks(document: SieveDocument): FilterChunk[] {
  return document.chunks.filter(
    (chunk): chunk is FilterChunk =>
      chunk.kind === "rule" || chunk.kind === "custom",
  );
}

/** The automatic reply chunk, if the script has one. */
export function vacationOf(document: SieveDocument): SieveVacation | undefined {
  for (const chunk of document.chunks)
    if (chunk.kind === "vacation") return chunk.vacation;
  return undefined;
}

// ---------------------------------------------------------------------------
// Reading rules

type ReadIf =
  | { readonly kind: "rule"; readonly rule: SieveRule }
  | { readonly kind: "vacation"; readonly vacation: SieveVacation };

function readIf(
  command: Command,
  source: string,
  comments: readonly Comment[],
  options: ReadOptions,
  vacationWanted: boolean,
): ReadIf | undefined {
  const [test] = command.tests;
  if (!test || command.tests.length !== 1 || !command.block) return undefined;
  let enabled = true;
  let condition: Test | undefined = test;
  if (test.name === "false" && test.args.length === 0) {
    enabled = false;
    const comment = commentAfter(test, source, comments);
    condition = comment === undefined ? undefined : parseTest(comment);
  }
  if (!condition) return undefined;
  if (
    vacationWanted &&
    command.block.length === 1 &&
    command.block[0]?.name === "vacation"
  ) {
    const days = readDays(condition);
    const vacation = days
      ? readVacationCommand(command.block[0], source, { enabled, ...days })
      : undefined;
    if (vacation) return { kind: "vacation", vacation };
  }
  const conditions = readConditions(condition);
  if (!conditions) return undefined;
  const actions = readActions(command.block, source, options);
  if (!actions) return undefined;
  return {
    kind: "rule",
    rule: {
      enabled,
      conditions,
      actions: actions.actions,
      extras: actions.extras,
    },
  };
}

/** The `# …` comment on the same line right after `test` (Roundcube's `if false # …`). */
function commentAfter(
  test: Test,
  source: string,
  comments: readonly Comment[],
): string | undefined {
  const comment = comments.find(
    (c) =>
      c.start >= test.end && /^[ \t]*$/.test(source.slice(test.end, c.start)),
  );
  return comment?.text.startsWith("#") ? comment.text.slice(1) : undefined;
}

const stringsOf = (arg: Arg | undefined): string[] =>
  arg?.kind === "string"
    ? [arg.value]
    : arg?.kind === "list"
      ? [...arg.values]
      : [];

/** A test's tags, the values of tags that take one, and its other arguments. */
function argumentsOf(args: readonly Arg[]): {
  tags: Set<string>;
  comparator?: string;
  positional: Arg[];
} {
  const tags = new Set<string>();
  const positional: Arg[] = [];
  let comparator: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.kind === "tag") {
      if (arg.name === "comparator") {
        comparator = stringsOf(args[i + 1])[0]?.toLowerCase();
        i += 1;
      } else {
        tags.add(arg.name);
      }
    } else {
      positional.push(arg);
    }
  }
  return { tags, ...(comparator ? { comparator } : {}), positional };
}

type ConditionPart =
  | {
      readonly kind: "from" | "to" | "subject" | "words" | "notWords";
      readonly values: string[];
    }
  | { readonly kind: "hasAttachment" }
  | {
      readonly kind: "size";
      readonly compare: "larger" | "smaller";
      readonly bytes: number;
    };

function readConditions(test: Test): FilterConditions | undefined {
  let parts: readonly Test[];
  if (test.name === "true" && test.args.length === 0 && test.tests.length === 0)
    parts = [];
  else if (test.name === "allof") parts = test.tests;
  else if (test.name === "anyof" && test.tests.length === 1) parts = test.tests;
  else parts = [test];
  let conditions: FilterConditions = NO_CONDITIONS;
  const seen = new Set<string>();
  for (const part of parts) {
    const read = readCondition(part);
    if (!read || seen.has(read.kind)) return undefined;
    seen.add(read.kind);
    if (read.kind === "hasAttachment")
      conditions = { ...conditions, hasAttachment: true };
    else if (read.kind === "size")
      conditions = {
        ...conditions,
        size: { compare: read.compare, bytes: read.bytes },
      };
    else conditions = { ...conditions, [read.kind]: read.values };
  }
  return conditions;
}

function readCondition(test: Test): ConditionPart | undefined {
  if (test.name === "not") {
    const [inner] = test.tests;
    if (test.tests.length !== 1 || inner?.name !== "body") return undefined;
    const body = readCondition(inner);
    return body?.kind === "words"
      ? { kind: "notWords", values: body.values }
      : undefined;
  }
  if (test.tests.length > 0) return undefined;
  const { tags, comparator, positional } = argumentsOf(test.args);
  if (comparator !== undefined && comparator !== "i;ascii-casemap")
    return undefined;
  if (test.name === "size") {
    const [limit] = positional;
    if (positional.length !== 1 || limit?.kind !== "number") return undefined;
    if (tags.size !== 1) return undefined;
    if (tags.has("over"))
      return { kind: "size", compare: "larger", bytes: limit.value };
    if (tags.has("under"))
      return { kind: "size", compare: "smaller", bytes: limit.value };
    return undefined;
  }
  if (test.name === "body") {
    const known = new Set(["text", "contains"]);
    if (!tags.has("contains") || [...tags].some((tag) => !known.has(tag)))
      return undefined;
    const values = stringsOf(positional[0]);
    if (positional.length !== 1 || values.length === 0) return undefined;
    return { kind: "words", values };
  }
  if (test.name !== "header" && test.name !== "address") return undefined;
  if (positional.length !== 2) return undefined;
  const headers = stringsOf(positional[0]).map((h) => h.toLowerCase());
  const values = stringsOf(positional[1]);
  if (values.length === 0) return undefined;
  if (test.name === "header" && tags.has("mime")) {
    const attachment =
      tags.has("anychild") &&
      tags.has("contains") &&
      tags.size === 3 &&
      headers.length === 1 &&
      headers[0] === "content-disposition" &&
      values.length === 1 &&
      values[0]?.toLowerCase() === "attachment";
    return attachment ? { kind: "hasAttachment" } : undefined;
  }
  // header :contains; address :contains or :is, on the whole address.
  const allowed =
    test.name === "address"
      ? new Set(["contains", "is", "all"])
      : new Set(["contains"]);
  if ([...tags].some((tag) => !allowed.has(tag))) return undefined;
  if (!tags.has("contains") && !tags.has("is")) return undefined;
  const set = new Set(headers);
  if (set.size === 1 && set.has("from")) return { kind: "from", values };
  if (
    (set.size === 1 && set.has("to")) ||
    (set.size === 2 && set.has("to") && set.has("cc"))
  )
    return { kind: "to", values };
  if (set.size === 1 && set.has("subject") && test.name === "header")
    return { kind: "subject", values };
  return undefined;
}

const SEEN = "\\seen";
const FLAGGED = "\\flagged";

function readActions(
  block: readonly Command[],
  source: string,
  options: ReadOptions,
): { actions: FilterActions; extras: string[] } | undefined {
  let actions: FilterActions = NO_ACTIONS;
  const extras: string[] = [];
  let keep = false;
  for (const command of block) {
    if (command.block || command.tests.length > 0) return undefined;
    const raw = source.slice(command.start, command.end);
    const { tags, positional } = argumentsOf(command.args);
    const strings = positional.flatMap((arg) => stringsOf(arg));
    const plain = tags.size === 0 && positional.length === 1;
    switch (command.name) {
      case "fileinto": {
        const [target] = strings;
        if (
          plain &&
          positional[0]?.kind === "string" &&
          target !== undefined &&
          actions.moveTo === undefined &&
          !actions.trash
        ) {
          actions =
            options.trash !== undefined && target === options.trash
              ? { ...actions, trash: true }
              : { ...actions, moveTo: folderId(target) };
        } else {
          extras.push(raw);
        }
        break;
      }
      case "addflag": {
        const flags = strings.flatMap((value) =>
          value.split(/\s+/).filter(Boolean),
        );
        const known = flags.every((flag) =>
          [SEEN, FLAGGED].includes(flag.toLowerCase()),
        );
        if (tags.size === 0 && positional.length === 1 && known) {
          for (const flag of flags) {
            if (flag.toLowerCase() === SEEN)
              actions = { ...actions, markRead: true };
            else actions = { ...actions, star: true };
          }
        } else {
          extras.push(raw);
        }
        break;
      }
      case "redirect": {
        const [address] = strings;
        if (
          tags.size === 1 &&
          tags.has("copy") &&
          positional.length === 1 &&
          positional[0]?.kind === "string" &&
          address !== undefined
        ) {
          actions = {
            ...actions,
            forwardTo: [...actions.forwardTo, address],
          };
        } else {
          extras.push(raw);
        }
        break;
      }
      case "stop":
        actions = { ...actions, stop: true };
        break;
      case "keep":
        keep = true;
        break;
      default:
        extras.push(raw);
    }
  }
  // `keep` only matters next to something that files the mail elsewhere.
  if (
    keep &&
    (actions.moveTo !== undefined || actions.trash || extras.length > 0)
  )
    extras.push("keep;");
  return { actions, extras };
}

// ---------------------------------------------------------------------------
// The automatic reply

/** The days a vacation rule's test limits it to; undefined if it isn't such a test. */
function readDays(test: Test): { start?: string; end?: string } | undefined {
  if (test.name === "true" && test.args.length === 0) return {};
  const parts =
    test.name === "allof" || (test.name === "anyof" && test.tests.length === 1)
      ? test.tests
      : [test];
  let days: { start?: string; end?: string } = {};
  for (const part of parts) {
    if (part.name !== "currentdate" || part.tests.length > 0) return undefined;
    let relation: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < part.args.length; i += 1) {
      const arg = part.args[i];
      if (arg?.kind === "tag") {
        if (arg.name === "value") {
          relation = stringsOf(part.args[i + 1])[0];
          i += 1;
        } else if (arg.name === "zone" || arg.name === "comparator") {
          i += 1;
        } else if (arg.name !== "originalzone") {
          return undefined;
        }
      } else {
        const values = stringsOf(arg);
        if (values.length !== 1) return undefined;
        positional.push(values[0] ?? "");
      }
    }
    const [datePart, value] = positional;
    if (positional.length !== 2 || value === undefined) return undefined;
    const day =
      datePart === "date"
        ? value
        : datePart === "iso8601"
          ? value.slice(0, 10)
          : undefined;
    if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
    if (relation === "ge" && days.start === undefined)
      days = { ...days, start: day };
    else if (relation === "le" && days.end === undefined)
      days = { ...days, end: day };
    else return undefined;
  }
  return days;
}

function readVacationCommand(
  command: Command,
  source: string,
  base: { enabled: boolean; start?: string; end?: string },
): SieveVacation | undefined {
  if (command.block || command.tests.length > 0) return undefined;
  let subject = "";
  let days: number | undefined;
  const keep: string[] = [];
  const reasons: string[] = [];
  for (let i = 0; i < command.args.length; i += 1) {
    const arg = command.args[i];
    if (!arg) continue;
    if (arg.kind !== "tag") {
      if (arg.kind !== "string") return undefined;
      reasons.push(arg.value);
      continue;
    }
    const value = command.args[i + 1];
    switch (arg.name) {
      case "mime":
        return undefined;
      case "days":
        if (value?.kind !== "number") return undefined;
        days = value.value;
        i += 1;
        break;
      case "subject":
        if (value?.kind !== "string") return undefined;
        subject = value.value;
        i += 1;
        break;
      case "addresses":
        // Written anew from the account's addresses.
        i += 1;
        break;
      default:
        // :from, :handle, :seconds and anything else: kept as written.
        if (value && value.kind !== "tag") {
          keep.push(source.slice(arg.start, value.end));
          i += 1;
        } else {
          keep.push(source.slice(arg.start, arg.end));
        }
    }
  }
  const [text] = reasons;
  if (reasons.length !== 1 || text === undefined) return undefined;
  return {
    enabled: base.enabled,
    ...(base.start === undefined ? {} : { start: base.start }),
    ...(base.end === undefined ? {} : { end: base.end }),
    subject,
    text: text.replace(/\n$/, ""),
    ...(days === undefined ? {} : { days }),
    keep,
  };
}

/** The automatic reply of a script. */
export function autoReplyOf(document: SieveDocument): AutoReply {
  const vacation = vacationOf(document);
  return {
    enabled: vacation?.enabled ?? false,
    ...(vacation?.start === undefined ? {} : { start: vacation.start }),
    ...(vacation?.end === undefined ? {} : { end: vacation.end }),
    subject: vacation?.subject ?? "",
    text: vacation?.text ?? "",
    contactsOnly: false,
  };
}

// ---------------------------------------------------------------------------
// Custom rules: switching on and off

function customToggle(
  command: Command,
  source: string,
  comments: readonly Comment[],
  head: string,
  end: number,
): CustomToggle {
  const [test] = command.tests;
  const before =
    head + source.slice(command.start, test?.start ?? command.start);
  if (!test)
    return {
      before,
      test: "",
      after: source.slice(command.start, end),
      form: "bare",
    };
  if (test.name === "false" && test.args.length === 0) {
    const comment = comments.find(
      (c) =>
        c.start >= test.end && /^[ \t]*$/.test(source.slice(test.end, c.start)),
    );
    if (comment?.text.startsWith("#") && parseTest(comment.text.slice(1)))
      return {
        before,
        test: comment.text.slice(1).trim(),
        after: source.slice(comment.end, end),
        form: "comment",
      };
    return {
      before,
      test: "",
      after: source.slice(test.end, end),
      form: "bare",
    };
  }
  const [first, inner] = test.tests;
  if (
    test.name === "allof" &&
    test.tests.length === 2 &&
    first?.name === "false" &&
    first.args.length === 0 &&
    inner
  )
    return {
      before,
      test: source.slice(inner.start, inner.end),
      after: source.slice(test.end, end),
      form: "allof",
    };
  return {
    before,
    test: source.slice(test.start, test.end),
    after: source.slice(test.end, end),
    form: "on",
  };
}

/**
 * A custom rule's text switched on or off; undefined if it can't be (a
 * bare `if false` has no test to switch back to).
 */
export function toggledCustom(
  chunk: Extract<Chunk, { kind: "custom" }>,
  enabled: boolean,
  eol: string,
): string | undefined {
  const { before, test, after, form } = chunk.toggle;
  if (enabled === (form === "on")) return chunk.text;
  if (form === "bare") return undefined;
  const ifAt = before.lastIndexOf("if");
  const head = before.slice(0, ifAt) + "if ";
  if (enabled) {
    // A comment's test ended at the line end, which `after` starts with.
    return head + test + after;
  }
  if (!/[\r\n]/.test(test))
    return `${head}false # ${test}${/^[ \t]*\r?\n/.test(after) ? after : eol + after.replace(/^[ \t]+/, "")}`;
  return `${head}allof (false, ${test})${after}`;
}

// ---------------------------------------------------------------------------
// Writing

const quote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const strings = (values: readonly string[]) =>
  values.length === 1
    ? quote(values[0] ?? "")
    : `[${values.map(quote).join(", ")}]`;

function size(bytes: number): string {
  for (const [unit, factor] of [
    ["G", MULTIPLIERS.g],
    ["M", MULTIPLIERS.m],
    ["K", MULTIPLIERS.k],
  ] as const) {
    if (factor !== undefined && bytes >= factor && bytes % factor === 0)
      return `${bytes / factor}${unit}`;
  }
  return String(bytes);
}

/** The tests of the conditions, and the extensions they need. */
function testsOf(conditions: FilterConditions): {
  tests: string[];
  needs: string[];
} {
  const tests: string[] = [];
  const needs: string[] = [];
  if (conditions.from.length > 0)
    tests.push(`header :contains "from" ${strings(conditions.from)}`);
  if (conditions.to.length > 0)
    tests.push(`header :contains ["to", "cc"] ${strings(conditions.to)}`);
  if (conditions.subject.length > 0)
    tests.push(`header :contains "subject" ${strings(conditions.subject)}`);
  if (conditions.words.length > 0) {
    tests.push(`body :text :contains ${strings(conditions.words)}`);
    needs.push("body");
  }
  if (conditions.notWords.length > 0) {
    tests.push(`not body :text :contains ${strings(conditions.notWords)}`);
    needs.push("body");
  }
  if (conditions.hasAttachment) {
    tests.push(
      'header :mime :anychild :contains "Content-Disposition" "attachment"',
    );
    needs.push("mime");
  }
  if (conditions.size)
    tests.push(
      `size ${conditions.size.compare === "larger" ? ":over" : ":under"} ${size(conditions.size.bytes)}`,
    );
  return { tests, needs };
}

const joinTests = (tests: readonly string[]) =>
  tests.length === 0
    ? "true"
    : tests.length === 1
      ? (tests[0] ?? "true")
      : `allof (${tests.join(", ")})`;

/** Roundcube's `if` line: the test, or `false # <test>` when switched off. */
const ifLine = (test: string, enabled: boolean) =>
  enabled ? `if ${test}` : `if false # ${test}`;

/** What writing a rule needs to know about the account. */
export interface WriteOptions {
  /** The Trash folder's name, for "Delete". */
  readonly trash?: string | undefined;
}

/** A rule's text in Roundcube's style, and the extensions it needs. */
export function ruleText(
  rule: SieveRule,
  eol: string,
  options: WriteOptions = {},
): { text: string; needs: string[] } {
  const { tests, needs } = testsOf(rule.conditions);
  const { actions } = rule;
  const lines: string[] = [];
  const flags = [
    ...(actions.markRead ? ["\\Seen"] : []),
    ...(actions.star ? ["\\Flagged"] : []),
  ];
  if (flags.length > 0) {
    lines.push(`addflag ${strings(flags)};`);
    needs.push("imap4flags");
  }
  for (const address of actions.forwardTo) {
    lines.push(`redirect :copy ${quote(address)};`);
    needs.push("copy");
  }
  const target = actions.trash
    ? options.trash
    : actions.moveTo === undefined
      ? undefined
      : folderName(actions.moveTo);
  if (target !== undefined) {
    lines.push(`fileinto ${quote(target)};`);
    needs.push("fileinto");
  }
  lines.push(...rule.extras);
  if (actions.stop) lines.push("stop;");
  const name = cleanName(rule.name);
  const text = [
    ...(name ? [`# rule:[${name}]`] : []),
    ifLine(joinTests(tests), rule.enabled),
    "{",
    ...lines.map((line) => `\t${line}`),
    "}",
  ].join(eol);
  return { text, needs };
}

const cleanName = (name: string | undefined) =>
  name?.replace(/[\]\r\n]/g, " ").trim();

/** Sieve's `text:` string, for multi-line text. */
function multilineText(value: string, eol: string): string {
  const lines = value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return [
    "text:",
    ...lines.map((line) => (line.startsWith(".") ? `.${line}` : line)),
    ".",
  ].join(eol);
}

/** The automatic reply's text, and the extensions it needs. */
export function vacationText(
  vacation: SieveVacation,
  addresses: readonly string[],
  eol: string,
): { text: string; needs: string[] } {
  const needs = ["vacation"];
  const days: string[] = [];
  if (vacation.start !== undefined)
    days.push(`currentdate :value "ge" "date" ${quote(vacation.start)}`);
  if (vacation.end !== undefined)
    days.push(`currentdate :value "le" "date" ${quote(vacation.end)}`);
  if (days.length > 0) needs.push("date", "relational");
  const args = [
    `:days ${vacation.days ?? 1}`,
    ...(vacation.subject ? [`:subject ${quote(vacation.subject)}`] : []),
    ...(addresses.length > 0 ? [`:addresses ${strings(addresses)}`] : []),
    ...vacation.keep,
  ];
  const reason = /[\r\n]/.test(vacation.text)
    ? multilineText(vacation.text, eol)
    : quote(vacation.text);
  const name = cleanName(vacation.name) ?? "Automatic reply";
  // A multi-line text ends with its line end; the `;` goes on the next line.
  const command = `vacation ${args.join(" ")} ${reason}`;
  const text = [
    `# rule:[${name}]`,
    ifLine(joinTests(days), vacation.enabled),
    "{",
    `\t${command}${reason.startsWith("text:") ? eol : ""};`,
    "}",
  ].join(eol);
  return { text, needs };
}

/** A rule from a filter spec, keeping what the old rule had that action0 doesn't show. */
export function ruleOf(spec: FilterSpec, old?: SieveRule): SieveRule {
  return {
    ...(spec.name?.trim() ? { name: spec.name.trim() } : {}),
    enabled: spec.enabled,
    conditions: spec.conditions,
    actions: spec.actions,
    extras: old?.extras ?? [],
  };
}

/**
 * Makes sure the script requires `needs`: adds what's missing to the first
 * `require` (or puts one at the top).
 */
export function withRequires(
  document: SieveDocument,
  needs: readonly string[],
): SieveDocument {
  const have = new Set(
    document.chunks.flatMap((chunk) =>
      chunk.kind === "require"
        ? chunk.extensions.map((e) => e.toLowerCase())
        : [],
    ),
  );
  const missing = [...new Set(needs)].filter((need) => !have.has(need));
  if (missing.length === 0) return document;
  const index = document.chunks.findIndex((chunk) => chunk.kind === "require");
  const first = document.chunks[index];
  if (first?.kind === "require") {
    const extensions = [...first.extensions, ...missing];
    const chunks = [...document.chunks];
    chunks[index] = {
      kind: "require",
      text: `require ${strings(extensions)};`,
      extensions,
    };
    return { ...document, chunks };
  }
  return {
    ...document,
    chunks: [
      {
        kind: "require",
        text: `require ${strings(missing)};`,
        extensions: missing,
      },
      { kind: "text", text: document.eol },
      ...document.chunks,
    ],
  };
}

// ---------------------------------------------------------------------------
// Editing the document

/** Chunk indexes of the filters, in order. */
function filterIndexes(document: SieveDocument): number[] {
  return document.chunks.flatMap((chunk, index) =>
    chunk.kind === "rule" || chunk.kind === "custom" ? [index] : [],
  );
}

/** Replaces the `position`th filter's chunk. */
export function replaceFilter(
  document: SieveDocument,
  position: number,
  chunk: Chunk,
): SieveDocument {
  const index = filterIndexes(document)[position];
  if (index === undefined) return document;
  const chunks = [...document.chunks];
  chunks[index] = chunk;
  return { ...document, chunks };
}

/** Inserts a rule as the `position`th filter (else last). */
export function insertFilter(
  document: SieveDocument,
  position: number | undefined,
  chunk: Chunk,
): SieveDocument {
  const indexes = filterIndexes(document);
  const before =
    position === undefined || position >= indexes.length
      ? undefined
      : indexes[Math.max(0, position)];
  const chunks = [...document.chunks];
  if (before !== undefined) {
    chunks.splice(before, 0, chunk, { kind: "text", text: document.eol });
    return { ...document, chunks };
  }
  const text = writeScript(document);
  const lead = text === "" || text.endsWith("\n") ? "" : document.eol;
  chunks.push(...(lead ? [{ kind: "text" as const, text: lead }] : []), chunk, {
    kind: "text",
    text: document.eol,
  });
  return { ...document, chunks };
}

/** Takes the `position`th filter out (and the line end after it). */
export function removeFilter(
  document: SieveDocument,
  position: number,
): SieveDocument {
  const index = filterIndexes(document)[position];
  if (index === undefined) return document;
  const chunks = [...document.chunks];
  chunks.splice(index, 1);
  const next = chunks[index];
  if (next?.kind === "text") {
    const rest = next.text.replace(/^[ \t]*\r?\n/, "");
    if (rest === "") chunks.splice(index, 1);
    else chunks[index] = { kind: "text", text: rest };
  }
  return { ...document, chunks };
}

/** Puts the filters into this order (positions in the current order). */
export function reorderFilters(
  document: SieveDocument,
  order: readonly number[],
): SieveDocument {
  const indexes = filterIndexes(document);
  const chunks = [...document.chunks];
  order.forEach((from, to) => {
    const target = indexes[to];
    const source = indexes[from];
    if (target === undefined || source === undefined) return;
    const chunk = document.chunks[source];
    if (chunk) chunks[target] = chunk;
  });
  return { ...document, chunks };
}

/**
 * Puts the automatic reply in: in place of the old one, else at the top
 * (after the `require`), so rules that stop don't keep it from answering.
 */
export function setVacation(
  document: SieveDocument,
  text: string,
  vacation: SieveVacation,
): SieveDocument {
  const chunk: Chunk = { kind: "vacation", text, vacation };
  const index = document.chunks.findIndex((c) => c.kind === "vacation");
  const chunks = [...document.chunks];
  if (index !== -1) {
    chunks[index] = chunk;
    return { ...document, chunks };
  }
  let last = -1;
  document.chunks.forEach((c, i) => {
    if (c.kind === "require") last = i;
  });
  if (last === -1) chunks.unshift(chunk, { kind: "text", text: document.eol });
  else chunks.splice(last + 1, 0, { kind: "text", text: document.eol }, chunk);
  return { ...document, chunks };
}
