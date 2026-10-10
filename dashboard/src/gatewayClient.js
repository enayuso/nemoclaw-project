// gatewayClient.js - the one persistent backend -> OpenClaw Gateway
// WebSocket connection. Everything else in this app goes through this
// module rather than opening its own connection.
//
// Protocol facts confirmed from OpenClaw's own docs (protocol v4, JSON
// text frames): requests are {type:"req", id, method, params}, responses
// are {type:"res", id, ok, payload|error}, events are
// {type:"event", event, payload}. Auth is a challenge-response handshake:
// the server pushes a `connect.challenge` event (nonce+timestamp) right
// after the socket opens, the client replies with a `connect` request
// carrying device identity + role + scopes + the device token.
//
// NOT independently confirmed against a live gateway as of writing this:
// the exact field names inside the challenge payload and the exact shape
// expected in the `connect` request's params. This is deliberately
// implemented against the most literal reading of the documented shape,
// with verbose logging of every raw frame during the handshake phase -
// if the real gateway's wire format differs in some field name, that
// mismatch will show up immediately in the startup logs instead of
// hanging silently. Fix here, adjust to match, before relying on
// anything downstream of connect() resolving.

const WebSocket = require("ws");
const crypto = require("node:crypto");

const config = require("./config");

const REQUEST_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const RECONNECT_DELAYS_MS = [5_000, 10_000, 30_000];

// NEMOCLAW_GATEWAY_URL is the bare origin (e.g. ws://127.0.0.1:8180) -
// the real WS endpoint lives at /ws, confirmed 2026-07-23 straight from
// NemoClaw's own installed test suite (~/.nemoclaw/source), not guessed.
// The same source also showed the client setting an Origin header
// matching the gateway's own http(s) origin - the gateway validates this,
// and connecting without it is a second, separate way this can fail even
// once the path is right.
function buildWsTarget(baseUrl) {
  const url = new URL(baseUrl);
  const origin = `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  const wsUrl = new URL("/ws", baseUrl.replace(/^ws/, "http")); // resolve path against http(s) form, then swap back
  wsUrl.protocol = url.protocol;
  return { wsUrl: wsUrl.toString(), origin };
}

class GatewayClient {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.nextRequestId = 1;
    this.pendingRequests = new Map(); // id -> {resolve, reject, timeout}
    this.subscriptions = new Map(); // sessionKey -> Set<onEvent callback>
    this.pendingSubscribes = new Map(); // sessionKey -> in-flight subscribe() Promise, see subscribe() below
    this.reconnectAttempt = 0;
    this.connectPromise = null;
    // Cached result of getContextWindow() below - null both before the
    // first fetch and whenever it's genuinely unknown (RPC failed, or the
    // config didn't have the expected shape) vs. simply "not yet fetched
    // this connection" - reset on every reconnect (see ws.on("close")
    // below) since a reconnect is exactly when the underlying config is
    // most likely to have actually changed (e.g. a model swap forces a
    // gateway restart, which is what tears down this WS connection).
    this.contextWindowCache = null;
    // Same lifecycle as contextWindowCache above - see getModelEndpoint().
    this.modelEndpointCache = null;
  }

  // Idempotent - safe to call multiple times, returns the same in-flight
  // or already-resolved connection promise.
  connect() {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this._connectOnce();
    return this.connectPromise;
  }

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const { wsUrl, origin } = buildWsTarget(config.gatewayUrl);
      console.log(`gatewayClient: connecting to ${wsUrl} (Origin: ${origin})`);
      const ws = new WebSocket(wsUrl, { headers: { Origin: origin } });
      this.ws = ws;

      let handshakeDone = false;
      const handshakeTimer = setTimeout(() => {
        if (!handshakeDone) {
          const err = new Error(
            "gatewayClient: handshake timed out - no connect.challenge " +
              "received within " +
              HANDSHAKE_TIMEOUT_MS +
              "ms. Check NEMOCLAW_GATEWAY_URL and that the gateway is " +
              "actually reachable from this host.",
          );
          console.error(err.message);
          ws.terminate();
          reject(err);
        }
      }, HANDSHAKE_TIMEOUT_MS);

      ws.on("open", () => {
        console.log("gatewayClient: socket open, waiting for connect.challenge");
      });

      ws.on("message", (raw) => {
        let frame;
        try {
          frame = JSON.parse(raw.toString());
        } catch (err) {
          console.error("gatewayClient: received non-JSON frame:", raw.toString());
          return;
        }

        if (!handshakeDone) {
          console.log("gatewayClient: handshake frame:", JSON.stringify(frame));
          if (frame.type === "event" && frame.event === "connect.challenge") {
            this._respondToChallenge(ws, frame.payload || {});
            return;
          }
          // Some deployments may reply to the connect request with a
          // plain res frame rather than a further event - treat either
          // shape as handshake success if it looks like an ack.
          if (
            frame.type === "res" &&
            (frame.method === "connect" || frame.ok === true)
          ) {
            handshakeDone = true;
            clearTimeout(handshakeTimer);
            this.connected = true;
            this.reconnectAttempt = 0;
            console.log("gatewayClient: connected and authenticated");
            this._resubscribeAll();
            resolve();
            return;
          }
        }

        this._dispatch(frame);
      });

      ws.on("error", (err) => {
        console.error("gatewayClient: socket error:", err.message);
      });

      ws.on("close", (code, reason) => {
        this.connected = false;
        this.connectPromise = null;
        this.contextWindowCache = null;
        this.modelEndpointCache = null;
        console.warn(
          `gatewayClient: disconnected (code=${code} reason=${reason || "none"})`,
        );
        this._rejectAllPending(new Error("gateway connection closed"));
        this._scheduleReconnect();
      });
    });
  }

  _respondToChallenge(ws, challengePayload) {
    // Confirmed 2026-07-23 against a real gateway's own INVALID_REQUEST
    // schema error, then matched exactly against NemoClaw's own installed
    // test suite (~/.nemoclaw/source, live e2e tests): the connect params
    // have no `nonce` field at all (the challenge's nonce is never echoed
    // back - the gateway apparently just needs a fresh connect() per
    // challenge) and no `device`/`publicKey` - identity is a `client`
    // object with no cryptographic proof required. Do not reintroduce
    // either without a fresh rejection error confirming they're needed.
    const params = {
      minProtocol: 4,
      maxProtocol: 4,
      client: {
        // client.id is an enum of recognized client TYPES, not a free-form
        // identifier - confirmed live 2026-07-23 via "must be equal to one
        // of the allowed values". "openclaw-control-ui" is the exact,
        // confirmed-valid value from NemoClaw's own e2e test suite - our
        // own distinguishing name belongs in displayName below instead,
        // which IS free-form.
        id: "openclaw-control-ui",
        displayName: "ops-nemoclaw dashboard",
        version: "0.1.0",
        platform: process.platform,
        mode: "ui",
        instanceId: crypto.randomUUID(),
      },
      caps: ["tool-events"],
      scopes: ["operator.read", "operator.write"],
      auth: { token: config.gatewayToken },
    };
    const id = `handshake-${crypto.randomUUID()}`;
    console.log(
      "gatewayClient: sending connect frame:",
      JSON.stringify({ ...params, auth: { token: "***" } }),
    );
    ws.send(JSON.stringify({ type: "req", id, method: "connect", params }));
  }

  // Re-issues sessions.messages.subscribe for every sessionKey this client
  // still has live browser-callback subscribers for. this.subscriptions
  // deliberately survives a disconnect (wsRelay.js's browser sockets and
  // their onEvent callbacks are untouched by a reconnect - see that file's
  // own comments), but the gateway-side registration does NOT survive:
  // confirmed live 2026-07-31 straight from OpenClaw's own gateway source
  // (dist/sessions-FHKRhZK9.js) that the subscribe handler keys off
  // client.connId - the specific WebSocket connection's own ID, freshly
  // generated per connection (confirmed in this client's own connected
  // handshake logs) - not any identity or device token that would survive
  // a reconnect. Without this, every run being watched at the moment of a
  // reconnect went silently dead: wsRelay.js kept its browser sockets open
  // and this.subscriptions still listed them as subscribed, but no
  // gateway event for that sessionKey ever arrived again until the whole
  // dashboard process itself restarted. Runs once per successful
  // handshake, including the very first connect - this.subscriptions is
  // always empty then, so it's a no-op that costs nothing.
  _resubscribeAll() {
    for (const sessionKey of this.subscriptions.keys()) {
      this.call("sessions.messages.subscribe", { key: sessionKey }).catch((err) => {
        console.error(
          `gatewayClient: failed to re-subscribe '${sessionKey}' after reconnect:`,
          err.message,
        );
        // Same rollback subscribe() already does when ITS OWN RPC fails
        // (see that method's comment for the full reasoning) - without
        // this, a failed re-subscribe left sessionKey permanently marked
        // "subscribed" here with no gateway-side registration behind it,
        // so no future subscribe() call would ever see a reason to retry
        // the RPC. Deleting it means the next browser connection for this
        // sessionKey (a new tab, or a page refresh) re-issues the RPC
        // instead of silently trusting a registration that never actually
        // happened.
        this.subscriptions.delete(sessionKey);
      });
    }
  }

  _scheduleReconnect() {
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ];
    this.reconnectAttempt += 1;
    console.log(`gatewayClient: reconnecting in ${delay}ms`);
    setTimeout(() => {
      this.connect().catch((err) => {
        console.error("gatewayClient: reconnect attempt failed:", err.message);
      });
    }, delay);
  }

  _dispatch(frame) {
    if (frame.type === "res" && this.pendingRequests.has(frame.id)) {
      const pending = this.pendingRequests.get(frame.id);
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(frame.id);
      if (frame.ok) pending.resolve(frame.payload);
      else pending.reject(new Error(frame.error && frame.error.message || "gateway request failed"));
      return;
    }

    if (frame.type === "event") {
      if (frame.event === "heartbeat" || frame.event === "presence" || frame.event === "tick") {
        return; // connection-health noise, nothing to relay
      }
      const sessionKey =
        frame.payload && (frame.payload.sessionKey || frame.payload.session_key);
      if (sessionKey && this.subscriptions.has(sessionKey)) {
        for (const cb of this.subscriptions.get(sessionKey)) cb(frame);
      }
    }
  }

  // Generic RPC call - {type:"req", id, method, params} -> resolves with
  // the response payload, rejects on {ok:false} or timeout.
  call(method, params) {
    if (!this.connected) {
      return Promise.reject(new Error("gatewayClient: not connected"));
    }
    const id = `req-${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`gatewayClient: request '${method}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pendingRequests.set(id, { resolve, reject, timeout });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  // Returns the configured model's context window (in tokens), or null if
  // genuinely unavailable - lets the dashboard warn as a session
  // approaches the limit instead of only finding out via the lifecycle
  // phase:"error" a context overflow terminates a run with (confirmed
  // live 2026-07-27, see renderFrame's own phase:"error" handling).
  //
  // config.get takes NO path/key param - confirmed live 2026-07-28
  // ("unexpected property 'path'"/"unexpected property 'key'"); called
  // with {} it returns the gateway's ENTIRE raw config file as one JSON
  // string (payload.raw) - unlike the `openclaw config get <path>` CLI
  // command, which resolves a dot-path itself (almost certainly by
  // reading the config file directly off disk rather than through this
  // same RPC, since the two behave completely differently for the exact
  // same conceptual request). That raw payload can contain real secrets
  // (provider apiKeys, channel tokens, etc.) - this method parses it
  // in-process, extracts ONLY the one number needed, and returns nothing
  // else; callers (routes/modelInfo.js) must never forward payload.raw
  // itself to the browser-facing API.
  //
  // Hardcodes the "inference" provider key, matching every other
  // model-config reference already hardcoded the same way throughout
  // this repo (bootstrap.sh, registry/repos.json) - this instance has had
  // exactly one inference provider throughout its model-swap history.
  async getContextWindow() {
    if (this.contextWindowCache !== null) return this.contextWindowCache;
    const payload = await this.call("config.get", {});
    let parsed;
    try {
      parsed = JSON.parse(payload.raw);
    } catch (err) {
      throw new Error(`gatewayClient: config.get returned unparseable JSON: ${err.message}`);
    }
    const models = parsed.models && parsed.models.providers && parsed.models.providers.inference && parsed.models.providers.inference.models;
    const contextWindow =
      Array.isArray(models) && models[0] && typeof models[0].contextWindow === "number"
        ? models[0].contextWindow
        : null;
    this.contextWindowCache = contextWindow;
    return contextWindow;
  }

  // Where the inference provider actually lives, for routes/modelInfo.js's
  // health probe. Same secret boundary as getContextWindow above and for
  // the same reason - config.get returns the gateway's ENTIRE config,
  // including `apiKey` right next to the `baseUrl` being read here. Only
  // the two strings below ever leave this method.
  //
  // The URL is re-parsed and rebuilt from its origin+pathname rather than
  // passed through as-is: a baseUrl carrying userinfo
  // (https://user:token@host/v1) would otherwise put a credential straight
  // into an API response and, from there, into the banner text. Not the
  // current shape - it's a plain LAN address today - but this is exactly
  // the kind of thing that changes quietly during a provider swap.
  //
  // Cached alongside contextWindowCache and cleared on the same reconnect,
  // since a model/provider swap is what forces the gateway restart that
  // drops this connection in the first place.
  async getModelEndpoint() {
    if (this.modelEndpointCache !== null) return this.modelEndpointCache;
    const payload = await this.call("config.get", {});
    let parsed;
    try {
      parsed = JSON.parse(payload.raw);
    } catch (err) {
      throw new Error(`gatewayClient: config.get returned unparseable JSON: ${err.message}`);
    }
    const inference =
      parsed.models && parsed.models.providers && parsed.models.providers.inference;
    const rawBase = inference && typeof inference.baseUrl === "string" ? inference.baseUrl : null;
    const modelId =
      inference && Array.isArray(inference.models) && inference.models[0] && typeof inference.models[0].id === "string"
        ? inference.models[0].id
        : null;
    if (!rawBase) {
      this.modelEndpointCache = { baseUrl: null, modelId };
      return this.modelEndpointCache;
    }
    let baseUrl = null;
    try {
      const u = new URL(rawBase);
      baseUrl = `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
    } catch {
      baseUrl = null;
    }
    this.modelEndpointCache = { baseUrl, modelId };
    return this.modelEndpointCache;
  }

  // Returns the raw sessions.list array for one agent (e.g. a repo's
  // "<repoKey>-escalation" agent), or [] if the RPC fails or the response
  // ever comes back in an unexpected shape - defensive, not throwing,
  // since this powers remoteSessions.js's cross-repo merge (see that
  // file's own comment) where one repo's gateway hiccup must not take
  // down the whole /api/sessions response for every other repo.
  //
  // No pagination handling deliberately - confirmed live 2026-07-28 that
  // real per-agent session counts are small (7-33), so a single call with
  // a generous limit (default 100) comfortably covers every real agent
  // observed so far without needing to walk hasMore/nextOffset.
  async listAgentSessions(agentId, limit = 100) {
    try {
      const payload = await this.call("sessions.list", { agentId, limit });
      return (payload && Array.isArray(payload.sessions)) ? payload.sessions : [];
    } catch (err) {
      console.warn(`gatewayClient: sessions.list failed for agent '${agentId}':`, err.message);
      return [];
    }
  }

  // Subscribes to a session's events. Calls sessions.messages.subscribe on
  // the gateway once per sessionKey - wsRelay.js now calls this on EVERY
  // browser connection for a run (passing the same stable per-run
  // callback reference each time, see its own comment), relying entirely
  // on the logic here to keep the actual RPC call to exactly once per
  // sessionKey.
  //
  // Confirmed in backend review 2026-07-24: a second connection racing in
  // before the first's RPC settles used to take an immediate,
  // synchronous "already subscribed" branch (has() was already true) and
  // add itself to the same placeholder Set without waiting on the RPC at
  // all - if that RPC then failed, the catch below deleted the ENTIRE
  // Set, including the second connection's already-added callback, and
  // only the first connection's caller ever saw the rejection (the
  // second's own subscribe() call had already resolved successfully) -
  // silently stranding it with no live events until a full reconnect.
  // pendingSubscribes fixes this structurally: any concurrent caller for
  // the same sessionKey now awaits the SAME in-flight RPC promise, so a
  // failure is seen (and thrown) by every caller currently waiting, not
  // just the one that happened to trigger the RPC.
  async subscribe(sessionKey, onEvent) {
    let inFlight = this.pendingSubscribes.get(sessionKey);
    if (!this.subscriptions.has(sessionKey) && !inFlight) {
      this.subscriptions.set(sessionKey, new Set());
      // Confirmed live 2026-07-23: the param is `key`, not `sessionKey`
      // ("must have required property 'key'; unexpected property
      // 'sessionKey'").
      inFlight = this.call("sessions.messages.subscribe", { key: sessionKey })
        .catch((err) => {
          // Roll back the placeholder Set on a failed RPC - otherwise a
          // future call would see this sessionKey as "already subscribed"
          // and never actually retry the RPC, permanently stranding this
          // run with no live events.
          this.subscriptions.delete(sessionKey);
          throw err;
        })
        .finally(() => {
          this.pendingSubscribes.delete(sessionKey);
        });
      this.pendingSubscribes.set(sessionKey, inFlight);
    }
    if (inFlight) await inFlight;
    // A concurrent unsubscribe() could have deleted this sessionKey's Set
    // entirely while the RPC above was in flight (e.g. the browser socket
    // closed before its own subscribe() call resolved) - recreate it
    // rather than assume it's still there, since the RPC itself DID
    // succeed and this callback is still owed a place to be registered.
    if (!this.subscriptions.has(sessionKey)) {
      this.subscriptions.set(sessionKey, new Set());
    }
    this.subscriptions.get(sessionKey).add(onEvent);
  }

  unsubscribe(sessionKey, onEvent) {
    const set = this.subscriptions.get(sessionKey);
    if (!set) return;
    set.delete(onEvent);
    if (set.size === 0) this.subscriptions.delete(sessionKey);
    // Deliberately not calling a gateway-side unsubscribe RPC - not
    // confirmed one exists/is needed, and the subscription list is small
    // and short-lived for a thin-slice MVP. Revisit if this ever matters.
  }

  _rejectAllPending(err) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this.pendingRequests.clear();
  }
}

module.exports = new GatewayClient();
