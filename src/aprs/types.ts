import type { DigitalProvenance } from "../digital";

export const APRS_MAX_AX25_FRAME_BYTES = 330;
export const APRS_MAX_INFORMATION_BYTES = 256;
export const APRS_MAX_DIGIPEATERS = 8;
export const APRS_MAX_STATIONS = 128;
export const APRS_MAX_PACKET_LOG = 128;
export const APRS_MAX_EVENTS = 128;

export interface Ax25Address {
  callsign: string;
  ssid: number;
  repeated: boolean;
}

export interface Ax25UiFrame {
  destination: Ax25Address;
  source: Ax25Address;
  path: Ax25Address[];
  control: 0x03;
  pid: 0xf0;
  information: Uint8Array;
}

export interface AprsPosition {
  latitudeDegrees: number;
  longitudeDegrees: number;
  format: "uncompressed" | "compressed" | "mic-e";
  ambiguityDigits: number;
  precisionMeters: number | null;
  symbolTable: string;
  symbolCode: string;
}

export interface AprsWeather {
  windDirectionDegrees?: number;
  windSpeedMetersPerSecond?: number;
  windGustMetersPerSecond?: number;
  temperatureCelsius?: number;
  rainLastHourMillimeters?: number;
  rainLast24HoursMillimeters?: number;
  rainSinceMidnightMillimeters?: number;
  humidityPercent?: number;
  pressureHectopascals?: number;
  luminosityWattsPerSquareMeter?: number;
}

export type AprsPayload =
  | {
      kind: "position" | "mic-e";
      position: AprsPosition;
      altitudeMeters?: number;
      courseDegrees?: number;
      speedMetersPerSecond?: number;
      weather?: AprsWeather;
      comment: string;
      micEStatus?: string;
    }
  | { kind: "status"; text: string }
  | { kind: "message"; addressee: string; text: string; messageId?: string }
  | { kind: "weather"; weather: AprsWeather; comment: string }
  | { kind: "unsupported"; dataType: number };

export interface AprsPacketRecord {
  sequence: number;
  frame: Ax25UiFrame;
  payload: AprsPayload;
  provenance: DigitalProvenance;
}

export interface AprsStationState {
  key: string;
  source: Ax25Address;
  destination: Ax25Address;
  path: Ax25Address[];
  packets: number;
  lastHeard: DigitalProvenance;
  position?: AprsPosition;
  altitudeMeters?: number;
  weather?: AprsWeather;
  statusText?: string;
}

export interface AprsSnapshot {
  configured: true;
  stations: AprsStationState[];
  recentPackets: AprsPacketRecord[];
  counters: {
    hdlcCandidates: number;
    validAx25Frames: number;
    invalidFcsFrames: number;
    malformedAx25Frames: number;
    decodedAprsPackets: number;
    unsupportedAprsPackets: number;
    duplicatePackets: number;
  };
}

export type AprsEvent =
  | { type: "packet"; packet: AprsPacketRecord }
  | { type: "invalid-frame"; reason: "fcs" | "malformed" };
