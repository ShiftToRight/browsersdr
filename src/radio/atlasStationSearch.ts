import { AtlasRequestError } from "./atlasClient";
import type { AtlasConnection } from "./atlasConnection";
import {
  stationQueryParams,
  type AtlasStationQuery,
  type AtlasStationPage,
} from "./atlasStations";
export const ATLAS_STATION_MAX_PAGES = 20;
export interface AtlasStationSearchSnapshot {
  status: "idle" | "loading" | "ready" | "error";
  query: AtlasStationQuery;
  page?: AtlasStationPage;
  pageIndex: number;
  previous: boolean;
  next: boolean;
  message?: string;
}
export function atlasStationSearchMessage(error: unknown): string {
  if (error instanceof AtlasRequestError) {
    if (error.code === "transfer_active")
      return "This transfer owns the session. Retry search when the transfer finishes.";
    if (error.status === 401)
      return "Token rejected or session expired. Check Settings and retry search.";
    if (error.status === 403)
      return "Station access denied. Check your permissions and API proxy configuration.";
    if (error.status === 429)
      return "Login is rate limited. Wait before retrying search.";
    if (error.status === 422)
      return "Search filters or page cursor were rejected. Clear the search and try again.";
    if ([404, 405, 502, 503, 504].includes(error.status))
      return "Station service or API proxy unavailable. Check the station read routes and retry.";
    return "Station search failed. Retry or check the API service.";
  }
  if (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError")
  )
    return "Station search could not reach SigIntAtlas. Check your network and retry.";
  return "Station search returned an invalid response. Check the API proxy/version and retry.";
}
/** One 50-row page, at most 20 opaque cursors, no polling or shared user caches. */
export class AtlasStationSearch {
  private snapshot: AtlasStationSearchSnapshot = {
    status: "idle",
    query: {},
    pageIndex: 0,
    previous: false,
    next: false,
  };
  private cursors: Array<string | undefined> = [undefined];
  private aborter?: AbortController;
  private generation = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readonly connection: AtlasConnection) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  observe(): () => void {
    const credential = this.connection.credentials.subscribe(() =>
      this.clear(),
    );
    const connection = this.connection.subscribe(() => {
      if (
        ["disconnected", "disconnecting"].includes(
          this.connection.getSnapshot().status,
        )
      )
        this.clear();
    });
    return () => {
      credential();
      connection();
      this.cancel();
    };
  }
  cancel(): void {
    this.generation++;
    this.aborter?.abort();
    this.aborter = undefined;
  }
  clear(): void {
    this.cancel();
    this.cursors = [undefined];
    this.publish({
      status: "idle",
      query: {},
      pageIndex: 0,
      previous: false,
      next: false,
    });
  }
  async search(query: AtlasStationQuery): Promise<void> {
    stationQueryParams({ ...query, cursor: undefined });
    this.cursors = [undefined];
    await this.load({ ...query, cursor: undefined }, 0);
  }
  async next(): Promise<void> {
    if (!this.snapshot.next || this.snapshot.status !== "ready") return;
    const index = this.snapshot.pageIndex + 1;
    this.cursors[index] = this.snapshot.page!.next_cursor!;
    await this.load(this.snapshot.query, index);
  }
  async previous(): Promise<void> {
    if (!this.snapshot.previous || this.snapshot.status !== "ready") return;
    await this.load(this.snapshot.query, this.snapshot.pageIndex - 1);
  }
  private async load(query: AtlasStationQuery, index: number): Promise<void> {
    this.cancel();
    const generation = this.generation,
      revision = this.connection.credentials.getSnapshot().revision;
    const aborter = new AbortController();
    this.aborter = aborter;
    this.publish({
      status: "loading",
      query,
      pageIndex: index,
      previous: false,
      next: false,
    });
    if (!this.connection.credentials.getSnapshot().token) {
      this.publish({
        ...this.snapshot,
        status: "error",
        message: "Configure a SigIntAtlas token in Settings before searching.",
      });
      return;
    }
    try {
      const page = await this.connection.read(
        (signal) =>
          this.connection.client.listStations(
            { ...query, cursor: this.cursors[index] },
            signal,
          ),
        aborter.signal,
      );
      if (
        generation !== this.generation ||
        aborter.signal.aborted ||
        revision !== this.connection.credentials.getSnapshot().revision
      )
        return;
      const repeated =
        page.next_cursor !== null &&
        this.cursors.slice(0, index + 1).includes(page.next_cursor);
      const bounded = index + 1 >= ATLAS_STATION_MAX_PAGES;
      this.publish({
        status: "ready",
        query,
        page,
        pageIndex: index,
        previous: index > 0,
        next: page.next_cursor !== null && !bounded && !repeated,
        message: repeated
          ? "The service repeated a page cursor. Narrow the search or start again."
          : bounded && page.next_cursor
            ? "Page limit reached. Narrow the search to see more stations."
            : undefined,
      });
    } catch (error) {
      if (generation !== this.generation || aborter.signal.aborted) return;
      this.publish({
        ...this.snapshot,
        status: "error",
        message: atlasStationSearchMessage(error),
      });
    }
  }
  private publish(snapshot: AtlasStationSearchSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
