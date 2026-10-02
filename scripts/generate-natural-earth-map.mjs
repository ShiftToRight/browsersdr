import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const [landPath, lakesPath, riversPath, countriesPath, statesPath, placesPath, outputBase, outputStates, outputPlaces] =
  process.argv.slice(2);

if (
  !landPath ||
  !lakesPath ||
  !riversPath ||
  !countriesPath ||
  !statesPath ||
  !placesPath ||
  !outputBase ||
  !outputStates ||
  !outputPlaces
) {
  throw new Error(
    "Usage: node scripts/generate-natural-earth-map.mjs LAND.geojson LAKES.geojson RIVERS.geojson COUNTRIES.geojson STATES.geojson PLACES.geojson BASE.svg STATES.svg PLACES.json",
  );
}

const readCollection = async (path) => {
  const collection = JSON.parse(await readFile(path, "utf8"));
  if (collection.type !== "FeatureCollection")
    throw new Error(`${path} is not a GeoJSON FeatureCollection.`);
  return collection;
};

const [land, lakes, rivers, countries, states, places] = await Promise.all([
  readCollection(landPath),
  readCollection(lakesPath),
  readCollection(riversPath),
  readCollection(countriesPath),
  readCollection(statesPath),
  readCollection(placesPath),
]);

const number = (value) => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

const SIMPLIFICATION_TOLERANCE = 0.002;

const squaredSegmentDistance = (point, start, end) => {
  let x = start[0];
  let y = start[1];
  const dx = end[0] - x;
  const dy = end[1] - y;
  if (dx !== 0 || dy !== 0) {
    const progress =
      ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (progress > 1) {
      x = end[0];
      y = end[1];
    } else if (progress > 0) {
      x += dx * progress;
      y += dy * progress;
    }
  }
  const offsetX = point[0] - x;
  const offsetY = point[1] - y;
  return offsetX * offsetX + offsetY * offsetY;
};

const simplifyLine = (line, close) => {
  const source = close ? line.slice(0, -1) : line;
  if (source.length <= 2) return line;
  const keep = new Uint8Array(source.length);
  keep[0] = 1;
  keep[source.length - 1] = 1;
  const threshold = SIMPLIFICATION_TOLERANCE * SIMPLIFICATION_TOLERANCE;
  const ranges = [[0, source.length - 1]];
  while (ranges.length > 0) {
    const [start, end] = ranges.pop();
    let furthest = threshold;
    let selected = -1;
    for (let index = start + 1; index < end; index += 1) {
      const distance = squaredSegmentDistance(
        source[index],
        source[start],
        source[end],
      );
      if (distance > furthest) {
        furthest = distance;
        selected = index;
      }
    }
    if (selected >= 0) {
      keep[selected] = 1;
      ranges.push([start, selected], [selected, end]);
    }
  }
  const result = source.filter((_, index) => keep[index] === 1);
  if (close) result.push(result[0]);
  return result;
};

const point = ([longitude, latitude]) =>
  `${number((longitude + 180) * 2)},${number((90 - latitude) * 2)}`;

const linePath = (line, close = false) => {
  const projected = simplifyLine(line, close).map(point).filter((value, index, values) => {
    return index === 0 || value !== values[index - 1];
  });
  return projected.length > 1
    ? `M${projected.join(" ")}${close ? "Z" : ""}`
    : "";
};

const geometryPath = (geometry) => {
  if (!geometry) return "";
  switch (geometry.type) {
    case "LineString":
      return linePath(geometry.coordinates);
    case "MultiLineString":
      return geometry.coordinates.map((line) => linePath(line)).join("");
    case "Polygon":
      return geometry.coordinates.map((ring) => linePath(ring, true)).join("");
    case "MultiPolygon":
      return geometry.coordinates
        .flatMap((polygon) =>
          polygon.map((ring) => linePath(ring, true)),
        )
        .join("");
    default:
      throw new Error(`Unsupported geometry: ${geometry.type}`);
  }
};

const collectionPath = (collection) =>
  collection.features.map(({ geometry }) => geometryPath(geometry)).join("");

const svgStart = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360">`;

const baseSvg = `${svgStart}
  <g id="natural-earth-base">
    <path d="${collectionPath(land)}" fill="#102c35" fill-rule="evenodd" stroke="#315968" stroke-width="0.55" vector-effect="non-scaling-stroke"/>
    <path d="${collectionPath(lakes)}" fill="#07141b" fill-rule="evenodd" stroke="#294d5a" stroke-width="0.45" vector-effect="non-scaling-stroke"/>
    <path d="${collectionPath(rivers)}" fill="none" stroke="#266071" stroke-width="0.55" vector-effect="non-scaling-stroke"/>
    <path d="${collectionPath(countries)}" fill="none" stroke="#4a7180" stroke-width="0.7" vector-effect="non-scaling-stroke"/>
  </g>
</svg>
`;

const statesSvg = `${svgStart}
  <g id="natural-earth-states">
    <path d="${collectionPath(states)}" fill="none" stroke="#355966" stroke-width="0.45" stroke-dasharray="2 1.5" vector-effect="non-scaling-stroke"/>
  </g>
</svg>
`;

const placeRows = places.features.map(({ geometry, properties }) => {
  if (geometry?.type !== "Point")
    throw new Error(`Unsupported place geometry: ${geometry?.type ?? "missing"}`);
  const [longitude, latitude] = geometry.coordinates;
  return [
    longitude,
    latitude,
    properties.NAME_EN || properties.NAME || properties.NAMEASCII,
    properties.MIN_ZOOM ?? 10,
    properties.POP_MAX ?? 0,
    properties.LABELRANK ?? 10,
  ];
});

await Promise.all([
  writeFile(outputBase, baseSvg),
  writeFile(outputStates, statesSvg),
  writeFile(outputPlaces, `${JSON.stringify(placeRows)}\n`),
]);
