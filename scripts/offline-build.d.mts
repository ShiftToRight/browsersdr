import type { Plugin } from "vite";
export function offlineApp(): Plugin;
export function writeOfflineWorker(directory: string): Promise<{
  version: string;
  entries: { url: string; sha256: string; size: number }[];
}>;
