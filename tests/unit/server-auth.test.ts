import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../../src/context.ts";
import { requireAuth } from "../../src/server.ts";

const successResponse = {
  content: [{ type: "text" as const, text: "ok" }],
};

function createContext(getUser: ReturnType<typeof vi.fn>, authenticated = false): AppContext {
  return {
    authenticated,
    rest: { getUser } as unknown as AppContext["rest"],
  } as AppContext;
}

describe("requireAuth", () => {
  it("does not probe again after startup authentication succeeds", async () => {
    const getUser = vi.fn();
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser, true), handler);

    await expect(guarded({})).resolves.toEqual(successResponse);
    expect(getUser).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("recovers a valid session after the startup probe failed", async () => {
    const getUser = vi.fn().mockResolvedValue({ id: 42, username: "traveler" });
    const ctx = createContext(getUser);
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(ctx, handler);

    await expect(guarded({})).resolves.toEqual(successResponse);
    expect(getUser).toHaveBeenCalledOnce();
    expect(ctx.authenticated).toBe(true);
    expect(ctx.userId).toBe(42);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("preserves the authentication error when the retry fails", async () => {
    const getUser = vi.fn().mockRejectedValue(new Error("secret transport detail"));
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser), handler);

    const response = await guarded({});

    expect(response).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining("Authentication required") }],
    });
    expect(response.content[0]?.text).not.toContain("secret transport detail");
    expect(handler).not.toHaveBeenCalled();
  });

  it("shares one in-flight retry across concurrent tool calls", async () => {
    let resolveUser: ((user: { id: number; username: string }) => void) | undefined;
    const getUser = vi.fn(
      () =>
        new Promise<{ id: number; username: string }>((resolve) => {
          resolveUser = resolve;
        }),
    );
    const ctx = createContext(getUser);
    const firstHandler = vi.fn().mockResolvedValue(successResponse);
    const secondHandler = vi.fn().mockResolvedValue(successResponse);

    const firstCall = requireAuth(ctx, firstHandler)({});
    const secondCall = requireAuth(ctx, secondHandler)({});

    expect(getUser).toHaveBeenCalledOnce();
    resolveUser?.({ id: 7, username: "traveler" });
    await expect(Promise.all([firstCall, secondCall])).resolves.toEqual([
      successResponse,
      successResponse,
    ]);
    expect(firstHandler).toHaveBeenCalledOnce();
    expect(secondHandler).toHaveBeenCalledOnce();
  });

  it("re-probes once the cached failure has aged out", async () => {
    vi.useFakeTimers();
    try {
      const getUser = vi
        .fn()
        .mockRejectedValueOnce(new Error("transient network blip"))
        .mockResolvedValue({ id: 9, username: "traveler" });
      const ctx = createContext(getUser);
      const handler = vi.fn().mockResolvedValue(successResponse);
      const guarded = requireAuth(ctx, handler);

      await guarded({});
      expect(getUser).toHaveBeenCalledOnce();

      // A blip must not brick the session for the life of the process.
      vi.advanceTimersByTime(30_001);
      await expect(guarded({})).resolves.toEqual(successResponse);
      expect(getUser).toHaveBeenCalledTimes(2);
      expect(ctx.authenticated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels an unexpected throw from a tool instead of letting it escape", async () => {
    const getUser = vi.fn();
    const handler = vi.fn().mockRejectedValue(new TypeError("blocks is not iterable"));
    const guarded = requireAuth(createContext(getUser, true), handler);

    const response = await guarded({});

    expect(response.isError).toBe(true);
    expect(response.content[0]!.text).toContain("blocks is not iterable");
    expect(response.content[0]!.text).toContain("TypeError");
  });

  it("caches a failed retry to prevent repeated invalid-cookie probes", async () => {
    const getUser = vi.fn().mockRejectedValue(new Error("invalid cookie"));
    const handler = vi.fn().mockResolvedValue(successResponse);
    const guarded = requireAuth(createContext(getUser), handler);

    await guarded({});
    await guarded({});

    expect(getUser).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });
});
