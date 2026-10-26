// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { MemoryStorage } from "../test/memoryStorage";
import type { AiServiceConfig } from "./types";
import { createWebAiBackend, OPENROUTER_CHANNEL } from "./webBackend";

function setup() {
  const session = new MemoryStorage();
  const local = new MemoryStorage();
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    () => Promise.resolve(new Response("{}")),
  );
  const backend = createWebAiBackend({
    session,
    local,
    redirectUrl: "https://app.example/redirect.html",
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { session, local, fetch, backend };
}

const claude: AiServiceConfig = { id: "c1", kind: "anthropic" };
const headersOf = (init: RequestInit | undefined) =>
  Object.fromEntries(new Headers(init?.headers).entries());

describe("the web app's AI backend", () => {
  it("keeps keys for the session unless the service is remembered", async () => {
    const { session, local, backend } = setup();
    await backend.saveKey(claude, "sk-session");
    expect(session.getItem("a0.ai.key.c1")).toBe("sk-session");
    expect(local.length).toBe(0);

    backend.setRemember?.(claude, true);
    expect(local.getItem("a0.ai.key.c1")).toBe("sk-session");
    expect(session.length).toBe(0);

    backend.setRemember?.(claude, false);
    expect(session.getItem("a0.ai.key.c1")).toBe("sk-session");
    expect(local.length).toBe(0);

    expect((await backend.credentials()).ids).toEqual(new Set(["c1"]));
    await backend.forget(claude);
    expect(session.length + local.length).toBe(0);
    expect((await backend.credentials()).ids.size).toBe(0);
  });

  it("adds each kind's key header, sends no cookies or referrer", async () => {
    const { fetch, backend } = setup();
    await backend.saveKey(claude, "sk-ant");
    await backend.send(claude, {
      url: "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(headersOf(init)).toEqual({
      "content-type": "application/json",
      "x-api-key": "sk-ant",
    });
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });

    const openai: AiServiceConfig = { id: "o1", kind: "openai" };
    await backend.saveKey(openai, "sk-oa");
    await backend.send(openai, {
      url: "https://api.openai.com/v1/models",
      method: "GET",
      headers: {},
    });
    expect(headersOf(fetch.mock.calls[1]?.[1])).toEqual({
      authorization: "Bearer sk-oa",
    });

    const ollama: AiServiceConfig = { id: "l1", kind: "ollama" };
    await backend.send(ollama, {
      url: "http://localhost:11434/v1/models",
      method: "GET",
      headers: {},
    });
    expect(headersOf(fetch.mock.calls[2]?.[1])).toEqual({});
  });

  it("never sends a key to another address", async () => {
    const { fetch, backend } = setup();
    await backend.saveKey(claude, "sk-ant");
    await expect(
      backend.send(claude, {
        url: "https://api.anthropic.com/v1.evil.example/x",
        method: "GET",
        headers: {},
      }),
    ).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("signs in at OpenRouter in a popup and keeps the key it hands out", async () => {
    const session = new MemoryStorage();
    const popup = { location: { href: "" }, close: vi.fn() };
    const open = vi.fn(() => popup);
    const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      () => Promise.resolve(Response.json({ key: "sk-or-v1-abc" })),
    );
    const backend = createWebAiBackend({
      session,
      local: undefined,
      redirectUrl: "https://app.example/redirect.html",
      fetch: fetch as unknown as typeof globalThis.fetch,
      window: { open } as unknown as Window,
    });
    const service: AiServiceConfig = { id: "r1", kind: "openrouter" };
    const signedIn = backend.signIn.openrouter(service);
    await vi.waitFor(() => {
      expect(popup.location.href).toMatch(/^https:\/\/openrouter\.ai\/auth\?/);
    });
    const url = new URL(popup.location.href);
    expect(url.searchParams.get("callback_url")).toBe(
      "https://app.example/redirect.html?to=openrouter",
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    const challenge = url.searchParams.get("code_challenge");

    const channel = new BroadcastChannel(OPENROUTER_CHANNEL);
    channel.postMessage({ code: "the-code" });
    channel.close();
    await signedIn;

    const [exchangeUrl, init] = fetch.mock.calls[0] ?? [];
    expect(exchangeUrl).toBe("https://openrouter.ai/api/v1/auth/keys");
    const body = JSON.parse(init?.body as string) as {
      code: string;
      code_verifier: string;
    };
    expect(body.code).toBe("the-code");
    // The verifier hashes to the challenge sent before.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body.code_verifier),
    );
    const encoded = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(encoded).toBe(challenge);
    expect(session.getItem("a0.ai.key.r1")).toBe("sk-or-v1-abc");
    expect(popup.close).toHaveBeenCalled();
  });
});
