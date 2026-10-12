export interface PositionedMapPoint {
  latitude: number;
  longitude: number;
  label: string;
}

export interface MapViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  zoom: number;
  centerLongitude: number;
  longitudeScale: number;
  local: boolean;
}

const WORLD_VIEWPORT: MapViewport = {
  x: 0,
  y: 0,
  width: 720,
  height: 360,
  zoom: 0,
  centerLongitude: 0,
  longitudeScale: 1,
  local: false,
};
const MINIMUM_RADIUS_KM = 50;
const KM_PER_LATITUDE_DEGREE = 111.32;

function unwrapLongitude(longitude: number, reference: number): number {
  return reference + ((((longitude - reference) % 360) + 540) % 360) - 180;
}

export function longitudeToX(longitude: number): number {
  return (longitude + 180) * 2;
}

export function latitudeToY(latitude: number): number {
  return (90 - latitude) * 2;
}

export function xForViewport(longitude: number, viewport: MapViewport): number {
  const centerX = longitudeToX(viewport.centerLongitude);
  const x = longitudeToX(unwrapLongitude(longitude, viewport.centerLongitude));
  return centerX + (x - centerX) * viewport.longitudeScale;
}

export function longitudeForViewportX(
  x: number,
  viewport: MapViewport,
): number {
  const centerX = longitudeToX(viewport.centerLongitude);
  const unprojectedX = centerX + (x - centerX) / viewport.longitudeScale;
  return unprojectedX / 2 - 180;
}

export function computeMapViewport(
  points: readonly PositionedMapPoint[],
): MapViewport {
  if (points.length === 0) return WORLD_VIEWPORT;

  const referenceLongitude = points[0]!.longitude;
  const longitudes = points.map((point) =>
    unwrapLongitude(point.longitude, referenceLongitude),
  );
  const latitudes = points.map((point) => point.latitude);
  const centerLongitude =
    (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const centerLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const cosine = Math.max(Math.cos((centerLatitude * Math.PI) / 180), 0.2);
  const minimumLatitudeSpan = (MINIMUM_RADIUS_KM * 2) / KM_PER_LATITUDE_DEGREE;
  const centerX = longitudeToX(centerLongitude);
  const projectedXs = longitudes.map(
    (longitude) => centerX + (longitudeToX(longitude) - centerX) * cosine,
  );
  let width = Math.max(
    (Math.max(...projectedXs) - Math.min(...projectedXs)) * 1.3,
    minimumLatitudeSpan * 2,
  );
  let height = Math.max(
    (Math.max(...latitudes) - Math.min(...latitudes)) * 2 * 1.3,
    minimumLatitudeSpan * 2,
  );

  if (width / height < 2) width = height * 2;
  else height = width / 2;
  width = Math.min(width, 720);
  height = Math.min(height, 360);

  const centerY = latitudeToY(centerLatitude);
  const y = Math.max(0, Math.min(centerY - height / 2, 360 - height));
  return {
    x: centerX - width / 2,
    y,
    width,
    height,
    zoom: Math.log2(720 / width),
    centerLongitude,
    longitudeScale: cosine,
    local: width < 720,
  };
}

/** Expand context to fill the surface without cropping the fitted targets. */
export function mapViewportForSurface(
  viewport: MapViewport,
  surfaceWidth: number,
  surfaceHeight: number,
): MapViewport {
  if (!viewport.local || surfaceWidth <= 0 || surfaceHeight <= 0)
    return viewport;
  const aspect = surfaceWidth / surfaceHeight;
  const width = Math.max(viewport.width, viewport.height * aspect);
  const height = Math.max(viewport.height, viewport.width / aspect);
  return {
    ...viewport,
    x: viewport.x - (width - viewport.width) / 2,
    y: viewport.y - (height - viewport.height) / 2,
    width,
    height,
    zoom: Math.log2(720 / width),
  };
}

/** Move in projected map units; wrap longitude and keep the view within the poles. */
export function panMapViewport(
  viewport: MapViewport,
  dx: number,
  dy: number,
): MapViewport {
  const longitude =
    viewport.centerLongitude + dx / (2 * viewport.longitudeScale);
  const centerLongitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return {
    ...viewport,
    centerLongitude,
    x: longitudeToX(centerLongitude) - viewport.width / 2,
    y:
      viewport.height >= 360
        ? (360 - viewport.height) / 2
        : Math.max(0, Math.min(360 - viewport.height, viewport.y + dy)),
  };
}

/** Locate a viewport in the cached bitmap's longitude/projection reference. */
export function mapViewportInReference(
  viewport: MapViewport,
  reference: MapViewport,
): MapViewport {
  return {
    ...viewport,
    x: xForViewport(longitudeForViewportX(viewport.x, viewport), reference),
    width:
      (viewport.width * reference.longitudeScale) / viewport.longitudeScale,
  };
}
