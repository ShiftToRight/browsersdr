import type { DigitalProvenance } from "../digital";

export const RS41_STANDARD_FRAME_BYTES = 320;
export const RS41_EXTENDED_FRAME_BYTES = 518;
export const RS41_MAX_SONDES = 32;
export const RS41_MAX_TRACK_POINTS = 256;
export const RS41_MAX_RECENT_FRAMES = 128;
export const RS41_MAX_EVENTS = 128;

export type Rs41FecStatus = "uncorrected" | "corrected" | "rejected";
export type Rs41FrameVariant = "standard" | "extended" | "unsupported";

export interface Rs41Position {
  latitudeDegrees: number;
  longitudeDegrees: number;
  /** WGS-84 ellipsoidal height, not orthometric/geoid height. */
  altitudeMeters: number;
  northVelocityMetersPerSecond: number;
  eastVelocityMetersPerSecond: number;
  upVelocityMetersPerSecond: number;
  horizontalSpeedMetersPerSecond: number;
  headingDegrees: number | null;
  satellitesUsed: number;
  speedAccuracyMetersPerSecond: number;
  positionDilutionOfPrecision: number;
}

export interface Rs41GpsTime {
  /** Full GPS week since 1980-01-06. */
  week: number;
  /** GPS-system milliseconds since start of the GPS week; not UTC. */
  timeOfWeekMilliseconds: number;
}

export interface Rs41DecodedFrame {
  variant: Rs41FrameVariant;
  fecStatus: Rs41FecStatus;
  correctedErrors: number;
  subblockIntegrity: {
    status: boolean;
    ptu: boolean;
    gpsInfo: boolean;
    gpsRaw: boolean;
    gpsPosition: boolean;
  };
  sondeId?: string;
  frameCounter?: number;
  batteryVolts?: number;
  calibrationFragmentIndex?: number;
  gpsTime?: Rs41GpsTime;
  position?: Rs41Position;
  provenance: DigitalProvenance;
  invertedPolarity: boolean;
}

export interface Rs41TrackPoint {
  frameCounter: number;
  position: Rs41Position;
  gpsTime?: Rs41GpsTime;
  provenance: DigitalProvenance;
  fecStatus: Exclude<Rs41FecStatus, "rejected">;
  correctedErrors: number;
}

export interface Rs41SondeState {
  sondeId: string;
  lastFrameCounter: number;
  lastHeard: DigitalProvenance;
  batteryVolts?: number;
  gpsTime?: Rs41GpsTime;
  position?: Rs41Position;
  track: Rs41TrackPoint[];
}

export interface Rs41Snapshot {
  configured: true;
  sondes: Rs41SondeState[];
  recentFrames: Rs41DecodedFrame[];
  counters: {
    synchronizedFrames: number;
    uncorrectedFrames: number;
    correctedFrames: number;
    rejectedFrames: number;
    correctedSymbols: number;
    unsupportedVariants: number;
    badStatusSubblocks: number;
    badGpsInfoSubblocks: number;
    badGpsPositionSubblocks: number;
  };
}

export type Rs41Event = { type: "frame"; frame: Rs41DecodedFrame };
