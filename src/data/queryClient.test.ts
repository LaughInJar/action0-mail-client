// @vitest-environment node
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../test/memoryStorage";
import { createPersistOptions, createQueryClient } from "./queryClient";

describe("query persistence", () => {
  it("is disabled without storage", () => {
    expect(createPersistOptions(undefined, "1")).toBeUndefined();
  });

  it("persists only successful queries marked with meta.persist", async () => {
    const options = createPersistOptions(new MemoryStorage(), "1");
    const shouldDehydrate = options?.dehydrateOptions?.shouldDehydrateQuery;
    expect(shouldDehydrate).toBeDefined();

    const client = createQueryClient();
    await client.query({
      queryKey: ["list"],
      queryFn: () => "rows",
      meta: { persist: true },
    });
    await client.query({
      queryKey: ["body"],
      queryFn: () => "secret mail body",
    });
    const cache = client.getQueryCache();
    const list = cache.find({ queryKey: ["list"] });
    const body = cache.find({ queryKey: ["body"] });
    expect(list && shouldDehydrate?.(list)).toBe(true);
    expect(body && shouldDehydrate?.(body)).toBe(false);
  });
});
