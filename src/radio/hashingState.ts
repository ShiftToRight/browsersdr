import { IncrementalSha256 } from "./sha256";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const HASH_CHUNK_BYTES = 1024 * 1024;
export type HashReply = { digest?: string; partHash?: string; error?: string };
export type HashRequest = {
  algorithm: "sha256" | "sha512";
  bytes?: Uint8Array<ArrayBuffer>;
  endPart?: boolean;
};

/** Shared exact digest semantics for workers and cooperative non-browser tests. */
export class HashState {
  private whole256 = new IncrementalSha256();
  private part = new IncrementalSha256();
  private whole512 = sha512.create();
  process(input: HashRequest): HashReply {
    if (!input.bytes)
      return {
        digest:
          input.algorithm === "sha256"
            ? this.whole256.hex()
            : bytesToHex(this.whole512.digest()),
      };
    if (input.bytes.length > HASH_CHUNK_BYTES)
      throw new Error("Hash chunk exceeds 1 MiB.");
    if (input.algorithm === "sha512") this.whole512.update(input.bytes);
    else {
      this.whole256.update(input.bytes);
      this.part.update(input.bytes);
    }
    if (input.endPart) {
      const partHash = this.part.hex();
      this.part = new IncrementalSha256();
      return { partHash };
    }
    return {};
  }
}
