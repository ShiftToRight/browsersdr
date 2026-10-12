import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import type {
  CommunityBuild,
  CommunityReport,
  CommunityMatrix,
} from "../../src/diagnostics/communityTypes";
export const COMMUNITY_FEATURE_MODES: Record<string, string | null>;
export const COMMUNITY_HARDWARE: Record<string, string>;
export function validateCommunityReport(value: unknown): string | null;
export function validateReport(value: unknown): string | null;
export function sanitizeCommunityReport(
  value: CommunityReport,
): Omit<CommunityReport, "participantToken">;
export interface CommunityStore {
  accept(value: CommunityReport): {
    status: number;
    body: { reference?: string; receipt?: string; error?: string };
  };
  matrix(buildId?: string | null): CommunityMatrix | null;
  registerBuild(build: CommunityBuild | object): boolean;
  review(
    reference: string,
    state: "accepted" | "excluded" | "resolved",
  ): boolean;
  withdraw(value: { reference: string; receipt: string }): boolean;
  purge(now: string): void;
}
export function createCommunityStore(
  database: DatabaseSync,
  options?: {
    communityBuilds?: CommunityBuild[];
    communityReleasePath?: string | null;
  },
): CommunityStore;
export function createReportServer(options?: {
  database?: DatabaseSync;
  databasePath?: string;
  allowedOrigin?: string;
  communityBuilds?: CommunityBuild[];
  communityReleasePath?: string | null;
  cleanupIntervalMs?: number;
}): {
  server: Server;
  database: DatabaseSync;
  community: CommunityStore;
  purgeExpired(now?: Date): void;
};
