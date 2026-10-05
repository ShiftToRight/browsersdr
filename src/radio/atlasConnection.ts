import {
  AtlasClient,
  AtlasRequestError,
  type AtlasCurrentUser,
  type AtlasSession,
} from "./atlasClient";
import {
  AtlasCredentialStore,
  browserAtlasCredentials,
  validAtlasToken,
} from "./atlasCredentials";

export interface AtlasConnectionSnapshot {
  status:
    | "disconnected"
    | "connecting"
    | "connected"
    | "expired"
    | "disconnecting"
    | "error";
  user?: AtlasCurrentUser;
  expiresAt?: string;
  transferActive: boolean;
  message?: string;
}

export function atlasConnectionMessage(error: unknown): string {
  if (error instanceof AtlasRequestError) {
    if (error.code === "transfer_active")
      return "Wait for the SigIntAtlas transfer to finish or cancel it first.";
    if (error.status === 401)
      return "SigIntAtlas rejected the token or the session expired. Check the token and retry.";
    if (error.status === 403)
      return "SigIntAtlas denied this action. Check your permissions and the same-origin proxy/CSRF configuration.";
    if (error.status === 429)
      return "SigIntAtlas login is rate limited. Wait before retrying.";
  }
  return "Could not connect to SigIntAtlas. Check the token, network and same-origin API proxy.";
}

function aborted(): DOMException {
  return new DOMException("Atlas connection changed", "AbortError");
}

// Cancel a caller's wait, never the shared login owned by the connection service.
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? aborted());
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? aborted());
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then((value) => {
        if (!signal.aborted) resolve(value);
      }, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export class AtlasConnection {
  private snapshot: AtlasConnectionSnapshot = {
    status: "disconnected",
    transferActive: false,
  };
  private session?: AtlasSession;
  private generation = 0;
  private flight?: { aborter: AbortController; promise: Promise<AtlasSession> };
  private transfer?: AbortController;
  private closing = false;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private retryNotBefore = 0;
  private readonly reads = new Set<AbortController>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeCredentials: () => void;

  constructor(
    readonly credentials: AtlasCredentialStore,
    readonly client = new AtlasClient(),
    private readonly now: () => number = Date.now,
  ) {
    this.unsubscribeCredentials = credentials.subscribe(() =>
      this.invalidate("disconnected"),
    );
  }

  getSnapshot = (): AtlasConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  saveToken(token: string, remember: boolean): void {
    this.assertMutable();
    this.credentials.save(token, remember);
  }

  ensureAuthenticated(signal?: AbortSignal): Promise<AtlasSession> {
    return this.authenticate(false, signal);
  }

  authenticateTransfer(signal: AbortSignal): Promise<AtlasSession> {
    if (!this.transfer) return Promise.reject(aborted());
    return this.authenticate(true, signal);
  }

  async testConnection(): Promise<void> {
    this.assertMutable();
    const hadSession = this.usableSession();
    await this.ensureAuthenticated();
    if (hadSession) {
      const user = await this.read((signal) => this.client.me(signal));
      this.publish({
        ...this.snapshot,
        user,
        status: "connected",
        message: undefined,
      });
    }
  }

  async read<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const generation = this.generation;
    const aborter = new AbortController();
    this.reads.add(aborter);
    const readSignal = signal
      ? AbortSignal.any([signal, aborter.signal])
      : aborter.signal;
    try {
      for (let attempt = 0; ; attempt++) {
        const authenticatedSession = await this.ensureAuthenticated(readSignal);
        try {
          const result = await operation(readSignal);
          readSignal.throwIfAborted();
          if (generation !== this.generation) throw aborted();
          return result;
        } catch (error) {
          if (!(error instanceof AtlasRequestError) || error.status !== 401)
            throw error;
          readSignal.throwIfAborted();
          if (generation !== this.generation) throw aborted();
          // Another reader may already have replaced this expired session.
          if (this.session === authenticatedSession) this.expire();
          if (
            attempt ||
            this.transfer ||
            generation !== this.generation ||
            readSignal.aborted
          )
            throw error;
        }
      }
    } finally {
      this.reads.delete(aborter);
    }
  }

  async withTransfer<T>(
    token: string,
    operation: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    this.assertMutable();
    signal.throwIfAborted();
    if (
      token !== this.credentials.getSnapshot().token ||
      !validAtlasToken(token)
    )
      throw aborted();
    const owner = new AbortController();
    this.transfer = owner;
    const transferSignal = AbortSignal.any([signal, owner.signal]);
    this.publish({ ...this.snapshot, transferActive: true });
    try {
      const result = await operation(transferSignal);
      transferSignal.throwIfAborted();
      return result;
    } catch (error) {
      if (error instanceof AtlasRequestError && error.status === 401)
        this.expire();
      // AtlasTransferFailure wraps HTTP errors for its existing explicit retry flow.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "session_expired"
      )
        this.expire();
      throw error;
    } finally {
      if (this.transfer === owner) {
        this.transfer = undefined;
        this.publish({ ...this.snapshot, transferActive: false });
      }
    }
  }

  disconnect(): Promise<void> {
    return this.close(false);
  }
  forgetToken(): Promise<void> {
    return this.close(true);
  }

  dispose(): void {
    this.invalidate("disconnected");
    this.unsubscribeCredentials();
    this.listeners.clear();
  }

  private assertMutable(): void {
    if (this.transfer)
      throw new AtlasRequestError(
        409,
        "transfer_active",
        "A SigIntAtlas transfer is active.",
      );
    if (this.closing) throw aborted();
  }

  private usableSession(): boolean {
    return (
      !!this.session &&
      this.client.authenticated &&
      Date.parse(this.session.expires_at) > this.now()
    );
  }

  private authenticate(
    forTransfer: boolean,
    signal?: AbortSignal,
  ): Promise<AtlasSession> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? aborted());
    if (this.closing) return Promise.reject(aborted());
    if (this.usableSession()) return Promise.resolve(this.session!);
    if (this.transfer && !forTransfer)
      return Promise.reject(
        new AtlasRequestError(
          409,
          "transfer_active",
          "A transfer owns the Atlas session; retry the read after it finishes.",
        ),
      );
    if (this.flight) return waitFor(this.flight.promise, signal);
    if (this.retryNotBefore > this.now())
      return Promise.reject(
        new AtlasRequestError(
          429,
          "login_rate_limited",
          "Wait before retrying SigIntAtlas login.",
          undefined,
          this.retryNotBefore - this.now(),
        ),
      );
    const token = this.credentials.getSnapshot().token;
    if (!validAtlasToken(token))
      return Promise.reject(
        new AtlasRequestError(
          401,
          "authentication_required",
          "Configure a SigIntAtlas user token in Settings.",
        ),
      );
    const generation = this.generation;
    const aborter = new AbortController();
    this.publish({
      ...this.snapshot,
      status: "connecting",
      user: undefined,
      expiresAt: undefined,
      message: undefined,
    });
    const check = () => {
      aborter.signal.throwIfAborted();
      if (generation !== this.generation) throw aborted();
    };
    const promise = (async () => {
      try {
        const session = await this.client.login(token, aborter.signal);
        check();
        const user = await this.client.me(aborter.signal);
        check();
        if (
          session.operator_id !== user.id ||
          Date.parse(session.expires_at) <= this.now()
        )
          throw new Error("Invalid session identity or expiry");
        this.session = session;
        this.scheduleExpiry();
        this.publish({
          ...this.snapshot,
          status: "connected",
          user,
          expiresAt: session.expires_at,
        });
        return session;
      } catch (error) {
        if (generation === this.generation) {
          if (error instanceof AtlasRequestError && error.status === 429)
            this.retryNotBefore = this.now() + (error.retryAfterMs ?? 1000);
          this.session = undefined;
          this.client.clearSession();
          this.publish({
            ...this.snapshot,
            status: "error",
            user: undefined,
            expiresAt: undefined,
            message: atlasConnectionMessage(error),
          });
        }
        throw error;
      } finally {
        if (this.flight?.aborter === aborter) this.flight = undefined;
      }
    })();
    this.flight = { aborter, promise };
    return waitFor(promise, signal);
  }

  private async close(forget: boolean): Promise<void> {
    this.assertMutable();
    this.closing = true;
    // Capture CSRF before local invalidation; the request is already dispatched.
    const logout = this.client.authenticated
      ? this.client.logout(AbortSignal.timeout(5_000))
      : Promise.resolve();
    this.invalidate("disconnecting");
    if (forget) this.credentials.forget();
    this.publish({ status: "disconnecting", transferActive: false });
    try {
      await logout;
      this.publish({ status: "disconnected", transferActive: false });
    } catch {
      this.publish({
        status: "disconnected",
        transferActive: false,
        message:
          "Disconnected locally. SigIntAtlas logout could not be confirmed; the server session may remain active.",
      });
    } finally {
      this.closing = false;
    }
  }

  private expire(): void {
    this.clearExpiry();
    this.session = undefined;
    this.client.clearSession();
    this.publish({
      ...this.snapshot,
      status: "expired",
      user: undefined,
      expiresAt: undefined,
      message: "SigIntAtlas session expired. Retry to authenticate again.",
    });
  }

  private invalidate(status: AtlasConnectionSnapshot["status"]): void {
    this.clearExpiry();
    ++this.generation;
    this.flight?.aborter.abort(aborted());
    this.flight = undefined;
    this.transfer?.abort(aborted());
    for (const read of this.reads) read.abort(aborted());
    this.session = undefined;
    this.client.clearSession();
    this.publish({
      status: this.closing ? "disconnecting" : status,
      transferActive: !!this.transfer,
    });
  }

  private clearExpiry(): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
  }

  private scheduleExpiry(): void {
    this.clearExpiry();
    if (!this.session) return;
    const remaining = Date.parse(this.session.expires_at) - this.now();
    this.expiryTimer = setTimeout(
      () => {
        if (this.session && Date.parse(this.session.expires_at) <= this.now())
          this.expire();
        else this.scheduleExpiry();
      },
      Math.max(0, Math.min(remaining, 2_147_483_647)),
    );
  }

  private publish(snapshot: AtlasConnectionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

let browserConnection: AtlasConnection | undefined;
export function getAtlasConnection(): AtlasConnection {
  return (browserConnection ??= new AtlasConnection(browserAtlasCredentials()));
}
