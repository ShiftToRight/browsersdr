import { acarsCrc } from "../textmodem/framing";
import {
  bitCount,
  CCIR_FIGURES,
  CCIR_LETTERS,
  ITA2_FIGURES,
  ITA2_LETTERS,
  PSK31_VARICODE,
} from "../textmodem/characters";
import {
  defaultTextModemSettings,
  type TextMode,
  type TextModemSettings,
} from "../textmodem/settings";

export function rttySymbols(
  text: string,
  settings = defaultTextModemSettings(),
): number[] {
  const symbols: number[] = Array(20).fill(1);
  let figures = false;
  const emit = (code: number) => {
    symbols.push(0);
    for (let bit = 0; bit < 5; bit++) symbols.push((code >> bit) & 1);
    symbols.push(
      ...Array(Math.round(settings.stopBits * 2))
        .fill(1)
        .map(() => 2),
    );
  };
  for (const character of text.toUpperCase()) {
    let code = (figures ? ITA2_FIGURES : ITA2_LETTERS).indexOf(character);
    if (code < 0) {
      figures = !figures;
      emit(figures ? 27 : 31);
      code = (figures ? ITA2_FIGURES : ITA2_LETTERS).indexOf(character);
    }
    if (code >= 0) emit(code);
  }
  return [...symbols, ...Array(10).fill(1)];
}
export function navtexWords(text: string): number[] {
  let figures = false;
  const codes: number[] = [0x5a];
  for (const character of text) {
    const find = (table: Readonly<Record<number, string>>) =>
      Object.entries(table).find(([, value]) => value === character)?.[0];
    let code = find(figures ? CCIR_FIGURES : CCIR_LETTERS);
    if (code === undefined) {
      figures = !figures;
      codes.push(figures ? 0x36 : 0x5a);
      code = find(figures ? CCIR_FIGURES : CCIR_LETTERS);
    }
    if (code !== undefined) codes.push(Number(code));
  }
  const words = Array.from({ length: 20 }, () => [0x66, 0x0f]).flat();
  for (let n = 0; n < codes.length + 3; n++)
    words.push(codes[n] ?? 0x66, n >= 2 ? (codes[n - 2] ?? 0x0f) : 0x0f);
  return words;
}
export function oddParity(value: number): number {
  return value | (bitCount(value) % 2 === 0 ? 0x80 : 0);
}
export function acarsBytes(text: string): number[] {
  const body = [
    ...`2.N123AB${String.fromCharCode(21)}H11${String.fromCharCode(2)}${text}${String.fromCharCode(3)}`,
  ].map((character) => oddParity(character.charCodeAt(0)));
  const crc = acarsCrc(body);
  return [
    ...Array(30).fill(255),
    0xab,
    0x2a,
    0x16,
    0x16,
    0x01,
    ...body,
    crc & 255,
    crc >> 8,
    0x7f,
    ...Array(20).fill(255),
  ];
}
export function textModemSignal(
  mode: TextMode,
  text: string,
  rate: number,
  options: {
    settings?: TextModemSettings;
    offsetHz?: number;
    driftHz?: number;
    clockScale?: number;
    noise?: number;
    corrupt?: boolean;
    phase?: number;
  } = {},
): { I: Float32Array; Q: Float32Array } {
  const settings = options.settings ?? defaultTextModemSettings();
  let symbols: number[], baud: number;
  if (mode === "RTTY") {
    symbols = rttySymbols(text, settings);
    baud = settings.baud;
  } else if (mode === "PSK31") {
    symbols = [
      ...Array(48).fill(0),
      ...[...text].flatMap((character) =>
        [...PSK31_VARICODE[character.charCodeAt(0)]!, 0, 0].map(Number),
      ),
      ...Array(16).fill(0),
    ];
    baud = 31.25;
  } else {
    const words = mode === "NAVTEX" ? navtexWords(text) : acarsBytes(text);
    if (options.corrupt) words[mode === "NAVTEX" ? 50 : 60]! ^= 1;
    symbols = words.flatMap((word) =>
      Array.from(
        { length: mode === "NAVTEX" ? 7 : 8 },
        (_, bit) => (word >> bit) & 1,
      ),
    );
    baud = mode === "NAVTEX" ? 100 : 2400;
  }
  const times: number[] = [];
  let duration = 0;
  for (const symbol of symbols) {
    duration += ((symbol === 2 ? 0.5 : 1) / baud) * (options.clockScale ?? 1);
    times.push(duration);
  }
  const count = Math.ceil(duration * rate);
  const I = new Float32Array(count),
    Q = new Float32Array(count);
  let symbolIndex = 0,
    phase = options.phase ?? 0.3,
    sign = mode === "PSK31" ? -1 : 1,
    previousSign = 1,
    previousBit = 1;
  let audioPhase = 0;
  let noiseState = 42;
  const random = () => {
    noiseState = (Math.imul(noiseState, 1664525) + 1013904223) | 0;
    return (noiseState >>> 0) / 4294967296 - 0.5;
  };
  for (let n = 0; n < count; n++) {
    const t = n / rate;
    while (symbolIndex < times.length - 1 && t >= times[symbolIndex]!) {
      previousSign = sign;
      previousBit = symbols[symbolIndex]!;
      symbolIndex++;
      if (mode === "PSK31" && symbols[symbolIndex] === 0) sign = -sign;
    }
    let frequency =
      (options.offsetHz ?? 37_000) +
      settings.tuningOffsetHz +
      (options.driftHz ?? 0);
    let amplitude = 0.65;
    if (mode === "RTTY" || mode === "NAVTEX") {
      const shift = mode === "RTTY" ? settings.shiftHz : 170;
      const mark = (symbols[symbolIndex] !== 0) !== settings.inverted;
      frequency += mark ? shift / 2 : -shift / 2;
    } else if (mode === "PSK31") {
      const start = symbolIndex === 0 ? 0 : times[symbolIndex - 1]!;
      amplitude *=
        symbols[symbolIndex] === 0
          ? previousSign *
            Math.cos((Math.PI * (t - start) * baud) / (options.clockScale ?? 1))
          : sign;
    } else {
      const tone = symbols[symbolIndex] === previousBit ? 2400 : 1200;
      // MSK phase continuity is maintained by a separate audio phase below.
      audioPhase += (2 * Math.PI * tone) / rate;
      amplitude = 0.5 + 0.35 * Math.sin(audioPhase);
      frequency = options.offsetHz ?? 37_000;
    }
    phase += (2 * Math.PI * frequency) / rate;
    I[n] = amplitude * Math.cos(phase) + random() * (options.noise ?? 0);
    Q[n] = amplitude * Math.sin(phase) + random() * (options.noise ?? 0);
  }
  return { I, Q };
}
