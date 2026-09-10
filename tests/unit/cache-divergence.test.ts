import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TripCache } from "../../src/cache/trip-cache.ts";
import type { Json0Op } from "../../src/ot/apply.ts";
import type { RestClient } from "../../src/transport/rest.ts";
import { ShareDBClient, type ShareDBPool } from "../../src/transport/sharedb.ts";

/**
 * These cover the loop that produced real duplicates on a live trip: a write
 * lands, the cache serves a stale snapshot, the agent concludes the write
 * failed and repeats it.
 */

class FakeShareDBClient extends EventEmitter {
  public version = 1;
  public isSubscribed = true;
  public subscribeCalled = 0;

  async subscribe() {
    this.subscribeCalled++;
    return {
      title: "Test Trip",
      itinerary: { sections: [{ id: 1, blocks: [] }] },
    };
  }

  /** A remote op the cache can apply cleanly. */
  emitRemoteOp(ops: Json0Op[]): void {
    this.version += 1;
    this.emit("remoteOp", ops, this.version);
  }
}

function makeCache(client: FakeShareDBClient): TripCache {
  const rest = {
    getTripWithResources: async () => ({ geos: [] }),
  } as unknown as RestClient;
  const pool = {
    get: () => client,
    has: () => true,
  } as unknown as ShareDBPool;
  return new TripCache(rest, pool);
}

describe("TripCache freshness", () => {
  it("serves the cached snapshot while it matches the live version", async () => {
    const client = new FakeShareDBClient();
    const cache = makeCache(client);

    await cache.get("tripA");
    await cache.get("tripA");

    expect(client.subscribeCalled).toBe(1);
  });

  it("stays in sync through a remote op it can apply", async () => {
    const client = new FakeShareDBClient();
    const cache = makeCache(client);

    await cache.get("tripA");
    client.emitRemoteOp([{ p: ["title"], od: "Test Trip", oi: "Renamed" }]);
    const trip = await cache.get("tripA");

    expect(client.subscribeCalled).toBe(1);
    expect(trip.title).toBe("Renamed");
  });

  it("refetches when the live version moved on without the cache", async () => {
    const client = new FakeShareDBClient();
    const cache = makeCache(client);

    await cache.get("tripA");
    // A frame the cache never saw — a dropped message, or a reconnect.
    client.version += 1;
    await cache.get("tripA");

    expect(client.subscribeCalled).toBe(2);
  });

  it("refetches after an op it could not apply, rather than serving a gap", async () => {
    const client = new FakeShareDBClient();
    const cache = makeCache(client);

    await cache.get("tripA");
    client.version += 1;
    // An unknown subtype: previously skipped, with the version recorded anyway.
    client.emit("remoteOp", [{ p: ["itinerary"], t: "future-type", o: {} }], client.version);
    await cache.get("tripA");

    expect(client.subscribeCalled).toBe(2);
  });

  it("refetches when the client is no longer subscribed", async () => {
    const client = new FakeShareDBClient();
    const cache = makeCache(client);

    await cache.get("tripA");
    client.isSubscribed = false;
    await cache.get("tripA");

    expect(client.subscribeCalled).toBe(2);
  });
});

const config = {
  cookieHeader: "connect.sid=test",
  baseUrl: "https://wanderlog.test",
  wsBaseUrl: "wss://wanderlog.test",
  userAgent: "wanderdog-test",
} as never;

function internals(client: ShareDBClient) {
  return client as unknown as {
    sessionId?: string;
    pendingOps: Map<
      number,
      { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
    >;
    handleFrame: (
      frame: Record<string, unknown>,
      handshakeTimeout: NodeJS.Timeout,
      connectResolve: () => void,
    ) => void;
  };
}

function deliver(client: ShareDBClient, frame: Record<string, unknown>): void {
  internals(client).handleFrame(frame, setTimeout(() => {}, 60_000), () => {});
}

describe("ShareDBClient own-op echo", () => {
  it("acks our op once and ignores a second copy of it", async () => {
    const client = new ShareDBClient(config, "tripA");
    internals(client).sessionId = "sess-1";

    const remote: Json0Op[][] = [];
    client.on("remoteOp", (ops) => remote.push(ops));

    const acked = new Promise<void>((resolve, reject) => {
      internals(client).pendingOps.set(7, {
        resolve,
        reject,
        timer: setTimeout(() => {}, 60_000),
      });
    });

    const op = [{ p: ["itinerary", "sections", 0, "blocks", 0], li: { id: 1 } }];
    deliver(client, { a: "op", src: "sess-1", seq: 7, v: 4, op });
    await acked;
    expect(client.version).toBe(5);

    // The same op again. Applying it a second time would duplicate the block.
    deliver(client, { a: "op", src: "sess-1", seq: 7, v: 5, op });

    expect(remote).toHaveLength(0);
    expect(client.version).toBe(6);
  });

  it("still emits ops from other editors", () => {
    const client = new ShareDBClient(config, "tripA");
    internals(client).sessionId = "sess-1";

    const remote: Json0Op[][] = [];
    client.on("remoteOp", (ops) => remote.push(ops));

    deliver(client, {
      a: "op",
      src: "someone-else",
      v: 9,
      op: [{ p: ["title"], od: "a", oi: "b" }],
    });

    expect(remote).toHaveLength(1);
    expect(client.version).toBe(10);
  });
});
