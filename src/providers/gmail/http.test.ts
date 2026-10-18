// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import { isMailError } from "../../core/errors";
import { GMAIL_API_BASE, GmailHttp } from "./http";

const server = setupServer();
beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const url = (path: string) => `${GMAIL_API_BASE}${path}`;
const noSleep = () => Promise.resolve();

function client(auth = new StaticAuthSession("signed-in", "token-123")) {
  return {
    auth,
    http: new GmailHttp({ auth, sleep: noSleep, random: () => 0 }),
  };
}

describe("GmailHttp", () => {
  it("sends the bearer token and repeated array parameters", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(url("messages"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ ok: true });
      }),
    );
    await client().http.get("messages", {
      labelIds: ["INBOX", "Label_1"],
      maxResults: 50,
      pageToken: undefined,
    });
    expect(seen?.headers.get("Authorization")).toBe("Bearer token-123");
    const params = new URL(seen?.url ?? "").searchParams;
    expect(params.getAll("labelIds")).toEqual(["INBOX", "Label_1"]);
    expect(params.get("maxResults")).toBe("50");
    expect(params.has("pageToken")).toBe(false);
  });

  it("marks the session expired on 401", async () => {
    server.use(
      http.get(url("labels"), () => new HttpResponse(null, { status: 401 })),
    );
    const { auth, http: gmail } = client();
    const error: unknown = await gmail.get("labels").catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(auth.status).toBe("expired");
  });

  it("retries 429 and 5xx, then succeeds", async () => {
    const statuses = [429, 503];
    server.use(
      http.get(url("labels"), () => {
        const status = statuses.shift();
        return status === undefined
          ? HttpResponse.json({ labels: [] })
          : HttpResponse.json(
              { error: { message: "busy" } },
              { status, headers: { "Retry-After": "0" } },
            );
      }),
    );
    await expect(client().http.get("labels")).resolves.toEqual({ labels: [] });
    expect(statuses).toEqual([]);
  });

  it("retries rate-limit 403s but not other 403s", async () => {
    let calls = 0;
    server.use(
      http.get(url("labels"), () => {
        calls++;
        return HttpResponse.json(
          {
            error: {
              message: "slow down",
              errors: [{ reason: "userRateLimitExceeded" }],
            },
          },
          { status: 403 },
        );
      }),
      http.get(url("profile"), () =>
        HttpResponse.json(
          {
            error: {
              message: "forbidden",
              errors: [{ reason: "insufficientPermissions" }],
            },
          },
          { status: 403 },
        ),
      ),
    );
    const { http: gmail } = client();
    const rateLimited: unknown = await gmail
      .get("labels")
      .catch((e: unknown) => e);
    expect(calls).toBe(3);
    expect(isMailError(rateLimited, "rate-limited")).toBe(true);
    const forbidden: unknown = await gmail
      .get("profile")
      .catch((e: unknown) => e);
    expect(isMailError(forbidden, "provider")).toBe(true);
  });

  it("maps 404 to not-found", async () => {
    server.use(
      http.get(url("messages/x"), () =>
        HttpResponse.json({ error: { message: "nope" } }, { status: 404 }),
      ),
    );
    const error: unknown = await client()
      .http.get("messages/x")
      .catch((e: unknown) => e);
    expect(isMailError(error, "not-found")).toBe(true);
  });

  it("reports network errors after retrying", async () => {
    let calls = 0;
    server.use(
      http.get(url("labels"), () => {
        calls++;
        return HttpResponse.error();
      }),
    );
    const error: unknown = await client()
      .http.get("labels")
      .catch((e: unknown) => e);
    expect(isMailError(error, "network")).toBe(true);
    expect(calls).toBe(3);
  });

  it("doesn't call the API without a token", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const gmail = new GmailHttp({
      auth: new StaticAuthSession("expired"),
      fetch: fetchSpy,
    });
    const error: unknown = await gmail.get("labels").catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("limits concurrent requests", async () => {
    let active = 0;
    let peak = 0;
    server.use(
      http.get(url("messages/:id"), async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return HttpResponse.json({});
      }),
    );
    const gmail = new GmailHttp({
      auth: new StaticAuthSession(),
      maxConcurrent: 3,
    });
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => gmail.get(`messages/${i}`)),
    );
    expect(peak).toBe(3);
  });

  it("stops when aborted", async () => {
    server.use(
      http.get(url("labels"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return HttpResponse.json({});
      }),
    );
    const controller = new AbortController();
    const request = client().http.get("labels", undefined, controller.signal);
    controller.abort();
    await expect(request).rejects.toThrow();
  });

  it("POSTs JSON and accepts an empty response body", async () => {
    let seen:
      { method: string; type: string | null; body: unknown } | undefined;
    server.use(
      http.post(url("messages/batchModify"), async ({ request }) => {
        seen = {
          method: request.method,
          type: request.headers.get("Content-Type"),
          body: await request.json(),
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(
      client().http.post("messages/batchModify", { ids: ["a"] }),
    ).resolves.toBeUndefined();
    expect(seen).toEqual({
      method: "POST",
      type: "application/json",
      body: { ids: ["a"] },
    });
  });
});
