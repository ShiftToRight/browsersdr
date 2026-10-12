import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
// Keep large static map assets separate from JavaScript; fetch their bundled
// URLs once for the cached background raster.
import naturalEarthOverviewUrl from "../assets/natural-earth-110m.svg?no-inline";
import naturalEarthBaseUrl from "../assets/natural-earth-10m-base.svg?no-inline";
import naturalEarthStatesUrl from "../assets/natural-earth-10m-states.svg?no-inline";
import {
  computeMapViewport,
  latitudeToY,
  longitudeForViewportX,
  longitudeToX,
  mapViewportForSurface,
  mapViewportInReference,
  panMapViewport,
  xForViewport,
  type MapViewport,
} from "./positionMapGeometry";

import {
  targetTrackPaths,
  TARGET_SYMBOL_PATHS,
  type TargetMapPresentation,
} from "./targetMapPresentation";

export interface PositionMapPoint {
  latitude: number | null;
  longitude: number | null;
  label: string;
  key?: string;
  map?: TargetMapPresentation;
}

type PlaceRow = readonly [
  longitude: number,
  latitude: number,
  name: string,
  minimumZoom: number,
  population: number,
  labelRank: number,
];

interface MapLabel {
  name: string;
  x: number;
  y: number;
}

function gridStep(degreeSpan: number): number {
  const target = degreeSpan / 7;
  return (
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 45, 90].find(
      (step) => step >= target,
    ) ?? 90
  );
}

function gridValues(start: number, end: number, step: number): number[] {
  const first = Math.ceil(start / step) * step;
  const values: number[] = [];
  for (let value = first; value <= end + step / 100; value += step)
    values.push(value);
  return values;
}

function selectLabels(
  viewport: MapViewport,
  places: readonly PlaceRow[],
): MapLabel[] {
  if (!viewport.local) return [];
  const candidates = places
    .filter(([, latitude, , minimumZoom]) => {
      const y = latitudeToY(latitude);
      return (
        minimumZoom <= viewport.zoom + 0.5 &&
        y >= viewport.y &&
        y <= viewport.y + viewport.height
      );
    })
    .map(([longitude, latitude, name, , population, labelRank]) => ({
      name,
      x: xForViewport(longitude, viewport),
      y: latitudeToY(latitude),
      population,
      labelRank,
    }))
    .filter(({ x }) => x >= viewport.x && x <= viewport.x + viewport.width)
    .sort(
      (left, right) =>
        left.labelRank - right.labelRank || right.population - left.population,
    );

  const occupied: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  }[] = [];
  const selected: MapLabel[] = [];
  for (const candidate of candidates) {
    const screenX = ((candidate.x - viewport.x) / viewport.width) * 720;
    const screenY = ((candidate.y - viewport.y) / viewport.height) * 360;
    const box = {
      left: screenX - candidate.name.length * 7 - 12,
      right: screenX + 4,
      top: screenY - 18,
      bottom: screenY,
    };
    if (
      occupied.some(
        (item) =>
          box.left < item.right &&
          box.right > item.left &&
          box.top < item.bottom &&
          box.bottom > item.top,
      )
    )
      continue;
    occupied.push(box);
    selected.push(candidate);
    if (selected.length >= 24) break;
  }
  return selected;
}

function mapLayerTransform(viewport: MapViewport) {
  const centerX = longitudeToX(viewport.centerLongitude);
  return `translate(${centerX * (1 - viewport.longitudeScale)} 0) scale(${viewport.longitudeScale} 1)`;
}

function mapLayerOffsets(viewport: MapViewport) {
  // Repeat only at the longitude seam. Replaying the entire detailed world
  // three times costs paint work even when the other copies are off screen.
  const left = longitudeForViewportX(viewport.x, viewport);
  const right = longitudeForViewportX(viewport.x + viewport.width, viewport);
  return [-720, 0, 720].filter(
    (offset) => offset / 2 - 180 < right && offset / 2 + 180 > left,
  );
}

// Assets are bundled local files. Share their text across Strict Mode mounts and
// map instances; a failed fetch remains retryable.
const mapSources = new Map<string, Promise<string>>();
function mapSource(url: string) {
  let pending = mapSources.get(url);
  if (!pending) {
    pending = fetch(url)
      .then(async (response) => {
        if (!response.ok)
          throw new Error("Map background could not be loaded.");
        const text = await response.text();
        return text
          .replace(/^[\s\S]*?<svg\b[^>]*>/, "")
          .replace(/<\/svg>\s*$/, "");
      })
      .catch((error: unknown) => {
        mapSources.delete(url);
        throw error;
      });
    mapSources.set(url, pending);
  }
  return pending;
}

// Rasterize a generous region once per held frame. Resizing the inspector/tray
// crops that bitmap; it does not decode the world SVG again.
const MapBackground = memo(function MapBackground({
  viewport,
  rasterViewport,
  detailedBoundaries,
  detail,
}: {
  viewport: MapViewport;
  rasterViewport: MapViewport;
  detailedBoundaries: boolean;
  detail: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [raster, setRaster] = useState<{
    viewport: MapViewport;
    bitmap?: HTMLCanvasElement;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    let image: HTMLImageElement | undefined;
    if (!canvas.current?.getContext("2d")) {
      setRaster({
        viewport: rasterViewport,
        error: "Map background renderer unavailable.",
      });
      return;
    }
    void (async () => {
      const layers = await Promise.all([
        mapSource(detail && rasterViewport.local ? naturalEarthBaseUrl : naturalEarthOverviewUrl),
        detail && detailedBoundaries ? mapSource(naturalEarthStatesUrl) : Promise.resolve(""),
      ]);
      if (!active) return;
      const content = mapLayerOffsets(rasterViewport)
        .map(
          (offset) =>
            `<g transform="translate(${offset} 0)">${layers.join("")}</g>`,
        )
        .join("");
      const source = `<svg xmlns="http://www.w3.org/2000/svg" width="2048" height="1024" viewBox="${rasterViewport.x} ${rasterViewport.y} ${rasterViewport.width} ${rasterViewport.height}"><g transform="${mapLayerTransform(rasterViewport)}">${content}</g></svg>`;
      url = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
      image = new Image();
      image.src = url;
      await image.decode();
      if (!active) return;
      const bitmap = document.createElement("canvas");
      bitmap.width = 2048;
      bitmap.height = 1024;
      const context = bitmap.getContext("2d");
      if (!context) throw new Error("Map background renderer unavailable.");
      context.drawImage(image, 0, 0, bitmap.width, bitmap.height);
      setRaster({ viewport: rasterViewport, bitmap });
    })()
      .catch((error: unknown) => {
        if (active)
          setRaster(previous => ({
            ...(previous?.viewport === rasterViewport ? previous : {}),
            viewport: rasterViewport,
            error:
              error instanceof Error
                ? error.message
                : "Map background unavailable.",
          }));
      })
      .finally(() => {
        if (url) URL.revokeObjectURL(url);
      });
    return () => {
      active = false;
      if (image) image.src = "";
      if (url) URL.revokeObjectURL(url);
    };
  }, [rasterViewport, detailedBoundaries, detail]);
  const ready = raster?.viewport === rasterViewport;
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    element.height = Math.max(
      1,
      Math.min(1024, Math.round((1024 * viewport.height) / viewport.width)),
    );
    if (!raster?.bitmap) return;
    const sourceViewport = mapViewportInReference(viewport, raster.viewport);
    const sx =
      ((sourceViewport.x - raster.viewport.x) / raster.viewport.width) *
      raster.bitmap.width;
    const sy =
      ((viewport.y - raster.viewport.y) / raster.viewport.height) *
      raster.bitmap.height;
    const sw =
      (sourceViewport.width / raster.viewport.width) * raster.bitmap.width;
    const sh =
      (viewport.height / raster.viewport.height) * raster.bitmap.height;
    context.drawImage(
      raster.bitmap,
      sx,
      sy,
      sw,
      sh,
      0,
      0,
      element.width,
      element.height,
    );
  }, [viewport, rasterViewport, ready, raster]);
  return (
    <>
      <canvas
        className="map-basemap"
        ref={canvas}
        width={1024}
        height={512}
        aria-hidden="true"
        data-state={ready && !raster.error ? "ready" : "loading"}
      />
      {(!ready || raster.error) && (
        <small className="map-background-status" role="status">
          {ready ? raster.error : "Loading map background…"}
        </small>
      )}
    </>
  );
});

export function PositionMap({
  points,
  label,
  selectedKey,
  onPointSelect,
  showTracks = false,
  framingKey,
  pannable = false,
}: {
  points: readonly PositionMapPoint[];
  label: string;
  selectedKey?: string;
  onPointSelect?: (key: string, trigger?: SVGElement) => void;
  showTracks?: boolean;
  /** When supplied, hold framing until this identity or the explicit Fit request changes. */
  framingKey?: string;
  pannable?: boolean;
}) {
  const positioned = useMemo(
    () =>
      points.filter(
        (
          point,
        ): point is PositionMapPoint & {
          latitude: number;
          longitude: number;
        } =>
          point.latitude !== null &&
          point.longitude !== null &&
          Number.isFinite(point.latitude) &&
          Number.isFinite(point.longitude) &&
          Math.abs(point.latitude) <= 90 &&
          Math.abs(point.longitude) <= 180,
      ),
    [points],
  );
  const automaticViewport = useMemo(
    () =>
      computeMapViewport(
        showTracks
          ? positioned.flatMap((point) => [
              point,
              ...(point.map?.track ?? [])
                .filter(
                  (fix) =>
                    Number.isFinite(fix.latitude) &&
                    Number.isFinite(fix.longitude) &&
                    Math.abs(fix.latitude) <= 90 &&
                    Math.abs(fix.longitude) <= 180,
                )
                .map((fix) => ({ ...fix, label: point.label })),
            ])
          : positioned,
      ),
    [positioned, showTracks],
  );
  const [framing, setFraming] = useState<{
    key: string;
    viewport: MapViewport;
  }>();
  if (framingKey && positioned.length && framing?.key !== framingKey) {
    setFraming({ key: framingKey, viewport: automaticViewport });
  }
  const baseViewport =
    framingKey && framing?.key === framingKey
      ? framing.viewport
      : automaticViewport;
  const [detail, setDetail] = useState(false);
  const [places, setPlaces] = useState<readonly PlaceRow[]>([]);
  const surface = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 720, height: 360 });
  const helpId = useId();
  type Pan = { frame: MapViewport; x: number; y: number };
  const [pan, setPan] = useState<Pan>();
  const [gestureFrame, setGestureFrame] = useState<MapViewport>();
  const [rasterAnchor, setRasterAnchor] = useState<{
    frame: MapViewport;
    viewport: MapViewport;
  }>();
  const pendingPan = useRef<Pan | undefined>(undefined);
  const panAnimation = useRef<number>(0);
  const suppressClick = useRef(false);
  const drag = useRef<
    | {
        pointerId: number;
        x: number;
        y: number;
        start: Pan;
        scale: number;
        moved: boolean;
      }
    | undefined
  >(undefined);
  useEffect(
    () => () => {
      if (panAnimation.current) cancelAnimationFrame(panAnimation.current);
      panAnimation.current = 0;
      pendingPan.current = undefined;
      if (
        drag.current &&
        surface.current?.hasPointerCapture(drag.current.pointerId)
      )
        surface.current.releasePointerCapture(drag.current.pointerId);
      drag.current = undefined;
    },
    [baseViewport],
  );
  useEffect(() => {
    const element = surface.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || !entry.contentRect.width || !entry.contentRect.height)
        return;
      const { width, height } = entry.contentRect;
      setSurfaceSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fittedViewport = useMemo(
    () =>
      mapViewportForSurface(
        baseViewport,
        surfaceSize.width,
        surfaceSize.height,
      ),
    [baseViewport, surfaceSize],
  );
  const currentPan = pannable && pan?.frame === baseViewport ? pan : undefined;
  const viewport = useMemo(
    () =>
      currentPan
        ? panMapViewport(fittedViewport, currentPan.x, currentPan.y)
        : fittedViewport,
    [fittedViewport, currentPan],
  );
  const anchor =
    rasterAnchor?.frame === baseViewport ? rasterAnchor.viewport : baseViewport;
  const coverageFactor = Math.max(
    4,
    Math.ceil(viewport.width / baseViewport.width),
    Math.ceil(viewport.height / baseViewport.height),
  );
  const rasterViewport = useMemo(
    () => ({
      ...anchor,
      x: anchor.x - (anchor.width * (coverageFactor - 1)) / 2,
      y: anchor.y - (anchor.height * (coverageFactor - 1)) / 2,
      width: anchor.width * coverageFactor,
      height: anchor.height * coverageFactor,
    }),
    [anchor, coverageFactor],
  );
  useEffect(() => {
    if (!detail || !viewport.local || places.length > 0) return;
    let active = true;
    void import("../assets/natural-earth-10m-places.json").then((module) => {
      if (active) setPlaces(module.default as unknown as readonly PlaceRow[]);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [detail, places.length, viewport.local]);
  const cityLabels = useMemo(
    () => detail ? selectLabels(viewport, places) : [],
    [detail, places, viewport],
  );
  const longitudeStep = gridStep(viewport.width / 2);
  const latitudeStep = gridStep(viewport.height / 2);
  const longitudes = gridValues(
    longitudeForViewportX(viewport.x, viewport),
    longitudeForViewportX(viewport.x + viewport.width, viewport),
    longitudeStep,
  );
  const latitudes = gridValues(
    90 - (viewport.y + viewport.height) / 2,
    90 - viewport.y / 2,
    latitudeStep,
  );
  const unitsPerPixel =
    1 /
    Math.min(
      surfaceSize.width / viewport.width,
      surfaceSize.height / viewport.height,
    );
  const markerRadius = unitsPerPixel * 3;
  const fontSize = unitsPerPixel * 12;
  const dragging = gestureFrame === baseViewport;
  function commitPan(next: Pan) {
    setPan(next);
    const nextViewport = mapViewportInReference(
      panMapViewport(fittedViewport, next.x, next.y),
      rasterViewport,
    );
    if (
      nextViewport.x < rasterViewport.x ||
      nextViewport.y < rasterViewport.y ||
      nextViewport.x + nextViewport.width >
        rasterViewport.x + rasterViewport.width ||
      nextViewport.y + nextViewport.height >
        rasterViewport.y + rasterViewport.height
    ) {
      setRasterAnchor({
        frame: baseViewport,
        viewport: panMapViewport(baseViewport, next.x, next.y),
      });
    }
  }
  function movePointer(event: PointerEvent<HTMLDivElement>) {
    const gesture = drag.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return;
    if (!gesture.moved) {
      gesture.moved = true;
      setGestureFrame(baseViewport);
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    pendingPan.current = {
      frame: baseViewport,
      x: gesture.start.x - dx * gesture.scale,
      y: gesture.start.y - dy * gesture.scale,
    };
    if (!panAnimation.current)
      panAnimation.current = requestAnimationFrame(() => {
        panAnimation.current = 0;
        if (pendingPan.current) setPan(pendingPan.current);
      });
  }
  function endPointer(event: PointerEvent<HTMLDivElement>, cancelled = false) {
    if (drag.current?.pointerId !== event.pointerId) return;
    suppressClick.current = !cancelled && drag.current.moved;
    if (panAnimation.current) cancelAnimationFrame(panAnimation.current);
    panAnimation.current = 0;
    if (pendingPan.current) commitPan(pendingPan.current);
    pendingPan.current = undefined;
    drag.current = undefined;
    setGestureFrame(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }

  return (
    <div className="target-plot">
      <button type="button" className="map-detail-toggle secondary" aria-pressed={detail}
        title="Load detailed local geography and city labels (up to 16 MB)" onClick={() => setDetail(!detail)}>Detailed map</button>
      <div
        className={`map-surface${pannable ? " map-surface-pannable" : ""}${dragging ? " map-surface-panning" : ""}`}
        ref={surface}
        role={pannable ? "group" : undefined}
        aria-label={pannable ? `${label} map navigation` : undefined}
        aria-describedby={pannable ? helpId : undefined}
        tabIndex={pannable ? 0 : undefined}
        onPointerDown={
          pannable
            ? (event) => {
                if (!event.isPrimary || event.button !== 0 || drag.current)
                  return;
                pendingPan.current = undefined;
                suppressClick.current = false;
                drag.current = {
                  pointerId: event.pointerId,
                  x: event.clientX,
                  y: event.clientY,
                  start: currentPan ?? { frame: baseViewport, x: 0, y: 0 },
                  scale: unitsPerPixel,
                  moved: false,
                };
                if (!(event.target as Element).closest(".map-target"))
                  event.currentTarget.focus({ preventScroll: true });
              }
            : undefined
        }
        onPointerMove={pannable ? movePointer : undefined}
        onPointerLeave={
          pannable
            ? (event) => {
                if (drag.current && !drag.current.moved)
                  endPointer(event, true);
              }
            : undefined
        }
        onPointerUp={pannable ? (event) => endPointer(event) : undefined}
        onPointerCancel={
          pannable ? (event) => endPointer(event, true) : undefined
        }
        onLostPointerCapture={
          pannable ? (event) => endPointer(event, true) : undefined
        }
        onClickCapture={
          pannable
            ? (event) => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  event.preventDefault();
                  event.stopPropagation();
                }
              }
            : undefined
        }
        onKeyDown={
          pannable
            ? (event) => {
                if (
                  event.target !== event.currentTarget ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey
                )
                  return;
                const delta: Record<string, [number, number]> = {
                  ArrowLeft: [-1, 0],
                  ArrowRight: [1, 0],
                  ArrowUp: [0, -1],
                  ArrowDown: [0, 1],
                };
                const direction = delta[event.key];
                if (!direction) return;
                event.preventDefault();
                const step = (event.shiftKey ? 120 : 40) * unitsPerPixel;
                commitPan({
                  frame: baseViewport,
                  x: (currentPan?.x ?? 0) + direction[0] * step,
                  y: (currentPan?.y ?? 0) + direction[1] * step,
                });
              }
            : undefined
        }
      >
        <MapBackground
          viewport={viewport}
          rasterViewport={rasterViewport}
          detail={detail}
          detailedBoundaries={baseViewport.zoom >= 5.5}
        />
        <svg
          className="map-overlay"
          viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
          role={onPointSelect ? "group" : "img"}
          aria-label={`${label}: ${positioned.length} positioned targets`}
        >
          <g aria-hidden="true">
            <g className="map-grid">
              {longitudes.map((longitude) => {
                const x = xForViewport(longitude, viewport);
                return (
                  <line
                    key={`longitude-${longitude}`}
                    x1={x}
                    x2={x}
                    y1={viewport.y}
                    y2={viewport.y + viewport.height}
                  />
                );
              })}
              {latitudes.map((latitude) => {
                const y = latitudeToY(latitude);
                return (
                  <line
                    key={`latitude-${latitude}`}
                    x1={viewport.x}
                    x2={viewport.x + viewport.width}
                    y1={y}
                    y2={y}
                  />
                );
              })}
            </g>
            {cityLabels.map((city) => (
              <g
                className="map-place"
                key={`${city.name}-${city.x}-${city.y}`}
                transform={`translate(${city.x} ${city.y})`}
              >
                <circle r={markerRadius * 0.45} />
                <text
                  x={-markerRadius * 1.5}
                  y={-fontSize * 0.45}
                  fontSize={fontSize}
                  strokeWidth={fontSize * 0.24}
                  textAnchor="end"
                >
                  {city.name}
                </text>
              </g>
            ))}
          </g>
          {showTracks &&
            positioned.map(
              (point) =>
                point.map && (
                  <g
                    key={point.key ?? point.label}
                    className={`map-track${point.key === selectedKey ? " map-track-selected" : ""}`}
                    aria-hidden="true"
                  >
                    {targetTrackPaths(
                      point.map.track,
                      viewport,
                      point.map.maximumGapMs,
                    ).map((path, index) => (
                      <path key={index} d={path} />
                    ))}
                  </g>
                ),
            )}
          {positioned.map((point, index) => {
            const x = xForViewport(point.longitude, viewport);
            const y = latitudeToY(point.latitude);
            return (
              <g
                className={`map-target${point.key === selectedKey && selectedKey ? " map-target-selected" : ""}`}
                key={point.key ?? `${point.label}-${index}`}
                transform={`translate(${x} ${y})`}
                role={point.key && onPointSelect ? "button" : undefined}
                tabIndex={point.key && onPointSelect ? 0 : undefined}
                aria-label={
                  point.key && onPointSelect
                    ? `Inspect ${point.label}`
                    : undefined
                }
                aria-pressed={
                  point.key && onPointSelect
                    ? point.key === selectedKey
                    : undefined
                }
                onClick={
                  point.key && onPointSelect
                    ? (event) => onPointSelect(point.key!, event.currentTarget)
                    : undefined
                }
                onKeyDown={
                  point.key && onPointSelect
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onPointSelect(point.key!, event.currentTarget);
                        }
                      }
                    : undefined
                }
                style={
                  onPointSelect
                    ? { cursor: dragging ? "grabbing" : "pointer" }
                    : undefined
                }
              >
                {onPointSelect && (
                  <circle className="map-target-hit" r={unitsPerPixel * 22} />
                )}
                {point.map && point.map.symbol !== "generic" ? (
                  <path
                    className="map-target-symbol"
                    data-symbol={point.map.symbol}
                    d={TARGET_SYMBOL_PATHS[point.map.symbol]}
                    transform={`rotate(${Number.isFinite(point.map.direction) ? point.map.direction : 0}) scale(${markerRadius / 5})`}
                  />
                ) : (
                  <circle r={markerRadius} />
                )}
                {positioned.length <= 20 && (
                  <text
                    x={markerRadius * 1.7}
                    y={fontSize * 1.25}
                    fontSize={fontSize}
                    strokeWidth={fontSize * 0.28}
                  >
                    {point.label}
                  </text>
                )}
                <title>
                  {point.label}
                  {point.map
                    ? ` · ${point.map.categoryLabel}${point.map.direction == null ? " · direction unknown" : ""}`
                    : ""}
                </title>
              </g>
            );
          })}
        </svg>
      </div>
      <small id={helpId}>
        {pannable &&
          "Drag to move · Arrow keys to pan · Fit targets to reset · "}
        {viewport.local
          ? `Natural Earth ${detail ? "1:10m" : "1:110m overview"} · ${framingKey ? (pannable ? "view held" : "framing held; Fit targets to update") : "auto-framed"} · ${positioned.length} transmitted position${positioned.length === 1 ? "" : "s"} · minimum 50 km radius context`
          : "Public-domain Natural Earth overview · waiting for transmitted coordinates"}
      </small>
      {positioned.some((point) => point.map) && (
        <small>
          {positioned.some((point) => point.map?.symbol !== "vessel") &&
            "Symbols: rotorcraft · light/small plane · large/heavy plane · dot for other/unknown categories. "}
          {showTracks
            ? "Tracks: last 32 distinct received fixes per target; gaps are separated."
            : "Tracks hidden."}
        </small>
      )}
    </div>
  );
}
