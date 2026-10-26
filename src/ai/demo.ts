/**
 * The demo's AI: canned answers written word by word, so the assistant can
 * be tried without a key. Like the demo's sample mails, it speaks English.
 */
import type { AiClient, AiTask } from "./types";

/** How long each word takes (ms). */
const WORD_MS = 25;

const ANSWERS: Readonly<Record<AiTask, string>> = {
  summary: [
    "The sender asks for feedback and wants an answer by Friday.",
    "",
    "- **Asks:** a short review of the attached plan",
    "- **Deadline:** Friday",
    "- **Next step:** reply with your comments or a time to talk",
  ].join("\n"),
  ask: "The demo AI can't read the mail, but a real service answers questions like this from the mail's text.",
  write: [
    "Hi,",
    "",
    "Thanks for your message. That works for me, and I'll get back to you with the details by Friday.",
    "",
    "Best regards",
  ].join("\n"),
  rewrite:
    "This is how the demo AI rewrites text. A real service rewrites what you chose, following your instruction.",
};

/** See the module docs. */
export const demoClient: AiClient = {
  models: () => Promise.resolve([{ id: "demo", name: "Demo" }]),
  write: (request, signal) => words(ANSWERS[request.task], signal),
};

async function* words(
  text: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  for (const word of text.split(/(?<=\s)/)) {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const timer = setTimeout(resolve, WORD_MS);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
    yield word;
  }
}
