export const ATLAS_USER_TOKEN_KEY = "browsersdr.atlas.user-token.v1";
export function validAtlasToken(token: string): boolean {
  return token.length >= 32 && token.length <= 4096;
}

export interface AtlasCredentialSnapshot {
  token: string;
  revision: number;
  remember: boolean;
  persistence: "remembered" | "memory" | "unavailable";
  notice?: string;
}

export class AtlasCredentialStore {
  private snapshot: AtlasCredentialSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly onStorage = (event: Event) => {
    const change = event as StorageEvent;
    if (change.key !== null && change.key !== ATLAS_USER_TOKEN_KEY) return;
    if (change.storageArea && change.storageArea !== this.storage) return;
    this.reload();
  };

  constructor(
    private readonly storage: Storage | null,
    private readonly events?: EventTarget,
  ) {
    this.snapshot = this.read(0);
    events?.addEventListener("storage", this.onStorage);
  }

  getSnapshot = (): AtlasCredentialSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  save(token: string, remember = this.snapshot.remember): void {
    if (!validAtlasToken(token))
      throw new Error(
        "Enter a SigIntAtlas user token containing 32–4096 characters.",
      );
    this.write(token, remember);
  }

  forget(): void {
    this.write("", this.snapshot.remember);
  }

  dispose(): void {
    this.events?.removeEventListener("storage", this.onStorage);
    this.listeners.clear();
  }

  private read(revision: number): AtlasCredentialSnapshot {
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      const stored = this.storage.getItem(ATLAS_USER_TOKEN_KEY) ?? "";
      const token = validAtlasToken(stored) ? stored : "";
      return {
        token,
        revision,
        remember: true,
        persistence: token ? "remembered" : "memory",
      };
    } catch {
      return {
        token: "",
        revision,
        remember: true,
        persistence: "unavailable",
        notice:
          "Browser storage is unavailable. Tokens can still be used in this tab.",
      };
    }
  }

  private reload(): void {
    const next = this.read(this.snapshot.revision + 1);
    // A storage change from another tab replaces even a memory-only credential.
    this.publish(next);
  }

  private write(token: string, remember: boolean): void {
    let persistence: AtlasCredentialSnapshot["persistence"] =
      remember && token ? "remembered" : "memory";
    let notice: string | undefined;
    try {
      if (!this.storage) throw new Error("Storage unavailable");
      if (remember && token) this.storage.setItem(ATLAS_USER_TOKEN_KEY, token);
      else this.storage.removeItem(ATLAS_USER_TOKEN_KEY);
    } catch {
      persistence = "unavailable";
      notice =
        "Browser storage is unavailable. Changes apply in this tab; a previously saved token may remain in browser storage.";
    }
    const old = this.snapshot;
    if (
      old.token === token &&
      old.remember === remember &&
      old.persistence === persistence &&
      old.notice === notice
    )
      return;
    this.publish({
      token,
      remember,
      persistence,
      notice,
      revision: old.revision + 1,
    });
  }

  private publish(snapshot: AtlasCredentialSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

export function browserAtlasCredentials(): AtlasCredentialStore {
  let storage: Storage | null = null;
  try {
    storage = localStorage;
  } catch {
    /* memory-only browser */
  }
  return new AtlasCredentialStore(
    storage,
    typeof window === "undefined" ? undefined : window,
  );
}
