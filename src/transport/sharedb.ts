import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import WebSocket from "ws";
import type { Config } from "../config.js";
import {
  WanderlogAuthError,
  WanderlogError,
  WanderlogNetworkError,
} from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import type { TripPlan } from "../types.js";

export type { Json0Op };

type InitFrame = {
  a: "init";
  id: string;
  protocol: number;
  protocolMinor: number;
  type: string;
};

type HandshakeAckFrame = {
  a: "hs";
  id: string;
  protocol: number;
  protocolMinor: number;
  type: string;
};

type SubscribeAckFrame = {
  a: "s";
  c: string;
  d: string;
  data?: { v: number; data: TripPlan };
};

type OpFrame = {
  a: "op";
  c: string;
  d: string;
  v: number;
  seq?: number;
  src?: string;
  op?: Json0Op[];
};

type Frame = InitFrame | HandshakeAckFrame | SubscribeAckFrame | OpFrame;

const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Handshake retry backoff. A `ShareDB handshake timeout` has been observed to
 * clear on an immediate identical retry, so a short bounded wait beats
 * surfacing an error. Same shape as RATE_LIMIT_RETRY_DELAYS_MS in tools/shared.ts.
 */
const HANDSHAKE_RETRY_DELAYS_MS = [250, 1_000];

/**
 * Connect failures a retry can fix. Auth rejections and protocol-level upgrade
 * failures are excluded deliberately: retrying an expired cookie three times
 * only delays the same error by 1.25s.
 */
const TRANSIENT_CONNECT_CODES = new Set([
  "ws_timeout",
  "ws_not_open",
  "ws_closed",
  "network",
]);

function isTransientConnectError(err: unknown): boolean {
  return err instanceof WanderlogError && TRANSIENT_CONNECT_CODES.has(err.code);
}

const RETRY_FOLLOW_UP =
  "Retry the same tool call — the realtime connection is re-established on demand.";

function notOpenError(): WanderlogError {
  return new WanderlogError(
    "WebSocket is not open — cannot send frame",
    "ws_not_open",
    {
      hint: "The realtime connection to Wanderlog is not open. This is a dropped socket, not a credential problem.",
      followUps: [RETRY_FOLLOW_UP],
    },
  );
}

function closedError(code?: number): WanderlogError {
  return new WanderlogError(
    code === undefined ? "WebSocket closed" : `WebSocket closed (code ${code})`,
    "ws_closed",
    {
      hint: "Wanderlog closed the realtime connection before the operation finished. Reconnection is automatic.",
      followUps: [RETRY_FOLLOW_UP],
    },
  );
}

function handshakeTimeoutError(): WanderlogError {
  return new WanderlogError(
    `ShareDB handshake did not complete within ${HANDSHAKE_TIMEOUT_MS / 1000}s`,
    "ws_timeout",
    {
      hint: "The socket opened but Wanderlog never acknowledged the handshake. Usually transient; the cookie is fine or the upgrade would have been refused.",
      followUps: [RETRY_FOLLOW_UP],
    },
  );
}

function rateLimitedError(message: string): WanderlogError {
  return new WanderlogError(message, "rate_limited", {
    hint: "Wanderlog is throttling this session. Wait out the window rather than retrying immediately.",
    followUps: ["Wait about a minute, then retry the same tool call."],
  });
}

/** Classify an HTTP rejection of the WebSocket upgrade. */
function upgradeError(statusCode: number | undefined): WanderlogError {
  if (statusCode === 401 || statusCode === 403) return new WanderlogAuthError();
  if (statusCode === 429) {
    return rateLimitedError("Wanderlog rate-limited the WebSocket upgrade (429)");
  }
  if (statusCode !== undefined && statusCode >= 500) {
    // Server-side and worth retrying, so classify as network (transient).
    return new WanderlogNetworkError(`WebSocket upgrade failed: ${statusCode}`);
  }
  return new WanderlogError(
    `WebSocket upgrade failed: ${statusCode ?? "no status"}`,
    "ws_upgrade_failed",
    {
      hint: "Wanderlog refused the realtime connection outright. The request reached the server, so this is not a connectivity problem.",
      followUps: [
        "Report the upgrade status code to the user; retrying is unlikely to help.",
      ],
    },
  );
}

export interface ShareDBClient {
  /** Fired when a remote op (not one we submitted) is received. */
  on(event: "remoteOp", listener: (ops: Json0Op[], version: number) => void): this;
  on(event: "reconnected", listener: () => void): this;
  on(event: "closed", listener: (code: number) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

/**
 * ShareDB JSONv0 client bound to a single trip key.
 * Exposes subscribe() for the initial snapshot, submit() for outgoing ops
 * (with version tracking and ack waiting), and a `remoteOp` event for ops
 * pushed by the server from other clients.
 */
export class ShareDBClient extends EventEmitter {
  private ws?: WebSocket;
  private sessionId?: string;
  private handshakeComplete = false;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private seqCounter = 0;
  private snapshot?: TripPlan;
  private _version = 0;
  private subscribed = false;
  private subscribePending?: {
    resolve: (ack: SubscribeAckFrame) => void;
    reject: (err: Error) => void;
  };
  private readonly pendingOps = new Map<
    number,
    { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: Config,
    private readonly tripKey: string,
  ) {
    super();
  }

  get version(): number {
    return this._version;
  }

  get currentSnapshot(): TripPlan | undefined {
    return this.snapshot;
  }

  get isSubscribed(): boolean {
    return this.subscribed;
  }

  private url(): string {
    return `${this.config.wsBaseUrl}/api/tripPlans/wsOverall/${encodeURIComponent(
      this.tripKey,
    )}?clientSchemaVersion=2`;
  }

  /**
   * Strip the session cookie out of any message built from text we do not
   * control (socket errors, server error frames). Nothing should put it there
   * in the first place; this makes that a guarantee rather than a hope.
   */
  private redact(text: string): string {
    const cookie = this.config.cookieHeader;
    if (!cookie) return text;
    let out = text.split(cookie).join("[redacted]");
    const value = cookie.replace(/^[^=]*=/, "");
    if (value.length > 8) out = out.split(value).join("[redacted]");
    return out;
  }

  /**
   * ws reports DNS/TCP/TLS failures as plain Errors ("socket hang up",
   * ECONNREFUSED). Classify them as network so the retry loop treats them as
   * transient and the caller gets a hint instead of a bare string.
   */
  private socketError(err: unknown): WanderlogError {
    if (err instanceof WanderlogError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new WanderlogNetworkError(
      `WebSocket error: ${this.redact(message)}`,
    );
  }

  async connect(): Promise<void> {
    if (this.handshakeComplete) return;
    // One in-flight attempt per client. Without this, a reconnect timer and a
    // tool call can each open a socket and reassign this.ws, which is how the
    // stale-socket handshake race arose in the first place.
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectWithRetry();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = undefined;
    }
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (this.closedByUser) throw closedError();
      try {
        await this.doConnect();
        return;
      } catch (err) {
        if (
          attempt >= HANDSHAKE_RETRY_DELAYS_MS.length ||
          !isTransientConnectError(err)
        ) {
          throw err;
        }
        await new Promise((r) =>
          setTimeout(r, HANDSHAKE_RETRY_DELAYS_MS[attempt]),
        );
        attempt += 1;
      }
    }
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url(), {
        headers: {
          Cookie: this.config.cookieHeader,
          Origin: this.config.baseUrl,
          "User-Agent": this.config.userAgent,
        },
      });
      this.ws = ws;
      this.handshakeComplete = false;

      let settled = false;

      const handshakeTimeout = setTimeout(() => {
        finish(handshakeTimeoutError());
        this.closeQuietly(ws);
      }, HANDSHAKE_TIMEOUT_MS);

      /** Settle this attempt exactly once, whichever event gets there first. */
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeTimeout);
        if (err) reject(err);
        else resolve();
      };

      /**
       * Every listener below runs on the event loop, outside the await in
       * connect(). A throw there is an uncaught exception that takes the whole
       * MCP server process down (seen in 0.3.1: send() threw "WebSocket is not
       * open" from inside the open handler). Wrapping each body converts that
       * into a rejection of this attempt, or a stderr note if we already
       * settled.
       */
      const guard =
        <A extends unknown[]>(fn: (...args: A) => void) =>
        (...args: A): void => {
          try {
            fn(...args);
          } catch (err) {
            const wrapped = this.socketError(err);
            if (settled) {
              console.error(
                `[wanderdog] Ignored ${wrapped.code} raised in a WebSocket listener: ${wrapped.message}`,
              );
            } else {
              finish(wrapped);
            }
          }
        };

      ws.on(
        "open",
        guard(() => {
          // Send on `ws`, never on `this.ws`: a newer connect() may already
          // have replaced this.ws with a socket that is still CONNECTING, and
          // sending on that one throws out of this listener.
          this.sendOn(ws, { a: "hs", id: null, protocol: 1, protocolMinor: 2 });
        }),
      );

      ws.on(
        "message",
        guard((raw: WebSocket.RawData) => {
          // A superseded socket must not mutate current state.
          if (this.ws !== ws) return;
          const text = raw.toString();
          let msg: unknown;
          try {
            msg = JSON.parse(text);
          } catch {
            return;
          }
          if (!msg || typeof msg !== "object") return;
          this.handleFrame(msg as Frame & { error?: unknown }, handshakeTimeout, () =>
            finish(),
          );
        }),
      );

      ws.on(
        "close",
        guard((code: number) => {
          if (this.ws !== ws) {
            // Stale socket: settle its own attempt, touch nothing else.
            finish(closedError(code));
            return;
          }
          const wasSubscribed = this.subscribed;
          this.handshakeComplete = false;
          this.subscribed = false;
          this.ws = undefined;
          finish(closedError(code));
          this.failAllPending(closedError(code));
          this.emit("closed", code);
          if (!this.closedByUser && code !== 1000) {
            this.scheduleReconnect(wasSubscribed);
          }
        }),
      );

      ws.on(
        "unexpected-response",
        guard((_req: ClientRequest, res: IncomingMessage) => {
          finish(upgradeError(res.statusCode));
          // We handled the event, so ws will not tear the socket down for us.
          this.closeQuietly(ws);
        }),
      );

      ws.on(
        "error",
        guard((err: Error) => {
          finish(this.socketError(err));
        }),
      );
    });
  }

  private handleFrame(
    frame: Frame & { error?: unknown; seq?: number; code?: number; message?: string },
    handshakeTimeout: NodeJS.Timeout,
    connectResolve: () => void,
  ): void {
    // Server rejections arrive as bare {code, message} frames with no `a` and
    // no `seq` (observed: {code: 4001, message: "Too many requests"}). Without
    // this branch they fall through silently and the submit dies as an opaque
    // 10s timeout. No seq means we can't attribute it — fail everything.
    const bare = frame as { a?: string; code?: number; message?: string };
    if (bare.a === undefined && typeof bare.code === "number") {
      const detail = this.redact(
        `Wanderlog rejected the request (${bare.code}): ${bare.message ?? "unknown"}`,
      );
      this.failAllPending(
        bare.code === 4001
          ? rateLimitedError(detail)
          : new WanderlogError(detail, "ws_rejected", {
              hint: "Wanderlog refused this operation at the realtime layer. The connection itself is healthy.",
            }),
      );
      return;
    }

    if (frame.error) {
      const err = frame.error as string | { message?: string };
      const errMsg = this.redact(
        typeof err === "string" ? err : err.message ?? "unknown",
      );

      // If the error frame carries a seq, it belongs to a specific submit.
      // Fail only that one pending op, so concurrent/queued submits are not
      // collateral damage.
      if (typeof frame.seq === "number" && this.pendingOps.has(frame.seq)) {
        const pending = this.pendingOps.get(frame.seq)!;
        this.pendingOps.delete(frame.seq);
        clearTimeout(pending.timer);
        pending.reject(new WanderlogError(errMsg, "ws_error"));
        return;
      }

      // No seq, or unknown seq — fall back to failing everything, since we
      // can't safely attribute the error.
      this.failAllPending(new WanderlogError(errMsg, "ws_error"));
      return;
    }

    if (frame.a === "init") {
      this.sessionId = (frame as InitFrame).id;
      return;
    }

    if (frame.a === "hs" && !this.handshakeComplete) {
      this.handshakeComplete = true;
      clearTimeout(handshakeTimeout);
      this.reconnectAttempts = 0;
      const hs = frame as HandshakeAckFrame;
      if (!this.sessionId && hs.id) this.sessionId = hs.id;
      connectResolve();
      return;
    }

    if (frame.a === "s") {
      const pending = this.subscribePending;
      if (pending) {
        this.subscribePending = undefined;
        pending.resolve(frame as SubscribeAckFrame);
      }
      return;
    }

    if (frame.a === "op") {
      this.handleOpFrame(frame as OpFrame);
    }
  }

  private handleOpFrame(frame: OpFrame): void {
    const isOurs =
      this.sessionId !== undefined &&
      frame.src !== undefined &&
      frame.src === this.sessionId;
    const isOurAck =
      isOurs && frame.seq !== undefined && this.pendingOps.has(frame.seq);

    if (isOurAck) {
      const pending = this.pendingOps.get(frame.seq!)!;
      this.pendingOps.delete(frame.seq!);
      clearTimeout(pending.timer);
      this._version = frame.v + 1;
      pending.resolve();
      return;
    }

    if (isOurs) {
      // Our own op, arriving after we already acked and applied it locally.
      // The pendingOps check above is one-shot, so without this a second copy
      // of the frame would be treated as remote and applied twice — an `li`
      // insert applied twice duplicates a block in the cached snapshot.
      // Track the version, emit nothing.
      if (frame.op && frame.op.length > 0) this._version = frame.v + 1;
      return;
    }

    if (frame.op && frame.op.length > 0) {
      this._version = frame.v + 1;
      this.emit("remoteOp", frame.op, this._version);
    }
  }

  private failAllPending(err: Error): void {
    if (this.subscribePending) {
      this.subscribePending.reject(err);
      this.subscribePending = undefined;
    }
    for (const [seq, pending] of this.pendingOps) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pendingOps.delete(seq);
    }
  }

  private scheduleReconnect(resubscribe: boolean): void {
    if (this.reconnectTimer) return;

    const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;

    if (this.reconnectAttempts > 5) {
      console.warn(
        `[wanderdog] Reconnection has failed ${this.reconnectAttempts} times consecutively. Delaying next attempt by ${delay / 1000}s.`,
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closedByUser) return;
      // connect(), not doConnect(): it shares the in-flight attempt with any
      // concurrent tool call instead of opening a second socket.
      this.connect()
        .then(() => {
          this.reconnectAttempts = 0;
          if (resubscribe) {
            // A rejection here has no awaiter. Unhandled, it is a second way
            // to kill the process, so it is caught and turned into a retry.
            this.subscribe().then(
              () => this.emit("reconnected"),
              (err: unknown) => {
                console.error(
                  `[wanderdog] Resubscribe after reconnect failed: ${this.socketError(err).message}`,
                );
                this.scheduleReconnect(resubscribe);
              },
            );
          } else {
            this.emit("reconnected");
          }
        })
        .catch((err) => {
          if (err instanceof WanderlogAuthError) {
            console.error(
              `[wanderdog] Permanent reconnection failure: Auth expired. Stopping reconnection.`,
            );
            this.failAllPending(err);
            return;
          }
          this.scheduleReconnect(resubscribe);
        });
    }, delay);
  }

  /** Tear a socket down without letting ws's own throw escape. */
  private closeQuietly(ws: WebSocket): void {
    try {
      ws.terminate();
    } catch {
      // Already destroyed, or destroyed mid-handshake. Nothing to do.
    }
  }

  private send(obj: unknown): void {
    this.sendOn(this.ws, obj);
  }

  private sendOn(socket: WebSocket | undefined, obj: unknown): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw notOpenError();
    }
    socket.send(JSON.stringify(obj));
  }

  async subscribe(): Promise<TripPlan> {
    await this.connect();

    if (this.subscribed && this.snapshot) return this.snapshot;

    const ack = await new Promise<SubscribeAckFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.subscribePending) {
          this.subscribePending = undefined;
          reject(
            new WanderlogError("Subscribe timeout", "subscribe_timeout", {
              hint: "The handshake succeeded but Wanderlog never sent the trip snapshot.",
              followUps: [RETRY_FOLLOW_UP],
            }),
          );
        }
      }, 10_000);
      this.subscribePending = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      try {
        this.send({ a: "s", c: "TripPlans", d: this.tripKey });
      } catch (err) {
        // The socket died between connect() resolving and this send. Drop the
        // pending entry so a later frame can't resolve an abandoned promise.
        this.subscribePending = undefined;
        clearTimeout(timer);
        reject(err as Error);
      }
    });

    if (!ack.data) {
      throw new WanderlogError("Subscribe ack missing snapshot", "subscribe_failed");
    }

    this.snapshot = ack.data.data;
    this._version = ack.data.v;
    this.subscribed = true;
    return this.snapshot;
  }

  /**
   * Submit a JSON0 op array to the server. Resolves when the server acks.
   * Throws if not subscribed, if the WebSocket is closed, or on ack timeout.
   *
   * On successful ack, the local version is bumped to `frame.v + 1`.
   */
  async submit(ops: Json0Op[]): Promise<void> {
    if (!this.subscribed) {
      throw new WanderlogError(
        "Cannot submit op before subscribing to the trip",
        "not_subscribed",
      );
    }
    if (ops.length === 0) {
      throw new WanderlogError("Cannot submit an empty op array", "empty_op");
    }

    this.seqCounter += 1;
    const seq = this.seqCounter;
    const frame = {
      a: "op",
      c: "TripPlans",
      d: this.tripKey,
      v: this._version,
      seq,
      x: {},
      op: ops,
    };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingOps.has(seq)) {
          this.pendingOps.delete(seq);
          reject(
            new WanderlogError("Submit op timeout", "submit_timeout", {
              hint: "Wanderlog never acknowledged the change. It may or may not have been applied.",
              followUps: [
                "Call wanderlog_get_trip to check whether the change landed before retrying.",
              ],
            }),
          );
        }
      }, 10_000);
      this.pendingOps.set(seq, { resolve, reject, timer });
      try {
        this.send(frame);
      } catch (err) {
        // Send failed (e.g. WS closed between the isSubscribed check and now).
        // Clean up the pending entry and propagate immediately rather than
        // waiting 10s for the timeout to fire.
        this.pendingOps.delete(seq);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close(): void {
    this.closedByUser = true;
    this.subscribed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.failAllPending(new WanderlogError("Client closed", "ws_closed"));
    this.ws?.close();
  }
}

/**
 * Pool of ShareDBClient instances keyed by trip key. A single MCP server
 * session may subscribe to multiple trips concurrently; each gets its own
 * WebSocket (required, since the URL embeds the trip key).
 */
export class ShareDBPool {
  private readonly clients = new Map<string, ShareDBClient>();

  constructor(private readonly config: Config) {}

  get(tripKey: string): ShareDBClient {
    let client = this.clients.get(tripKey);
    if (!client) {
      client = new ShareDBClient(this.config, tripKey);
      this.clients.set(tripKey, client);
    }
    return client;
  }

  has(tripKey: string): boolean {
    return this.clients.has(tripKey);
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }
}
