import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareDBClient } from "../../src/transport/sharedb.ts";
import { WanderlogAuthError, WanderlogError } from "../../src/errors.ts";

/**
 * Fake `ws` so the transport's event listeners can be driven directly. This is
 * the only way to reproduce the 0.3.1 process-killer: a throw inside a
 * WebSocket event listener, which the surrounding promise cannot catch.
 *
 * EventEmitter.emit propagates a listener throw synchronously to the caller,
 * so `expect(() => socket.emit("open")).not.toThrow()` stands in for "does not
 * become an uncaught exception inside ws".
 */
const harness = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];

  // A hand-rolled emitter rather than node:events: vi.hoisted runs before the
  // module's imports are initialised, so nothing imported is available here.
  class FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = 0;
    readonly sent: string[] = [];
    terminated = false;
    private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();

    constructor(
      readonly url: string,
      readonly options: unknown,
    ) {
      sockets.push(this);
    }

    on(event: string, listener: (...args: any[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
      return this;
    }

    /** Propagates a listener throw to the caller, the way ws's internals do. */
    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 2;
    }

    /** Deliberately does not emit "close", so tests can isolate one path. */
    terminate(): void {
      this.terminated = true;
      this.readyState = 3;
    }

    /** Open the socket and fire the handler the way ws does. */
    open(): void {
      this.readyState = 1;
      this.emit("open");
    }

    deliver(frame: unknown): void {
      this.emit("message", Buffer.from(JSON.stringify(frame)));
    }
  }

  return { sockets, FakeSocket };
});

vi.mock("ws", () => ({ default: harness.FakeSocket }));

const config = {
  cookieHeader: "connect.sid=s%3ASENTINEL-COOKIE.signaturepart",
  baseUrl: "https://wanderlog.test",
  wsBaseUrl: "wss://wanderlog.test",
  userAgent: "wanderdog-test",
} as any;

function newClient(tripKey = "tripA"): ShareDBClient {
  return new ShareDBClient(config, tripKey);
}

/** Reach past `private` without weakening the production types. */
function internals(client: ShareDBClient) {
  return client as unknown as {
    ws?: { readyState: number };
    subscribed: boolean;
    handshakeComplete: boolean;
    reconnectAttempts: number;
    reconnectTimer?: NodeJS.Timeout;
    pendingOps: Map<
      number,
      { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
    >;
    doConnect: () => Promise<void>;
    scheduleReconnect: (resubscribe: boolean) => void;
    failAllPending: (err: Error) => void;
    handleFrame: (
      frame: Record<string, unknown>,
      handshakeTimeout: NodeJS.Timeout,
      connectResolve: () => void,
    ) => void;
  };
}

/** Park a pending op so a rejection frame has something to fail. */
function parkPendingOp(client: ShareDBClient, seq: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    internals(client).pendingOps.set(seq, {
      resolve,
      reject,
      timer: setTimeout(() => {}, 60_000),
    });
  });
}

function deliverFrame(client: ShareDBClient, frame: Record<string, unknown>): void {
  internals(client).handleFrame(frame, setTimeout(() => {}, 60_000), () => {});
}

beforeEach(() => {
  harness.sockets.length = 0;
});

describe("ShareDBClient reconnect logic", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stops reconnecting immediately when encountering WanderlogAuthError", async () => {
    const client = newClient();

    const rejectErr = new WanderlogAuthError();
    const doConnectSpy = vi.spyOn(client as any, "doConnect").mockRejectedValue(rejectErr);
    const failAllPendingSpy = vi
      .spyOn(client as any, "failAllPending")
      .mockImplementation(() => {});

    // Trigger scheduleReconnect
    internals(client).scheduleReconnect(false);

    // Initial reconnect is scheduled, wait for the timer to fire (delay is 1000 * 2^0 = 1000ms)
    expect(internals(client).reconnectTimer).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000);

    // doConnect should have been called
    expect(doConnectSpy).toHaveBeenCalledTimes(1);

    // The timer should be cleared/undefined, and no further reconnect scheduled
    expect(internals(client).reconnectTimer).toBeUndefined();
    expect(failAllPendingSpy).toHaveBeenCalledWith(rejectErr);

    // Advance time further to make sure no more retries fire
    await vi.advanceTimersByTimeAsync(30000);
    expect(doConnectSpy).toHaveBeenCalledTimes(1);
  });

  it("deduplicates multiple scheduleReconnect calls using reconnectTimer", () => {
    const client = newClient();

    // Stub doConnect so it doesn't do real ws
    vi.spyOn(client as any, "doConnect").mockResolvedValue(undefined);

    // First call should schedule reconnect
    internals(client).scheduleReconnect(false);
    const initialTimer = internals(client).reconnectTimer;
    expect(initialTimer).toBeDefined();

    // Second call while timer is active should do nothing and keep the same timer
    internals(client).scheduleReconnect(false);
    expect(internals(client).reconnectTimer).toBe(initialTimer);
  });

  it("resets reconnectAttempts back to 0 on a successful connection", async () => {
    const client = newClient();

    const doConnectSpy = vi.spyOn(client as any, "doConnect").mockResolvedValue(undefined);
    internals(client).reconnectAttempts = 3;

    internals(client).scheduleReconnect(false);
    await vi.advanceTimersByTimeAsync(8000); // 1000 * 2^3 = 8000ms

    expect(doConnectSpy).toHaveBeenCalledTimes(1);
    expect(internals(client).reconnectAttempts).toBe(0);
  });

  it("logs a warning after N consecutive failures (reconnectAttempts > 5)", async () => {
    const client = newClient();

    // Mock failures
    vi.spyOn(client as any, "doConnect").mockRejectedValue(
      new Error("Transient connection error"),
    );
    const consoleWarnSpy = vi.spyOn(console, "warn");

    // Set attempts to 5, so the next attempt increments it to 6 and warns
    internals(client).reconnectAttempts = 5;

    internals(client).scheduleReconnect(false);

    expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
    expect(consoleWarnSpy.mock.calls[0]![0]).toContain(
      "Reconnection has failed 6 times consecutively",
    );
  });

  it("does not leave an unhandled rejection when resubscribe fails after reconnect", async () => {
    const client = newClient();
    vi.spyOn(client as any, "doConnect").mockResolvedValue(undefined);
    vi.spyOn(client, "subscribe").mockRejectedValue(
      new WanderlogError("Subscribe timeout", "subscribe_timeout"),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      internals(client).scheduleReconnect(true);
      await vi.advanceTimersByTimeAsync(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
      // The failure is retried rather than swallowed.
      expect(internals(client).reconnectTimer).toBeDefined();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

/**
 * Regression suite for the crash reported against 0.3.1: the server answered 73
 * tool calls, idled, then died with "WebSocket is not open — cannot send frame"
 * thrown out of the ws.on("open") handler.
 */
describe("ShareDBClient — a WebSocket listener never throws into the event loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a handshake send failure on a closing socket rejects the connect promise instead of throwing", async () => {
    const client = newClient();
    const attempt = internals(client).doConnect();
    const rejects = expect(attempt).rejects.toMatchObject({ code: "ws_not_open" });

    const socket = harness.sockets[0]!;
    // Reached "open" but already tearing down — exactly the state in which
    // send() throws.
    socket.readyState = harness.FakeSocket.CLOSING;

    expect(() => socket.emit("open")).not.toThrow();
    await rejects;
    expect(socket.sent).toHaveLength(0);
  });

  it("sends the handshake on its own socket, not on whichever socket is current", async () => {
    const client = newClient();

    // Attempt 1 opens socket A. A second doConnect (the reconnect race)
    // reassigns this.ws to socket B while B is still CONNECTING.
    const first = internals(client).doConnect();
    const second = internals(client).doConnect();
    const [a, b] = harness.sockets;
    expect(b!.readyState).toBe(harness.FakeSocket.CONNECTING);
    expect(internals(client).ws).toBe(b);

    // Pre-fix this threw ws_not_open, because send() consulted this.ws (= B).
    expect(() => a!.open()).not.toThrow();
    expect(JSON.parse(a!.sent[0]!)).toMatchObject({ a: "hs", protocol: 1 });

    // B completes its own handshake; A settles separately.
    b!.open();
    b!.deliver({ a: "hs", id: "session-b", protocol: 1, protocolMinor: 2 });
    await expect(second).resolves.toBeUndefined();

    a!.emit("close", 1006);
    await expect(first).rejects.toMatchObject({ code: "ws_closed" });
  });

  it("a stale socket's close event does not tear down the live connection", async () => {
    const client = newClient();
    const first = internals(client).doConnect();
    const second = internals(client).doConnect();
    const [a, b] = harness.sockets;

    b!.open();
    b!.deliver({ a: "hs", id: "session-b", protocol: 1, protocolMinor: 2 });
    await expect(second).resolves.toBeUndefined();
    internals(client).subscribed = true;

    // Socket A finally dies. It must not clear the live socket's state or
    // schedule a reconnect on its behalf.
    expect(() => a!.emit("close", 1006)).not.toThrow();
    await expect(first).rejects.toMatchObject({ code: "ws_closed" });

    expect(internals(client).subscribed).toBe(true);
    expect(internals(client).handshakeComplete).toBe(true);
    expect(internals(client).ws).toBe(b);
    expect(internals(client).reconnectTimer).toBeUndefined();
  });

  it("a throwing remoteOp listener does not escape the message handler", async () => {
    const client = newClient();
    const attempt = internals(client).doConnect();
    const socket = harness.sockets[0]!;
    socket.open();
    socket.deliver({ a: "hs", id: "session-a", protocol: 1, protocolMinor: 2 });
    await attempt;

    client.on("remoteOp", () => {
      throw new Error("listener blew up");
    });

    expect(() =>
      socket.deliver({
        a: "op",
        c: "TripPlans",
        d: "tripA",
        v: 4,
        op: [{ p: ["title"], od: "a", oi: "b" }],
      }),
    ).not.toThrow();
  });
});

describe("ShareDBClient handshake retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a handshake timeout and succeeds on the second socket", async () => {
    const client = newClient();
    const connecting = client.connect();

    harness.sockets[0]!.open();
    // No "hs" ack ever arrives — the 10s handshake timeout fires.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.sockets[0]!.terminated).toBe(true);

    await vi.advanceTimersByTimeAsync(250); // first backoff step
    expect(harness.sockets).toHaveLength(2);

    harness.sockets[1]!.open();
    harness.sockets[1]!.deliver({ a: "hs", id: "s2", protocol: 1, protocolMinor: 2 });
    await expect(connecting).resolves.toBeUndefined();
  });

  it("gives up after the bounded number of retries and reports ws_timeout", async () => {
    const client = newClient();
    const connecting = client.connect();
    const rejects = expect(connecting).rejects.toMatchObject({ code: "ws_timeout" });

    // Three attempts total, with 250ms and 1000ms backoff between them.
    for (const backoff of [250, 1_000, 0]) {
      harness.sockets.at(-1)!.open();
      await vi.advanceTimersByTimeAsync(10_000);
      if (backoff) await vi.advanceTimersByTimeAsync(backoff);
    }
    await rejects;
    expect(harness.sockets).toHaveLength(3);
  });

  it("does not retry an auth rejection", async () => {
    const client = newClient();
    const connecting = client.connect();
    const rejects = expect(connecting).rejects.toBeInstanceOf(WanderlogAuthError);

    harness.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    await rejects;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it("does not retry a protocol-level upgrade rejection", async () => {
    const client = newClient();
    const connecting = client.connect();
    const rejects = expect(connecting).rejects.toMatchObject({
      code: "ws_upgrade_failed",
    });

    harness.sockets[0]!.emit("unexpected-response", {}, { statusCode: 418 });
    await rejects;

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.sockets).toHaveLength(1);
  });

  it("retries a 5xx upgrade failure, which is transient", async () => {
    const client = newClient();
    const connecting = client.connect();

    harness.sockets[0]!.emit("unexpected-response", {}, { statusCode: 503 });
    await vi.advanceTimersByTimeAsync(250);
    expect(harness.sockets).toHaveLength(2);

    harness.sockets[1]!.open();
    harness.sockets[1]!.deliver({ a: "hs", id: "s2", protocol: 1, protocolMinor: 2 });
    await expect(connecting).resolves.toBeUndefined();
  });

  it("shares one in-flight attempt between concurrent callers", async () => {
    const client = newClient();
    const a = client.connect();
    const b = client.connect();
    expect(harness.sockets).toHaveLength(1);

    harness.sockets[0]!.open();
    harness.sockets[0]!.deliver({ a: "hs", id: "s1", protocol: 1, protocolMinor: 2 });
    await Promise.all([a, b]);
  });
});

describe("ShareDBClient transport error classification", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("distinguishes a dead socket from an expired cookie", async () => {
    const authClient = newClient();
    const authAttempt = authClient.connect();
    const authRejects = expect(authAttempt).rejects.toMatchObject({
      code: "auth_expired",
    });
    harness.sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    await authRejects;

    const deadClient = newClient("tripB");
    const deadAttempt = internals(deadClient).doConnect();
    const deadRejects = expect(deadAttempt).rejects.toMatchObject({
      code: "ws_not_open",
    });
    harness.sockets.at(-1)!.readyState = harness.FakeSocket.CLOSED;
    harness.sockets.at(-1)!.emit("open");
    await deadRejects;
  });

  it("classifies a socket-level failure as a retryable network error", async () => {
    const client = newClient();
    const attempt = internals(client).doConnect();
    const rejects = expect(attempt).rejects.toMatchObject({ code: "network" });
    harness.sockets[0]!.emit("error", new Error("socket hang up"));
    await rejects;
  });

  it("carries a hint and follow-ups on a closed-socket error", async () => {
    const client = newClient();
    const attempt = internals(client).doConnect();
    const captured = attempt.catch((err: WanderlogError) => err);
    harness.sockets[0]!.emit("close", 1006);
    const err = await captured;
    expect(err).toBeInstanceOf(WanderlogError);
    expect(err.code).toBe("ws_closed");
    expect(err.hint).toBeTruthy();
    expect(err.toUserMessage()).toContain("Next steps:");
  });

  it("maps a 4001 rejection frame to rate_limited and others to ws_rejected", async () => {
    const client = newClient();
    const rate = parkPendingOp(client, 1);
    deliverFrame(client, { code: 4001, message: "Too many requests" });
    await expect(rate).rejects.toMatchObject({ code: "rate_limited" });

    const other = parkPendingOp(client, 2);
    deliverFrame(client, { code: 4999, message: "nope" });
    await expect(other).rejects.toMatchObject({ code: "ws_rejected" });
  });
});

describe("ShareDBClient — cookie never reaches an error surface", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const fragments = ["SENTINEL-COOKIE", "signaturepart", config.cookieHeader];

  function assertClean(err: WanderlogError): void {
    for (const surface of [err.message, err.toUserMessage(), err.stack ?? ""]) {
      for (const fragment of fragments) {
        expect(surface).not.toContain(fragment);
      }
    }
  }

  it("does not echo the cookie when the socket reports it back in an error", async () => {
    const client = newClient();
    const attempt = internals(client).doConnect();
    const captured = attempt.catch((err: WanderlogError) => err);
    harness.sockets[0]!.emit(
      "error",
      new Error(`handshake failed with Cookie: ${config.cookieHeader}`),
    );
    assertClean(await captured);
  });

  it("does not echo the cookie when a server error frame contains it", async () => {
    const client = newClient();
    const pending = parkPendingOp(client, 1);
    const captured = pending.catch((err: WanderlogError) => err);
    deliverFrame(client, {
      error: { message: `bad session ${config.cookieHeader}` },
    });
    assertClean((await captured) as unknown as WanderlogError);
  });

  it("does not put the cookie in the connection URL", () => {
    const client = newClient();
    void internals(client)
      .doConnect()
      .catch(() => {});
    expect(harness.sockets[0]!.url).not.toContain("SENTINEL-COOKIE");
  });
});
