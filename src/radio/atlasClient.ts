export const ATLAS_API_VERSION = "1.0.0" as const;
export const ATLAS_ANALYSIS_CAPABILITIES_VERSION =
  "signal-atlas-analysis-capabilities-v1" as const;

export interface AtlasAnalysisCapabilities {
  schema_version: typeof ATLAS_ANALYSIS_CAPABILITIES_VERSION;
  available: boolean;
  operations: Array<"analyze" | "identify">;
  profiles: Array<"legacy-http-v1" | "offline-bounded-v1">;
  supported_datatypes: Array<"cu8" | "ci16_le" | "cf32_le">;
  unavailable_reason: string | null;
}
export interface AtlasCapabilities {
  schema_version: typeof ATLAS_API_VERSION;
  supported_sigmf_versions: string[];
  supported_datatypes: string[];
  max_data_bytes: string;
  max_metadata_bytes: string;
  upload_part_bytes: string;
  max_inflight_parts: number;
  storage_configured: boolean;
  analysis: AtlasAnalysisCapabilities | null;
}
export interface AtlasSession {
  operator_id: string;
  expires_at: string;
  csrf_token: string;
}
export type AtlasUploadState =
  | "created"
  | "uploading"
  | "completing"
  | "verifying"
  | "complete"
  | "failed"
  | "aborted"
  | "expired";
export interface AtlasPartReceipt {
  upload_id: string;
  part_number: number;
  byte_length: string;
  sha256: string;
  etag: string;
  accepted_at: string;
}
export interface AtlasUpload {
  id: string;
  state: AtlasUploadState;
  role: "data" | "metadata" | "artifact";
  byte_length: string;
  accepted_bytes: string;
  part_size: string;
  expected_parts: number;
  expires_at: string;
  parts: AtlasPartReceipt[];
  failure_code: string | null;
}
export interface AtlasJob {
  id: string;
  kind: string;
  status: "pending" | "leased" | "complete" | "failed";
  attempt: number;
  failure_code: string | null;
  result: Record<string, unknown> | null;
}
export interface AtlasRecordingRegistration {
  id: string;
  state: "waiting" | "queued" | "processing" | "complete" | "failed";
  recording_id: string | null;
  failure_code: string | null;
}
export interface AtlasRecording {
  id: string;
  current_revision_id: string | null;
  import_status: string;
}
export interface AtlasAnalysisRun {
  id: string;
  recording_id: string;
  recording_revision_id: string;
  status:
    "queued" | "running" | "success" | "partial" | "failure" | "cancelled";
  recording_url: string;
  result_url: string;
}

export interface AtlasErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  request_id?: string;
}
export class AtlasRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AtlasRequestError";
  }
  get transient(): boolean {
    return this.status === 429 || [502, 503, 504].includes(this.status);
  }
}

export interface AtlasClientOptions {
  basePath?: string;
  fetch?: typeof fetch;
  delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  retryAttempts?: number;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(
        signal.reason ?? new DOMException("Cancelled", "AbortError"),
      );
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Cancelled", "AbortError"));
      },
      { once: true },
    );
  });
}

function validateBasePath(value: string): string {
  if (value.startsWith("/") && !value.startsWith("//"))
    return value.replace(/\/$/, "");
  if (typeof location !== "undefined") {
    const url = new URL(value, location.href);
    if (url.origin === location.origin) return url.href.replace(/\/$/, "");
  }
  throw new Error(
    "SigIntAtlas must be configured on the same browser origin, normally at /api/v1.",
  );
}

export class AtlasClient {
  private readonly basePath: string;
  private readonly fetcher: typeof fetch;
  private readonly wait: NonNullable<AtlasClientOptions["delay"]>;
  private readonly retryAttempts: number;
  private csrfToken?: string;

  constructor(options: AtlasClientOptions = {}) {
    this.basePath = validateBasePath(options.basePath ?? "/api/v1");
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.wait = options.delay ?? delay;
    this.retryAttempts = options.retryAttempts ?? 3;
  }

  get authenticated(): boolean {
    return this.csrfToken !== undefined;
  }
  clearSession(): void {
    this.csrfToken = undefined;
  }

  capabilities(signal?: AbortSignal): Promise<AtlasCapabilities> {
    return this.request("/capabilities", { signal }, true);
  }
  async login(
    operatorToken: string,
    signal?: AbortSignal,
  ): Promise<AtlasSession> {
    if (operatorToken.length < 32)
      throw new Error(
        "SigIntAtlas operator token must contain at least 32 characters.",
      );
    const session = await this.request<AtlasSession>("/session", {
      method: "POST",
      body: JSON.stringify({ operator_token: operatorToken }),
      headers: { "Content-Type": "application/json" },
      signal,
    });
    this.csrfToken = session.csrf_token;
    return session;
  }
  async logout(signal?: AbortSignal): Promise<void> {
    await this.request("/session", { method: "DELETE", signal });
    this.clearSession();
  }

  createUpload(
    body: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
  ): Promise<AtlasUpload> {
    return this.jsonMutation("/uploads", "POST", body, key, signal, true);
  }
  getUpload(id: string, signal?: AbortSignal): Promise<AtlasUpload> {
    return this.request(`/uploads/${encodeURIComponent(id)}`, { signal }, true);
  }
  putPart(
    id: string,
    number: number,
    body: Blob,
    sha256: string,
    signal?: AbortSignal,
  ): Promise<AtlasPartReceipt> {
    return this.request(
      `/uploads/${encodeURIComponent(id)}/parts/${number}`,
      {
        method: "PUT",
        body,
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-SHA256": sha256,
        },
        signal,
      },
      true,
    );
  }
  completeUpload(
    id: string,
    expectedParts: number,
    sha256: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<AtlasJob> {
    return this.jsonMutation(
      `/uploads/${encodeURIComponent(id)}/complete`,
      "POST",
      { expected_parts: expectedParts, expected_sha256: sha256 },
      key,
      signal,
      true,
    );
  }
  abortUpload(id: string, signal?: AbortSignal): Promise<AtlasUpload> {
    return this.request(
      `/uploads/${encodeURIComponent(id)}/abort`,
      { method: "POST", signal },
      true,
    );
  }
  getJob(id: string, signal?: AbortSignal): Promise<AtlasJob> {
    return this.request(`/jobs/${encodeURIComponent(id)}`, { signal }, true);
  }
  registerRecording(
    body: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
  ): Promise<AtlasRecordingRegistration> {
    return this.jsonMutation("/recordings", "POST", body, key, signal, true);
  }
  getRegistration(
    id: string,
    signal?: AbortSignal,
  ): Promise<AtlasRecordingRegistration> {
    return this.request(
      `/recording-imports/${encodeURIComponent(id)}`,
      { signal },
      true,
    );
  }
  getRecording(id: string, signal?: AbortSignal): Promise<AtlasRecording> {
    return this.request(
      `/recordings/${encodeURIComponent(id)}`,
      { signal },
      true,
    );
  }
  scheduleAnalysis(
    recordingId: string,
    body: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
  ): Promise<AtlasAnalysisRun> {
    return this.jsonMutation(
      `/recordings/${encodeURIComponent(recordingId)}/analysis-runs`,
      "POST",
      body,
      key,
      signal,
      true,
    );
  }
  getAnalysisRun(
    runId: string,
    signal?: AbortSignal,
  ): Promise<AtlasAnalysisRun> {
    return this.request(`/runs/${encodeURIComponent(runId)}`, { signal }, true);
  }

  private jsonMutation<T>(
    path: string,
    method: string,
    body: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
    retry = false,
  ): Promise<T> {
    return this.request(
      path,
      {
        method,
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        signal,
      },
      retry,
    );
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    retryable = false,
  ): Promise<T> {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (!["GET", "HEAD"].includes(method) && path !== "/session") {
      if (!this.csrfToken)
        throw new AtlasRequestError(
          401,
          "authentication_required",
          "Authenticate with SigIntAtlas before changing data.",
        );
      headers.set("X-CSRF-Token", this.csrfToken);
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.basePath}${path}`, {
          ...init,
          headers,
          credentials: "same-origin",
          signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        });
        if (response.ok) {
          if (response.status === 204) return undefined as T;
          return (await response.json()) as T;
        }
        let error: AtlasErrorBody = {
          code: `http_${response.status}`,
          message: `SigIntAtlas request failed with HTTP ${response.status}.`,
        };
        try {
          error =
            ((await response.json()) as { error?: AtlasErrorBody }).error ??
            error;
        } catch {
          /* bounded generic error */
        }
        const retryAfter = Number(response.headers.get("Retry-After"));
        const failure = new AtlasRequestError(
          response.status,
          error.code,
          error.message,
          error.details,
          Number.isFinite(retryAfter)
            ? Math.max(0, retryAfter * 1000)
            : undefined,
        );
        if (response.status === 401) this.clearSession();
        if (!retryable || !failure.transient || attempt >= this.retryAttempts)
          throw failure;
        await this.wait(
          failure.retryAfterMs ?? 100 * 2 ** (attempt - 1),
          init.signal ?? undefined,
        );
      } catch (error) {
        if (
          error instanceof AtlasRequestError ||
          init.signal?.aborted ||
          !retryable ||
          attempt >= this.retryAttempts
        )
          throw error;
        await this.wait(100 * 2 ** (attempt - 1), init.signal ?? undefined);
      }
    }
  }
}
