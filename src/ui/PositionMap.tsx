import { useEffect, useMemo, useState } from "react";
// Fragment-addressed external <use> elements need a fetched SVG document.
// Keep Vite from replacing these assets with data URLs, which lose that document.
import naturalEarthOverviewUrl from "../assets/natural-earth-110m.svg?no-inline";
import naturalEarthBaseUrl from "../assets/natural-earth-10m-base.svg?no-inline";
import naturalEarthStatesUrl from "../assets/natural-earth-10m-states.svg?no-inline";
import {
  computeMapViewport,
  latitudeToY,
  longitudeForViewportX,
  longitudeToX,
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

function RepeatedMapLayer({
  href,
  viewport,
}: {
  href: string;
  viewport: MapViewport;
}) {
  const centerX = longitudeToX(viewport.centerLongitude);
  const projection =
    viewport.longitudeScale === 1
      ? undefined
      : `translate(${centerX * (1 - viewport.longitudeScale)} 0) scale(${viewport.longitudeScale} 1)`;
  return (
    <g transform={projection}>
      {[-720, 0, 720].map((offset) => (
        <use key={offset} href={href} transform={`translate(${offset} 0)`} />
      ))}
    </g>
  );
}

export function PositionMap({
  points,
  label,
  selectedKey,
  onPointSelect,
  showTracks = false,
}: {
  points: readonly PositionMapPoint[];
  label: string;
  selectedKey?: string;
  onPointSelect?: (key: string) => void;
  showTracks?: boolean;
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
  const viewport = useMemo(
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
  const [places, setPlaces] = useState<readonly PlaceRow[]>([]);
  useEffect(() => {
    if (!viewport.local || places.length > 0) return;
    let active = true;
    void import("../assets/natural-earth-10m-places.json").then((module) => {
      if (active) setPlaces(module.default as unknown as readonly PlaceRow[]);
    });
    return () => {
      active = false;
    };
  }, [places.length, viewport.local]);
  const cityLabels = useMemo(
    () => selectLabels(viewport, places),
    [places, viewport],
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
  const markerRadius = (viewport.height * 4) / 360;
  const fontSize = (viewport.height * 12) / 360;
  const mapHref = viewport.local
    ? `${naturalEarthBaseUrl}#natural-earth-base`
    : `${naturalEarthOverviewUrl}#natural-earth-overview`;

  return (
    <div className="target-plot">
      <svg
        viewBox={`${viewport.x} ${viewport.y} ${viewport.width} ${viewport.height}`}
        role="img"
        aria-label={`${label}: ${positioned.length} positioned targets`}
      >
        <rect
          x={viewport.x}
          y={viewport.y}
          width={viewport.width}
          height={viewport.height}
        />
        <g aria-hidden="true">
          <RepeatedMapLayer href={mapHref} viewport={viewport} />
          {viewport.zoom >= 5.5 && (
            <RepeatedMapLayer
              href={`${naturalEarthStatesUrl}#natural-earth-states`}
              viewport={viewport}
            />
          )}
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
              key={`${point.label}-${point.latitude}-${point.longitude}-${index}`}
              transform={`translate(${x} ${y})`}
              onClick={
                point.key && onPointSelect
                  ? () => onPointSelect(point.key!)
                  : undefined
              }
              style={onPointSelect ? { cursor: "pointer" } : undefined}
            >
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
      <small>
        {viewport.local
          ? `Natural Earth 1:10m · auto-framed around ${positioned.length} transmitted position${positioned.length === 1 ? "" : "s"} · minimum 50 km radius context`
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
