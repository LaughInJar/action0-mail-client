// @vitest-environment node
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaticAuthSession } from "../../auth/staticSession";
import { isMailError } from "../../core/errors";
import { GRAPH_BASE, GraphHttp, type BatchRequest } from "./http";

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

const url = (path: string) => `${GRAPH_BASE}${path}`;

function client(auth = new StaticAuthSession("signed-in", "token-123")) {
  const waits: number[] = [];
  const graph = new GraphHttp({
    auth,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
    random: () => 0,
  });
  return { auth, graph, waits };
}

describe("GraphHttp", () => {
  it("sends the token and asks for immutable ids (plus extra preferences)", async () => {
    let seen: Request | undefined;
    server.use(
      http.get(url("me/messages"), ({ request }) => {
        seen = request;
        return HttpResponse.json({ value: [] });
      }),
    );
    await client().graph.get(
      "me/messages",
      { $top: 5, $select: "id" },
      undefined,
      "odata.maxpagesize=200",
    );
    expect(seen?.headers.get("Authorization")).toBe("Bearer token-123");
    expect(seen?.headers.get("Prefer")).toBe(
      'IdType="ImmutableId", odata.maxpagesize=200',
    );
    expect(new URL(seen?.url ?? "").searchParams.get("$top")).toBe("5");
  });

  it("only follows links to Graph", async () => {
    const error = await client()
      .graph.get(new URL("https://evil.example/v1.0/me"))
      .catch((e: unknown) => e);
    expect(isMailError(error, "provider")).toBe(true);
  });

  it("waits as long as Graph asks when throttled", async () => {
    let calls = 0;
    server.use(
      http.get(url("me"), () => {
        calls++;
        return calls === 1
          ? new HttpResponse(null, {
              status: 429,
              headers: { "Retry-After": "7" },
            })
          : HttpResponse.json({ mail: "max@contoso.com" });
      }),
    );
    const { graph, waits } = client();
    expect(await graph.get<{ mail: string }>("me")).toEqual({
      mail: "max@contoso.com",
    });
    expect(waits).toEqual([7000]);
  });

  it("marks the session expired on 401", async () => {
    server.use(
      http.get(url("me"), () =>
        HttpResponse.json(
          { error: { code: "InvalidAuthenticationToken" } },
          { status: 401 },
        ),
      ),
    );
    const { graph, auth } = client();
    const error = await graph.get("me").catch((e: unknown) => e);
    expect(isMailError(error, "auth-required")).toBe(true);
    expect(auth.status).toBe("expired");
  });

  it("batches 20 requests per call, keeps the order and retries throttled ones", async () => {
    const calls: number[] = [];
    let throttled = false;
    server.use(
      http.post(url("$batch"), async ({ request }) => {
        const { requests } = (await request.json()) as {
          requests: {
            id: string;
            url: string;
            headers: Record<string, string>;
          }[];
        };
        calls.push(requests.length);
        return HttpResponse.json({
          responses: requests.map(({ id, url: path, headers }) => {
            expect(headers.Prefer).toBe('IdType="ImmutableId"');
            if (path === "/me/messages/m3" && !throttled) {
              throttled = true;
              return { id, status: 429, headers: { "Retry-After": "2" } };
            }
            if (path === "/me/messages/m5")
              return {
                id,
                status: 404,
                body: { error: { code: "ErrorItemNotFound", message: "Gone" } },
              };
            return { id, status: 200, body: { id: path.split("/").pop() } };
          }),
        });
      }),
    );
    const requests: BatchRequest[] = Array.from({ length: 25 }, (_, i) => ({
      method: "GET",
      path: `me/messages/m${String(i)}`,
    }));
    const { graph, waits } = client();
    const results = await graph.batch<{ id: string }>(requests);
    expect(calls).toEqual([20, 1, 5]);
    expect(waits).toEqual([2000]);
    expect(results).toHaveLength(25);
    expect(results[3]).toEqual({ ok: true, body: { id: "m3" } });
    expect(results[24]).toEqual({ ok: true, body: { id: "m24" } });
    const missing = results[5];
    expect(missing?.ok).toBe(false);
    expect(missing?.ok === false && missing.error.code).toBe("not-found");
  });

  it("uploads chunks without the token, with their byte range", async () => {
    let seen: Request | undefined;
    server.use(
      http.put("https://upload.outlook.test/s/1", ({ request }) => {
        seen = request;
        return new HttpResponse(null, { status: 201 });
      }),
    );
    await client().graph.putChunk(
      "https://upload.outlook.test/s/1",
      new Blob(["abcd"]),
      { start: 10, total: 14 },
    );
    expect(seen?.headers.has("Authorization")).toBe(false);
    expect(seen?.headers.get("Content-Range")).toBe("bytes 10-13/14");
  });
});
