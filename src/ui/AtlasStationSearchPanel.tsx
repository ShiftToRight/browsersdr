import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AtlasConnection } from "../radio/atlasConnection";
import {
  AtlasStationSearch,
  atlasStationSearchMessage,
} from "../radio/atlasStationSearch";
import { stationQueryFromMHz, type AtlasStation } from "../radio/atlasStations";
import {
  atlasStationListUrl,
  atlasStationUrl,
} from "../radio/atlasStationNavigation";
import {
  atlasReceptionCandidate,
  atlasReferenceMode,
} from "../radio/atlasStationSelection";
import type { ReceptionCandidate } from "../radio/receptionEvidence";

function StationResult({
  station,
  connection,
  blockedReason,
  onUse,
  onFavorite,
}: {
  station: AtlasStation;
  connection: AtlasConnection;
  blockedReason?: string;
  onUse: (candidate: ReceptionCandidate) => Promise<string>;
  onFavorite?: (candidate: ReceptionCandidate) => void;
}) {
  const [selected, setSelected] = useState(
    station.transmissions.length === 1 ? station.transmissions[0]!.id : "",
  );
  const [manualMode, setManualMode] = useState<ReceptionCandidate["mode"] | "">(
    "",
  );
  const [message, setMessage] = useState("");
  const [using, setUsing] = useState(false);
  const aborter = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      aborter.current?.abort();
    },
    [],
  );
  const reference = station.transmissions.find((t) => t.id === selected);
  const mappedMode = reference
    ? atlasReferenceMode(reference.broadcast_format)
    : undefined;
  let link: string | undefined;
  try {
    link = atlasStationUrl(station.id, reference?.id);
  } catch {
    /* Configuration error shown by the parent. */
  }
  const use = async () => {
    if (!reference || using || blockedReason) return;
    const owner = new AbortController();
    aborter.current = owner;
    setUsing(true);
    setMessage("");
    try {
      // Re-resolve a current reference. A retired or edited row cannot silently tune elsewhere.
      const current = await connection.read(
        (signal) => connection.client.getStation(station.id, signal),
        owner.signal,
      );
      owner.signal.throwIfAborted();
      const proposed = atlasReceptionCandidate(
        current,
        selected,
        manualMode || undefined,
      );
      const original = atlasReceptionCandidate(
        station,
        selected,
        manualMode || undefined,
      );
      if (
        proposed.frequency_hz !== original.frequency_hz ||
        proposed.bandwidth_hz !== original.bandwidth_hz ||
        proposed.mode !== original.mode
      )
        throw new Error(
          "The reference changed. Search again before selecting it.",
        );
      const result = await onUse(proposed);
      if (!owner.signal.aborted) setMessage(result);
    } catch (error) {
      if (!owner.signal.aborted)
        setMessage(
          error instanceof Error &&
            !(error.name === "AtlasRequestError") &&
            !(error instanceof TypeError)
            ? error.message
            : atlasStationSearchMessage(error),
        );
    } finally {
      if (!owner.signal.aborted) setUsing(false);
    }
  };
  return (
    <article className="atlas-station-result" aria-label={station.name}>
      <h4>{station.name}</h4>
      <p>
        {[station.service, station.country, station.call_sign, station.network]
          .filter(Boolean)
          .join(" · ") || "Catalog station"}
      </p>
      {station.aliases.length > 0 && (
        <p className="display-note">Aliases: {station.aliases.join(", ")}</p>
      )}
      {station.transmissions.length === 0 ? (
        <p>
          No transmission references. This station can still be opened in Atlas.
        </p>
      ) : (
        <>
          <label>
            Transmission for {station.name}
            <select
              value={selected}
              disabled={using}
              onChange={(event) => {
                setSelected(event.currentTarget.value);
                setManualMode("");
                setMessage("");
              }}
            >
              <option value="">Choose a transmission</option>
              {station.transmissions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.frequency_hz / 1e6} MHz ·{" "}
                  {t.broadcast_format ?? "Unknown format"} ·{" "}
                  {t.site?.name ?? t.site?.place_name ?? "Unknown site"} ·{" "}
                  {t.verification_state} reference
                </option>
              ))}
            </select>
          </label>
          <ul className="atlas-reference-list">
            {station.transmissions.map((t) => (
              <li key={t.id}>
                {t.frequency_hz / 1e6} MHz ·{" "}
                {t.broadcast_format ?? "Unknown format"} ·{" "}
                {[t.site?.name, t.site?.place_name, t.site?.country]
                  .filter(Boolean)
                  .join(", ") || "Unknown site"}{" "}
                · {t.verification_state} catalog reference
                {t.bandwidth_hz !== null &&
                  ` · ${t.bandwidth_hz.toLocaleString()} Hz bandwidth`}
              </li>
            ))}
          </ul>
          {reference && !mappedMode && (
            <label>
              Receive mode for unknown or unsupported format
              <select
                value={manualMode}
                disabled={using}
                onChange={(event) =>
                  setManualMode(
                    event.currentTarget.value as
                      ReceptionCandidate["mode"] | "",
                  )
                }
              >
                <option value="">Choose a supported mode deliberately</option>
                <option>WBFM</option>
                <option>AM</option>
                <option>NBFM</option>
              </select>
            </label>
          )}
        </>
      )}
      <div className="atlas-station-actions">
        {link && (
          <a href={link} target="_blank" rel="noopener noreferrer">
            Open in SigIntAtlas
          </a>
        )}
        {station.transmissions.length > 0 && (
          <button
            type="button"
            disabled={
              using ||
              Boolean(blockedReason) ||
              !reference ||
              (!mappedMode && !manualMode)
            }
            onClick={() => void use()}
          >
            Use in receiver
          </button>
        )}
        {onFavorite && station.transmissions.length > 0 && <button type="button" className="secondary" disabled={using || !reference || (!mappedMode && !manualMode)} onClick={() => {
          try { onFavorite(atlasReceptionCandidate(station, selected, manualMode || undefined)); setMessage("Favorite saved locally. Catalog reference has not been rechecked; station identity is unconfirmed."); }
          catch (error) { setMessage(error instanceof Error ? error.message : "Could not save favorite."); }
        }}>Save station favorite</button>}
      </div>
      {using && (
        <p role="status">
          Checking the current reference and applying receiver settings…
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </article>
  );
}

export function AtlasStationSearchPanel({
  connection,
  channelFrequencyHz,
  channelBandwidthHz,
  candidate,
  blockedReason,
  onUse,
  onFavorite,
  onOpenSettings,
}: {
  connection: AtlasConnection;
  channelFrequencyHz: number;
  channelBandwidthHz: number;
  candidate?: ReceptionCandidate;
  blockedReason?: string;
  onUse: (candidate: ReceptionCandidate) => Promise<string>;
  onFavorite?: (candidate: ReceptionCandidate) => void;
  onOpenSettings: () => void;
}) {
  const [search] = useState(() => new AtlasStationSearch(connection));
  useEffect(() => search.observe(), [search]);
  const state = useSyncExternalStore(search.subscribe, search.getSnapshot);
  const credential = useSyncExternalStore(
    connection.credentials.subscribe,
    connection.credentials.getSnapshot,
  );
  const [q, setQ] = useState("");
  const [minimum, setMinimum] = useState("");
  const [maximum, setMaximum] = useState("");
  const [validation, setValidation] = useState("");
  const edit = () => {
    search.clear();
    setValidation("");
  };
  let listLink: string | undefined, linkError: string | undefined;
  try {
    listLink = atlasStationListUrl(stationQueryFromMHz(q, minimum, maximum));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Configure"))
      linkError = error.message;
  }
  const submit = () => {
    setValidation("");
    try {
      void search.search(stationQueryFromMHz(q, minimum, maximum));
    } catch (error) {
      setValidation(
        error instanceof Error ? error.message : "Check the search filters.",
      );
    }
  };
  return (
    <details className="atlas-station-search">
      <summary>Find station in SigIntAtlas</summary>
      <div className="atlas-station-search-body">
        <p className="display-note">
          Catalog references propose a station; they do not identify a received
          signal. Atlas may require a separate sign-in when opened.
        </p>
        {candidate && (
          <p>
            Receiver candidate: {candidate.station_name ?? "Catalog station"} ·{" "}
            {candidate.frequency_hz / 1e6} MHz. Start remains manual.
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label>
            Station text
            <input
              type="search"
              maxLength={200}
              value={q}
              onChange={(event) => {
                edit();
                setQ(event.currentTarget.value);
              }}
            />
          </label>
          <div className="atlas-station-frequency">
            <label>
              Minimum frequency (MHz)
              <input
                type="number"
                min={0}
                max={1000000}
                step="any"
                value={minimum}
                onChange={(event) => {
                  edit();
                  setMinimum(event.currentTarget.value);
                }}
              />
            </label>
            <label>
              Maximum frequency (MHz)
              <input
                type="number"
                min={0}
                max={1000000}
                step="any"
                value={maximum}
                onChange={(event) => {
                  edit();
                  setMaximum(event.currentTarget.value);
                }}
              />
            </label>
          </div>
          <p className="display-note">
            Optional window includes the minimum and excludes the maximum. A
            matching station can have other references outside the window.
          </p>
          <div className="atlas-station-actions">
            <button
              type="button"
              className="secondary"
              disabled={
                !Number.isFinite(channelFrequencyHz) ||
                !Number.isFinite(channelBandwidthHz)
              }
              onClick={() => {
                edit();
                setMinimum(
                  String(
                    Math.max(0, channelFrequencyHz - channelBandwidthHz / 2) /
                      1e6,
                  ),
                );
                setMaximum(
                  String(
                    Math.min(
                      1e12,
                      channelFrequencyHz + channelBandwidthHz / 2,
                    ) / 1e6,
                  ),
                );
              }}
            >
              Around channel
            </button>
            <button type="submit" disabled={state.status === "loading"}>
              Search stations
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                edit();
                setQ("");
                setMinimum("");
                setMaximum("");
              }}
            >
              Clear search
            </button>
            <button
              type="button"
              className="secondary"
              onClick={onOpenSettings}
            >
              Atlas settings
            </button>
            {listLink && (
              <a href={listLink} target="_blank" rel="noopener noreferrer">
                Open station list
              </a>
            )}
          </div>
        </form>
        {!credential.token && (
          <p role="status">
            Configure a SigIntAtlas token in Settings before searching.
          </p>
        )}
        {validation && <p role="alert">{validation}</p>}
        {linkError && <p role="alert">{linkError}</p>}
        {state.status === "loading" && (
          <p role="status">Searching SigIntAtlas…</p>
        )}
        {state.message && (
          <p role={state.status === "error" ? "alert" : "status"}>
            {state.message}
          </p>
        )}
        {blockedReason && <p className="display-note">{blockedReason}</p>}
        {state.status === "ready" && (
          <>
            <p role="status">
              {state.page!.items.length
                ? `Page ${state.pageIndex + 1} · ${state.page!.items.length} station${state.page!.items.length === 1 ? "" : "s"}`
                : "No stations match these filters."}
            </p>
            <div className="atlas-station-results">
              {state.page!.items.map((station) => (
                <StationResult
                  key={station.id}
                  station={station}
                  connection={connection}
                  blockedReason={blockedReason}
                  onUse={onUse}
                  onFavorite={onFavorite}
                />
              ))}
            </div>
            <div className="atlas-station-actions" aria-label="Station pages">
              <button
                type="button"
                className="secondary"
                disabled={!state.previous}
                onClick={() => void search.previous()}
              >
                Previous stations
              </button>
              <button
                type="button"
                className="secondary"
                disabled={!state.next}
                onClick={() => void search.next()}
              >
                Next stations
              </button>
            </div>
          </>
        )}
      </div>
    </details>
  );
}
