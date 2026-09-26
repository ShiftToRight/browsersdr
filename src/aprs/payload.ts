import type {
  AprsPayload,
  AprsPosition,
  AprsWeather,
  Ax25UiFrame,
} from "./types";

const ASCII = new TextDecoder("latin1");
const KNOT_TO_MPS = 0.514444;
const MPH_TO_MPS = 0.44704;
const INCH_TO_MM = 25.4;

type ParsedPosition = {
  position: AprsPosition;
  altitudeMeters?: number;
  courseDegrees?: number;
  speedMetersPerSecond?: number;
  weather?: AprsWeather;
  comment: string;
  micEStatus?: string;
};

export function parseAprsPayload(frame: Ax25UiFrame): AprsPayload {
  const bytes = frame.information;
  if (bytes.length === 0) return { kind: "unsupported", dataType: -1 };
  const type = bytes[0]!;
  const text = ASCII.decode(bytes);
  if (type === 0x3e) return { kind: "status", text: text.slice(1, 256) };
  if (type === 0x3a)
    return parseMessage(text) ?? { kind: "unsupported", dataType: type };
  if (type === 0x5f) {
    const weather = parseWeather(text.slice(1).replace(/^\d{8}/, ""), true);
    return weather
      ? { kind: "weather", weather, comment: text.slice(1) }
      : { kind: "unsupported", dataType: type };
  }
  if (type === 0x27 || type === 0x60)
    return parseMicE(frame) ?? { kind: "unsupported", dataType: type };
  if (type === 0x21 || type === 0x3d || type === 0x2f || type === 0x40) {
    const start = type === 0x2f || type === 0x40 ? 8 : 1;
    if (bytes.length <= start) return { kind: "unsupported", dataType: type };
    const body = text.slice(start);
    const parsed = /[0-9 ]/.test(body[0] ?? "")
      ? parseUncompressed(body)
      : parseCompressed(body);
    if (!parsed) return { kind: "unsupported", dataType: type };
    return { kind: "position", ...parsed };
  }
  return { kind: "unsupported", dataType: type };
}

function parseMessage(text: string): AprsPayload | undefined {
  if (text.length < 11 || text[10] !== ":") return undefined;
  const addressee = text.slice(1, 10).trimEnd();
  if (!/^[A-Z0-9 -]{1,9}$/i.test(addressee)) return undefined;
  const raw = text.slice(11, 256);
  const match = /^(.*)\{([A-Za-z0-9]{1,5})$/.exec(raw);
  return {
    kind: "message",
    addressee,
    text: match?.[1] ?? raw,
    ...(match ? { messageId: match[2] } : {}),
  };
}

function parseUncompressed(body: string): ParsedPosition | undefined {
  if (body.length < 19) return undefined;
  const lat = parseCoordinate(body.slice(0, 8), false);
  const lon = parseCoordinate(body.slice(9, 18), true);
  const symbolTable = body[8]!;
  const symbolCode = body[18]!;
  if (!lat || !lon || !isSymbolTable(symbolTable) || !isPrintable(symbolCode))
    return undefined;
  const ambiguity = Math.max(lat.ambiguity, lon.ambiguity);
  const comment = body.slice(19, 256);
  const position: AprsPosition = {
    latitudeDegrees: lat.value,
    longitudeDegrees: lon.value,
    format: "uncompressed",
    ambiguityDigits: ambiguity,
    precisionMeters: [18.5, 185, 1850, 18_500, 111_000][ambiguity] ?? null,
    symbolTable,
    symbolCode,
  };
  const extension = parseCourseSpeed(body.slice(19, 26));
  const weather = symbolCode === "_" ? parseWeather(comment, false) : undefined;
  return {
    position,
    ...(parseAltitude(comment) !== undefined
      ? { altitudeMeters: parseAltitude(comment) }
      : {}),
    ...extension,
    ...(weather ? { weather } : {}),
    comment,
  };
}

function parseCoordinate(
  field: string,
  longitude: boolean,
): { value: number; ambiguity: number } | undefined {
  const degreesLength = longitude ? 3 : 2;
  if (field.length !== degreesLength + 6 || field[degreesLength + 2] !== ".")
    return undefined;
  const hemisphere = field.at(-1)!;
  if (!(longitude ? /[EW]/ : /[NS]/).test(hemisphere)) return undefined;
  const numeric = field.slice(0, -1);
  if (!/^[0-9 ]+\.[0-9 ]+$/.test(numeric)) return undefined;
  const spaces = [...numeric].filter((value) => value === " ").length;
  const normalized = numeric.replaceAll(" ", "5");
  const degrees = Number(normalized.slice(0, degreesLength));
  const minutes = Number(normalized.slice(degreesLength));
  if (
    !Number.isFinite(degrees) ||
    !Number.isFinite(minutes) ||
    minutes >= 60 ||
    degrees > (longitude ? 180 : 90)
  )
    return undefined;
  if (degrees === (longitude ? 180 : 90) && minutes > 0) return undefined;
  const sign = /[SW]/.test(hemisphere) ? -1 : 1;
  return {
    value: sign * (degrees + minutes / 60),
    ambiguity: Math.min(4, spaces),
  };
}

function parseCompressed(body: string): ParsedPosition | undefined {
  if (body.length < 13 || !isSymbolTable(body[0]!)) return undefined;
  const y = base91(body.slice(1, 5));
  const x = base91(body.slice(5, 9));
  if (y === undefined || x === undefined || !isPrintable(body[9]!))
    return undefined;
  const position: AprsPosition = {
    latitudeDegrees: 90 - y / 380926,
    longitudeDegrees: -180 + x / 190463,
    format: "compressed",
    ambiguityDigits: 0,
    precisionMeters: 0.6,
    symbolTable: normalizeSymbolTable(body[0]!),
    symbolCode: body[9]!,
  };
  const c = body.charCodeAt(10) - 33;
  const s = body.charCodeAt(11) - 33;
  const t = body.charCodeAt(12) - 33;
  const comment = body.slice(13, 256);
  const result: ParsedPosition = { position, comment };
  if (c >= 0 && c <= 89 && s >= 0 && s <= 90) {
    if ((t & 0x18) === 0x10)
      result.altitudeMeters = Math.pow(1.002, c * 91 + s) * 0.3048;
    else {
      result.courseDegrees = c * 4;
      result.speedMetersPerSecond = (Math.pow(1.08, s) - 1) * KNOT_TO_MPS;
    }
  }
  const altitude = parseAltitude(comment);
  if (altitude !== undefined) result.altitudeMeters = altitude;
  return result;
}

function parseMicE(frame: Ax25UiFrame): AprsPayload | undefined {
  const info = frame.information;
  const dest = frame.destination.callsign.padEnd(6, " ");
  if (info.length < 9 || dest.length !== 6) return undefined;
  const digits: number[] = [];
  let standard = 0;
  let custom = 0;
  for (let index = 0; index < 6; index++) {
    const character = dest[index]!;
    let digit: number;
    if (/[0-9]/.test(character)) digit = Number(character);
    else if (/[A-J]/.test(character)) {
      digit = character.charCodeAt(0) - 65;
      if (index < 3) custom |= 4 >> index;
    } else if (/[P-Y]/.test(character)) {
      digit = character.charCodeAt(0) - 80;
      if (index < 3) standard |= 4 >> index;
    } else if (character === "K" || character === "L" || character === "Z")
      digit = 0;
    else return undefined;
    digits.push(digit);
  }
  let latitude =
    digits[0]! * 10 +
    digits[1]! +
    (digits[2]! * 1000 + digits[3]! * 100 + digits[4]! * 10 + digits[5]!) /
      6000;
  if (/[0-9L]/.test(dest[3]!)) latitude = -latitude;
  else if (!/[P-Z]/.test(dest[3]!)) return undefined;
  const offset = /[P-Z]/.test(dest[4]!);
  const d = info[1]!;
  let longitude: number;
  if (offset && d >= 118 && d <= 127) longitude = d - 118;
  else if (!offset && d >= 38 && d <= 127) longitude = d - 28;
  else if (offset && d >= 108 && d <= 117) longitude = d - 8;
  else if (offset && d >= 38 && d <= 107) longitude = d + 72;
  else return undefined;
  const m = info[2]!;
  const h = info[3]!;
  if (m < 38 || m > 97 || h < 28 || h > 127) return undefined;
  longitude += (m >= 88 ? m - 88 : m - 28) / 60 + (h - 28) / 6000;
  if (/[P-Z]/.test(dest[5]!)) longitude = -longitude;
  else if (!/[0-9L]/.test(dest[5]!)) return undefined;
  const speed0 = info[4]! - 28;
  const speed1 = info[5]! - 28;
  const course2 = info[6]! - 28;
  if ([speed0, speed1, course2].some((value) => value < 0 || value > 99))
    return undefined;
  let speedKnots = speed0 * 10 + Math.floor(speed1 / 10);
  if (speedKnots >= 800) speedKnots -= 800;
  let course = (speed1 % 10) * 100 + course2;
  if (course >= 400) course -= 400;
  const statusNames = [
    "Emergency",
    "Priority",
    "Special",
    "Committed",
    "Returning",
    "In Service",
    "En Route",
    "Off Duty",
  ];
  const status =
    standard && !custom
      ? statusNames[standard]
      : standard === 0 && custom === 0
        ? "Emergency"
        : custom
          ? `Custom-${7 - custom}`
          : "Unknown";
  const comment = ASCII.decode(info.subarray(9))
    .replace(/\r$/, "")
    .slice(0, 247);
  return {
    kind: "mic-e",
    position: {
      latitudeDegrees: latitude,
      longitudeDegrees: longitude,
      format: "mic-e",
      ambiguityDigits: 0,
      precisionMeters: 18.5,
      symbolCode: String.fromCharCode(info[7]!),
      symbolTable: String.fromCharCode(info[8]!),
    },
    speedMetersPerSecond: speedKnots * KNOT_TO_MPS,
    ...(course === 0 ? {} : { courseDegrees: course === 360 ? 0 : course }),
    ...(parseMicEAltitude(comment) !== undefined
      ? { altitudeMeters: parseMicEAltitude(comment) }
      : {}),
    comment,
    micEStatus: status,
  };
}

function parseCourseSpeed(value: string): {
  courseDegrees?: number;
  speedMetersPerSecond?: number;
} {
  const match = /^(\d{3})\/(\d{3})/.exec(value);
  if (!match) return {};
  const course = Number(match[1]);
  const speed = Number(match[2]);
  return {
    ...(course >= 1 && course <= 360 ? { courseDegrees: course % 360 } : {}),
    speedMetersPerSecond: speed * KNOT_TO_MPS,
  };
}

function parseAltitude(comment: string): number | undefined {
  const match = /\/A=(-?\d{5,6})(?!\d)/.exec(comment);
  return match ? Number(match[1]) * 0.3048 : undefined;
}

function parseMicEAltitude(comment: string): number | undefined {
  if (comment.length < 4 || comment[3] !== "}") return undefined;
  const encoded = base91(comment.slice(0, 3));
  return encoded === undefined ? undefined : (encoded - 10_000) * 0.3048;
}

function parseWeather(
  input: string,
  positionless: boolean,
): AprsWeather | undefined {
  let text = input;
  const weather: AprsWeather = {};
  const wind = positionless
    ? /^c(\d{3}|\.{3})s(\d{3}|\.{3})/.exec(text)
    : /^(\d{3}|\.{3})\/(\d{3}|\.{3})/.exec(text);
  if (wind) {
    if (!wind[1]!.includes(".")) weather.windDirectionDegrees = Number(wind[1]);
    if (!wind[2]!.includes("."))
      weather.windSpeedMetersPerSecond =
        Number(wind[2]) * (positionless ? MPH_TO_MPS : KNOT_TO_MPS);
    text = text.slice(wind[0].length);
  }
  for (const match of text.matchAll(/([gtrpPhbLl])(\d{2,5}|-\d{2})/g)) {
    const value = Number(match[2]);
    switch (match[1]) {
      case "g":
        weather.windGustMetersPerSecond = value * MPH_TO_MPS;
        break;
      case "t":
        weather.temperatureCelsius = ((value - 32) * 5) / 9;
        break;
      case "r":
        weather.rainLastHourMillimeters = (value / 100) * INCH_TO_MM;
        break;
      case "p":
        weather.rainLast24HoursMillimeters = (value / 100) * INCH_TO_MM;
        break;
      case "P":
        weather.rainSinceMidnightMillimeters = (value / 100) * INCH_TO_MM;
        break;
      case "h":
        weather.humidityPercent = value === 0 ? 100 : value;
        break;
      case "b":
        weather.pressureHectopascals = value / 10;
        break;
      case "L":
        weather.luminosityWattsPerSquareMeter = value;
        break;
      case "l":
        weather.luminosityWattsPerSquareMeter = value + 1000;
        break;
    }
  }
  return Object.keys(weather).length ? weather : undefined;
}

function base91(value: string): number | undefined {
  let result = 0;
  for (const character of value) {
    const digit = character.charCodeAt(0) - 33;
    if (digit < 0 || digit > 90) return undefined;
    result = result * 91 + digit;
  }
  return result;
}

function isPrintable(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 33 && code <= 126;
}
function isSymbolTable(value: string): boolean {
  return value === "/" || value === "\\" || /^[A-Z0-9a-j]$/.test(value);
}
function normalizeSymbolTable(value: string): string {
  return /^[a-j]$/.test(value) ? String(value.charCodeAt(0) - 97) : value;
}
