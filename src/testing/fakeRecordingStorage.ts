import { vi } from "vitest";

export function fakeRecordingStorage() {
  let fail = "";
  class Directory {
    kind = "directory";
    children = new Map<string, Directory | Blob>();
    async getDirectoryHandle(
      name: string,
      options?: { create?: boolean },
    ): Promise<Directory> {
      if (!this.children.has(name) && options?.create)
        this.children.set(name, new Directory());
      const child = this.children.get(name);
      if (!(child instanceof Directory))
        throw new DOMException("missing", "NotFoundError");
      return child;
    }
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!this.children.has(name) && options?.create)
        this.children.set(name, new Blob());
      if (!this.children.has(name))
        throw new DOMException("missing", "NotFoundError");
      return {
        getFile: async () => this.children.get(name) as Blob,
        createWritable: async () => {
          let pending = new Blob();
          return {
            write: async (value: BlobPart) => {
              if (name === fail)
                throw new DOMException("quota exhausted", "QuotaExceededError");
              pending = new Blob([value]);
            },
            close: async () => {
              this.children.set(name, pending);
            },
            abort: async () => undefined,
          };
        },
      };
    }
    async removeEntry(name: string) {
      this.children.delete(name);
    }
    async *entries() {
      for (const [name, child] of this.children)
        yield [
          name,
          { kind: child instanceof Directory ? "directory" : "file" },
        ];
    }
  }
  const root = new Directory();
  const locks = new Set<string>();
  const crashes: (() => void)[] = [];
  const getDirectory = vi.fn(async () => root);
  vi.stubGlobal("navigator", {
    storage: { getDirectory },
    locks: {
      request: async (
        name: string,
        optionsOrCallback: unknown,
        callback?: (lock: object | null) => Promise<unknown>,
      ) => {
        const fn =
          callback ??
          (optionsOrCallback as (lock: object | null) => Promise<unknown>);
        if (locks.has(name)) return fn(null);
        locks.add(name);
        const crashed = new Promise<void>((resolve) => crashes.push(resolve));
        try {
          return await Promise.race([fn({}), crashed]);
        } finally {
          locks.delete(name);
        }
      },
    },
  });
  return {
    root,
    getDirectory,
    fail: (name: string) => {
      fail = name;
    },
    crash: async () => {
      crashes.splice(0).forEach((fn) => fn());
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
