import { SOURCE_RECORDING_DESCRIPTIONS } from "./sourceCapabilities";
export type CompatibilityDetailView = "modes" | "recording" | "browsers";
export type CompatibilityStatus =
  "validated" | "available" | "experimental" | "unclear" | "unsupported";

interface CompatibilityCellData {
  status: CompatibilityStatus;
  evidence: string;
}

interface CompatibilityDetailData {
  label: string;
  columns: string[];
  rows: Array<{
    label: string;
    cells: CompatibilityCellData[];
  }>;
  note: string;
}

export const COMPATIBILITY_STATUS_LABELS: Record<CompatibilityStatus, string> =
  {
    validated: "Validated",
    available: "Available",
    experimental: "Experimental",
    unclear: "Unclear",
    unsupported: "Unsupported",
  };

export const COMPATIBILITY_DETAILS: Record<
  CompatibilityDetailView,
  CompatibilityDetailData
> = {
  modes: {
    label: "Modes",
    columns: [
      "RTL-SDR",
      "HackRF Pro",
      "bladeRF 2.0 Micro (xA4; xA5/xA9 experimental)",
      "USRP B205-mini",
      "Replay",
    ],
    rows: [
      {
        label: "Spectrum only (OFF)",
        cells: [
          { status: "validated", evidence: "Live WebGPU spectrum" },
          { status: "validated", evidence: "4.8 and 9.6 MS/s live paths" },
          { status: "available", evidence: "Initial physical reception only" },
          {
            status: "available",
            evidence:
              "2026-09-27 Chrome / USB 3: 4.8 and 9.6 MS/s physical RX; experimental 19.2 MS/s, 88.31 s production path",
          },
          { status: "validated", evidence: "Capture span only; no retuning" },
        ],
      },
      {
        label: "WBFM audio + RDS",
        cells: [
          { status: "validated", evidence: "Physical FM, audio and RDS" },
          { status: "validated", evidence: "Physical reception and RDS" },
          {
            status: "available",
            evidence: "Decoder implemented; live proof pending",
          },
          {
            status: "available",
            evidence: "Decoder implemented; live proof pending",
          },
          { status: "validated", evidence: "Deterministic replay coverage" },
        ],
      },
      {
        label: "AM, NBFM, USB, LSB + CW",
        cells: [
          {
            status: "available",
            evidence: "DSP covered; live-air matrix pending",
          },
          {
            status: "available",
            evidence: "DSP covered; live-air matrix pending",
          },
          {
            status: "available",
            evidence: "DSP covered; live-air matrix pending",
          },
          {
            status: "available",
            evidence: "DSP covered; live-air matrix pending",
          },
          { status: "validated", evidence: "Deterministic decoder tests" },
        ],
      },
      {
        label: "DAB / DAB+",
        cells: [
          {
            status: "available",
            evidence: "Decoder covered; live ensemble pending",
          },
          {
            status: "available",
            evidence: "Decoder covered; live ensemble pending",
          },
          { status: "available", evidence: "Compatible sample rate required" },
          {
            status: "available",
            evidence: "4.8 MS/s capture; 2.4 MS/s channel",
          },
          { status: "available", evidence: "Compatible sample rate required" },
        ],
      },
      {
        label: "ADS-B, AIS + SRD",
        cells: [
          {
            status: "available",
            evidence: "Fixtures; 2026-09-29 RTL ADS-B RF evidence; AIS/SRD RF pending",
          },
          {
            status: "available",
            evidence: "Decoder fixtures; live RF pending",
          },
          {
            status: "available",
            evidence: "Decoder fixtures; live RF pending",
          },
          {
            status: "available",
            evidence: "Decoder fixtures; live RF pending",
          },
          {
            status: "validated",
            evidence: "Deterministic routing and fixtures",
          },
        ],
      },
      {
        label: "Explorer surveys",
        cells: [
          {
            status: "available",
            evidence: "Retune workflow; field survey pending",
          },
          {
            status: "available",
            evidence: "Retune workflow; field survey pending",
          },
          {
            status: "available",
            evidence: "Retune workflow; field survey pending",
          },
          {
            status: "available",
            evidence: "Retune workflow; field survey pending",
          },
          { status: "unsupported", evidence: "A recording cannot retune" },
        ],
      },
      {
        label: "19.2 MS/s wideband",
        cells: [
          { status: "unsupported", evidence: "Profile tops out at 4.8 MS/s" },
          {
            status: "available",
            evidence: "2026-10-14 owner reports stable Pro reception; broader loaded-host acceptance remains separate",
          },
          {
            status: "experimental",
            evidence: "Offered with performance warnings",
          },
          {
            status: "experimental",
            evidence: "2026-09-27 physical 19.2 MS/s, 88.31 s; longer loaded-host soak pending",
          },
          {
            status: "available",
            evidence: "Depends on recording rate and browser",
          },
        ],
      },
    ],
    note: "HackRF One is experimental at 9.6 MS/s with USB API 0x0110; physical reception is unverified. Pro evidence does not apply to One. Mode availability also depends on frequency range, sample rate and a signal suitable for the selected decoder.",
  },
  recording: {
    label: "Recording & export",
    columns: [
      "RTL-SDR",
      "HackRF Pro",
      "bladeRF 2.0 Micro (xA4; xA5/xA9 experimental)",
      "USRP B205-mini",
      "Synthetic demo",
    ],
    rows: [
      {
        label: "Native I/Q capture",
        cells: [
          { status: "validated", evidence: "CU8 samples" },
          { status: "validated", evidence: "CI8 samples" },
          {
            status: "available",
            evidence: SOURCE_RECORDING_DESCRIPTIONS.bladerf,
          },
          {
            status: "validated",
            evidence: SOURCE_RECORDING_DESCRIPTIONS["usrp-b205"],
          },
          { status: "available", evidence: "Quantized CU8 samples" },
        ],
      },
      {
        label: "BrowserSDR data + metadata",
        cells: [
          { status: "validated", evidence: "Export and replay covered" },
          { status: "validated", evidence: "Export and replay covered" },
          { status: "unsupported", evidence: "SigMF export only" },
          { status: "unsupported", evidence: "SigMF export only" },
          { status: "available", evidence: "Local export path" },
        ],
      },
      {
        label: "SigMF data + metadata",
        cells: [
          {
            status: "validated",
            evidence: "Schema, export and import covered",
          },
          {
            status: "validated",
            evidence: "Schema, export and import covered",
          },
          {
            status: "available",
            evidence: SOURCE_RECORDING_DESCRIPTIONS.bladerf,
          },
          {
            status: "validated",
            evidence: SOURCE_RECORDING_DESCRIPTIONS["usrp-b205"],
          },
          { status: "available", evidence: "Local export path" },
        ],
      },
      {
        label: "ZIP or separate downloads",
        cells: [
          { status: "validated", evidence: "Both delivery paths covered" },
          { status: "validated", evidence: "Both delivery paths covered" },
          {
            status: "available",
            evidence: "ZIP up to 32 MiB; separate files above",
          },
          {
            status: "available",
            evidence: "ZIP up to 32 MiB; separate files above",
          },
          {
            status: "available",
            evidence: "Browser download behavior applies",
          },
        ],
      },
      {
        label: "Explorer JSON / CSV manifest",
        cells: [
          { status: "available", evidence: "Survey metadata only" },
          { status: "available", evidence: "Survey metadata only" },
          { status: "available", evidence: "Survey metadata only" },
          { status: "available", evidence: "Survey metadata identifies USRP" },
          { status: "available", evidence: "Survey metadata only" },
        ],
      },
    ],
    note: "I/Q capture streams to private browser storage when available, with a bounded-memory fallback. A successful download request does not guarantee that the browser or operating system saved the file.",
  },
  browsers: {
    label: "Browsers",
    columns: ["SDR hardware", "Demo + replay", "WebGPU spectrum"],
    rows: [
      {
        label: "Chrome · desktop",
        cells: [
          { status: "validated", evidence: "WebUSB tested" },
          { status: "validated", evidence: "Primary browser test target" },
          { status: "validated", evidence: "Compatible GPU required" },
        ],
      },
      {
        label: "Edge / Chromium · desktop",
        cells: [
          {
            status: "unclear",
            evidence: "APIs plausible; direct evidence pending",
          },
          {
            status: "unclear",
            evidence: "Not in the validated browser matrix",
          },
          { status: "unclear", evidence: "GPU and driver dependent" },
        ],
      },
      {
        label: "Firefox · desktop",
        cells: [
          {
            status: "unsupported",
            evidence: "Required WebUSB path is unavailable",
          },
          { status: "unclear", evidence: "No supported-browser validation" },
          { status: "unclear", evidence: "Environment dependent" },
        ],
      },
      {
        label: "Safari · desktop",
        cells: [
          {
            status: "unsupported",
            evidence: "Required WebUSB path is unavailable",
          },
          { status: "unclear", evidence: "No supported-browser validation" },
          { status: "unclear", evidence: "Environment dependent" },
        ],
      },
      {
        label: "Mobile browsers",
        cells: [
          {
            status: "unsupported",
            evidence: "Hardware workflow is desktop-only",
          },
          {
            status: "unclear",
            evidence: "Layout adapts; runtime is unvalidated",
          },
          {
            status: "unclear",
            evidence: "GPU, memory and thermal limits vary",
          },
        ],
      },
    ],
    note: "Hardware access requires HTTPS or localhost, user-granted device permission and exclusive access. BrowserSDR does not treat API availability alone as validation.",
  },
};

/** Maintained public summary of dated evidence, not a certification of every configuration.
 * Exact private run identities and commands remain in BrowserSDR/planning/acceptance.md.
 */
export const DESKTOP_SUPPORT_SCOPE =
  "Stable desktop receivers: RTL-SDR and HackRF Pro. Chrome is the validated browser baseline. Other receivers, browsers and unverified mode combinations remain available for further testing and community feedback. Experimental rate and hardware labels still apply.";

export const SUPPORT_EVIDENCE = [
  {
    source: "Synthetic demo / file replay",
    configuration: "Generated data · desktop Chrome",
    status: "available",
    kind: "Software-tested",
    date: "2026-10-12",
    scope:
      "Spectrum, decoder fixtures, recording recovery and bounded file replay.",
    limits:
      "Synthetic 2 GiB import, cancellation and bounded range replay verified on 2026-10-12; this establishes software behavior, not physical RF. Peak total browser memory and full-duration playback were not measured.",
  },
  {
    source: "RTL-SDR",
    configuration: "NESDR SMArt v5 · Chrome 154 / Linux · 1.024 and 2.4 MS/s",
    status: "validated",
    kind: "Stable desktop · physical evidence",
    date: "2026-10-12",
    scope:
      "Live tuning, rate switching, restart and owner-confirmed FM/RDS. Native CU8 export, independent SigMF reader, reimport, interrupted-capture recovery and cross-tab ownership. Separate 2026-09-29 RTL ADS-B observation.",
    limits:
      "Other tuner/host/mode combinations retain their own evidence. Timed capture uses wall time; stored duration counts received samples. Browser clearing or eviction can remove recordings; interrupted recovery retains committed samples only.",
  },
  {
    source: "HackRF Pro",
    configuration: "HackRF Pro v2026.01.3 · Chrome 154 / Linux · 4.8 MS/s",
    status: "validated",
    kind: "Stable desktop · physical evidence",
    date: "2026-10-12",
    scope:
      "Owner-audible FM and live/replayed RDS; physical 2 GiB native CI8 capture, download, independent reader, reload retention and range replay. Earlier 9.6 / experimental 19.2 MS/s evidence remains separately dated.",
    limits:
      "Owner reports stable 19.2 MS/s reception on 2026-10-14. Loaded hosts, per-mode audio and HackRF One retain separate acceptance.",
  },
  {
    source: "HackRF One",
    configuration: "USB API 0x0110 · official v2026.01.3 baseline · native 9.6 MS/s",
    status: "experimental",
    kind: "Source-based software evidence",
    date: "2026-10-13",
    scope: "One-specific receive commands, six IF gain settings, 2.4 MS/s host-filtered channel, native CI8 capture and replay. Shared selector detects One versus Pro.",
    limits: "No real One hardware was available. Physical USB/RF, clock accuracy, analog response and field decoder results remain unverified. Older APIs and clone/PortaPack firmware are outside the initial profile.",
  },
  {
    source: "bladeRF 2.0 Micro",
    configuration: "xA4 existing receive profile; xA5/xA9 experimental",
    status: "available",
    kind: "Limited physical evidence",
    date: "2026-09-30",
    scope:
      "Earlier xA4 connection, volatile FPGA and initial reception. 30 September native Q11 correction has exact-byte software evidence.",
    limits:
      "Physical native Q11 round trips and each rate / variant remain pending. TX unavailable. " +
      SOURCE_RECORDING_DESCRIPTIONS.bladerf,
  },
  {
    source: "USRP B205-mini / B205mini-i",
    configuration: "2500:0022 · FX3 8.x · FPGA 7.x · Chrome / USB 3",
    status: "validated",
    kind: "Dated physical evidence",
    date: "2026-09-27",
    scope:
      "4.8 / 9.6 MS/s physical RX, 9.6 MS/s production soak. Experimental 19.2 MS/s production path: 88.31 source-clock seconds, clean stop, 10 s restart and retune; zero reported input/discontinuity counters.",
    limits:
      "Longer loaded-host soak, OS/controller matrix, audible modes and direct WestBridge firmware re-enumeration remain pending. " +
      SOURCE_RECORDING_DESCRIPTIONS["usrp-b205"],
  },
  {
    source: "OpenWebRX / KiwiSDR",
    configuration: "OpenWebRX v1.2.123 WSS; KiwiSDR 1.902 WS",
    status: "available",
    kind: "Dated remote evidence",
    date: "2026-10-09",
    scope:
      "Actual processed audio / FFT, deliberate start, tuning and cleanup in connected Chrome.",
    limits:
      "Audio counters do not establish speaker audibility. HTTP Kiwi does not prove secure production compatibility. No raw I/Q.",
  },
  {
    source: "Other SDR hardware",
    configuration: "No direct evidence",
    status: "unclear",
    kind: "Unclear",
    date: "Not tested",
    scope: "BrowserSDR offers only its listed receiver profiles.",
    limits: "No support claim.",
  },
] as const;

/** Engineering acceptance targets; measurements must name build, host and workload. */
export { default as PERFORMANCE_BUDGETS } from "../performanceBudgets.json";
