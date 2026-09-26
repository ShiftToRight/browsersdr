import { DabPadDecoder, type DabProgrammeMetadata } from "./dabPad";
import type { DabPlusAudioFormat, WebCodecsDabAudioDecoder } from "./dabAudio";

const RS_CODEWORD_BYTES = 120;
const RS_DATA_BYTES = 110;
const RS_PARITY_BYTES = 10;
const GF_ORDER = 255;
const GF_EXP = new Uint8Array(GF_ORDER * 2);
const GF_LOG = new Int16Array(256).fill(-1);

let fieldValue = 1;
for (let index = 0; index < GF_ORDER; index += 1) {
  GF_EXP[index] = fieldValue;
  GF_LOG[fieldValue] = index;
  fieldValue <<= 1;
  if (fieldValue & 0x100) fieldValue ^= 0x11d;
}
for (let index = GF_ORDER; index < GF_EXP.length; index += 1)
  GF_EXP[index] = GF_EXP[index - GF_ORDER]!;

function gfMul(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return GF_EXP[GF_LOG[left]! + GF_LOG[right]!]!;
}
function gfDiv(left: number, right: number): number {
  if (right === 0) throw new Error("Cannot divide by zero in GF(256).");
  if (left === 0) return 0;
  return GF_EXP[(GF_LOG[left]! - GF_LOG[right]! + GF_ORDER) % GF_ORDER]!;
}
function gfPowAlpha(power: number): number {
  return GF_EXP[((power % GF_ORDER) + GF_ORDER) % GF_ORDER]!;
}

function rsSyndromes(codeword: Uint8Array): Uint8Array {
  const syndromes = new Uint8Array(RS_PARITY_BYTES);
  for (let root = 0; root < syndromes.length; root += 1) {
    const x = gfPowAlpha(root);
    let value = 0;
    for (const byte of codeword) value = gfMul(value, x) ^ byte;
    syndromes[root] = value;
  }
  return syndromes;
}
function allZero(values: Uint8Array): boolean {
  return values.every((value) => value === 0);
}

function berlekampMassey(syndromes: Uint8Array): Uint8Array | undefined {
  const current = new Uint8Array(RS_PARITY_BYTES + 1);
  current[0] = 1;
  let previous = new Uint8Array(RS_PARITY_BYTES + 1);
  previous[0] = 1;
  let degree = 0,
    shift = 1,
    lastDiscrepancy = 1;
  for (let step = 0; step < syndromes.length; step += 1) {
    let discrepancy = syndromes[step]!;
    for (let index = 1; index <= degree; index += 1)
      discrepancy ^= gfMul(current[index]!, syndromes[step - index]!);
    if (discrepancy === 0) {
      shift += 1;
      continue;
    }
    const saved = current.slice();
    const scale = gfDiv(discrepancy, lastDiscrepancy);
    for (let index = 0; index + shift < current.length; index += 1)
      current[index + shift] =
        current[index + shift]! ^ gfMul(scale, previous[index]!);
    if (2 * degree <= step) {
      degree = step + 1 - degree;
      if (degree > RS_PARITY_BYTES / 2) return undefined;
      previous = saved;
      lastDiscrepancy = discrepancy;
      shift = 1;
    } else shift += 1;
  }
  return current.slice(0, degree + 1);
}

function polynomialAt(coefficients: Uint8Array, value: number): number {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1)
    result = gfMul(result, value) ^ coefficients[index]!;
  return result;
}

function solveMagnitudes(
  positions: number[],
  syndromes: Uint8Array,
  length: number,
): Uint8Array | undefined {
  const count = positions.length;
  const matrix = Array.from({ length: count }, (_, row) => {
    const values = new Uint8Array(count + 1);
    for (let column = 0; column < count; column += 1) {
      const exponent = (length - 1 - positions[column]!) * row;
      values[column] = gfPowAlpha(exponent);
    }
    values[count] = syndromes[row]!;
    return values;
  });
  for (let pivot = 0; pivot < count; pivot += 1) {
    const pivotRow = matrix.findIndex(
      (row, index) => index >= pivot && row[pivot] !== 0,
    );
    if (pivotRow < 0) return undefined;
    [matrix[pivot], matrix[pivotRow]] = [matrix[pivotRow]!, matrix[pivot]!];
    const divisor = matrix[pivot]![pivot]!;
    for (let column = pivot; column <= count; column += 1)
      matrix[pivot]![column] = gfDiv(matrix[pivot]![column]!, divisor);
    for (let row = 0; row < count; row += 1) {
      if (row === pivot) continue;
      const scale = matrix[row]![pivot]!;
      if (scale === 0) continue;
      for (let column = pivot; column <= count; column += 1)
        matrix[row]![column] =
          matrix[row]![column]! ^ gfMul(scale, matrix[pivot]![column]!);
    }
  }
  return Uint8Array.from(matrix.map((row) => row[count]!));
}

export interface ReedSolomonResult {
  data: Uint8Array;
  correctedBytes: number;
}

/** Correct one shortened DAB+ RS(120,110) codeword (up to five bytes). */
export function correctDabPlusCodeword(
  input: Uint8Array,
): ReedSolomonResult | undefined {
  if (input.length !== RS_CODEWORD_BYTES)
    throw new Error("A DAB+ Reed-Solomon codeword must contain 120 bytes.");
  const codeword = input.slice();
  const syndromes = rsSyndromes(codeword);
  if (allZero(syndromes))
    return { data: codeword.subarray(0, RS_DATA_BYTES), correctedBytes: 0 };
  const locator = berlekampMassey(syndromes);
  if (!locator) return undefined;
  const errorCount = locator.length - 1;
  const positions: number[] = [];
  for (let position = 0; position < codeword.length; position += 1) {
    const exponent = codeword.length - 1 - position;
    if (polynomialAt(locator, gfPowAlpha(-exponent)) === 0)
      positions.push(position);
  }
  if (positions.length !== errorCount || errorCount > RS_PARITY_BYTES / 2)
    return undefined;
  const magnitudes = solveMagnitudes(positions, syndromes, codeword.length);
  if (!magnitudes) return undefined;
  for (let index = 0; index < positions.length; index += 1)
    codeword[positions[index]!] =
      codeword[positions[index]!]! ^ magnitudes[index]!;
  if (!allZero(rsSyndromes(codeword))) return undefined;
  return {
    data: codeword.subarray(0, RS_DATA_BYTES),
    correctedBytes: errorCount,
  };
}

export function dabPlusFireCode(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes) {
    remainder ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      remainder =
        ((remainder << 1) ^ (remainder & 0x8000 ? 0x782f : 0)) & 0xffff;
  }
  return remainder;
}

export function dabPlusAccessUnitCrc(bytes: Uint8Array): number {
  let remainder = 0xffff;
  for (const byte of bytes) {
    remainder ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1)
      remainder =
        ((remainder << 1) ^ (remainder & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return remainder ^ 0xffff;
}

export interface DabPlusAccessUnit {
  data: Uint8Array;
  index: number;
}
export interface DabPlusSuperframe {
  format: DabPlusAudioFormat;
  accessUnits: DabPlusAccessUnit[];
  rejectedAccessUnits: number;
  correctedBytes: number;
  subchannelIndex: number;
}

export type DabPlusSuperframeRejection =
  "framing" | "reed-solomon" | "fire-code" | "header";

interface DabPlusSuperframeInspection {
  superframe?: DabPlusSuperframe;
  rejection?: DabPlusSuperframeRejection;
  correctedColumns: number;
}

function read12(bytes: Uint8Array, bitOffset: number): number {
  let value = 0;
  for (let bit = 0; bit < 12; bit += 1) {
    const index = bitOffset + bit;
    value = (value << 1) | ((bytes[index >> 3]! >> (7 - (index & 7))) & 1);
  }
  return value;
}

/** Apply outer FEC, validate the Fire code, and extract CRC-valid raw AAC AUs. */
function inspectDabPlusSuperframe(
  encoded: Uint8Array,
): DabPlusSuperframeInspection {
  if (encoded.length === 0 || encoded.length % RS_CODEWORD_BYTES !== 0)
    return { rejection: "framing", correctedColumns: 0 };
  const subchannelIndex = encoded.length / RS_CODEWORD_BYTES;
  const data = new Uint8Array(subchannelIndex * RS_DATA_BYTES);
  let correctedBytes = 0;
  for (let column = 0; column < subchannelIndex; column += 1) {
    const codeword = new Uint8Array(RS_CODEWORD_BYTES);
    for (let row = 0; row < RS_CODEWORD_BYTES; row += 1)
      codeword[row] = encoded[row * subchannelIndex + column]!;
    const corrected = correctDabPlusCodeword(codeword);
    if (!corrected)
      return { rejection: "reed-solomon", correctedColumns: column };
    correctedBytes += corrected.correctedBytes;
    for (let row = 0; row < RS_DATA_BYTES; row += 1)
      data[row * subchannelIndex + column] = corrected.data[row]!;
  }
  if (data.length < 11)
    return { rejection: "header", correctedColumns: subchannelIndex };
  const storedFireCode = (data[0]! << 8) | data[1]!;
  if (dabPlusFireCode(data.subarray(2, 11)) !== storedFireCode)
    return { rejection: "fire-code", correctedColumns: subchannelIndex };

  const flags = data[2]!;
  const format: DabPlusAudioFormat = {
    dacRate: Boolean(flags & 0x40),
    sbr: Boolean(flags & 0x20),
    stereo: Boolean(flags & 0x10),
    parametricStereo: Boolean(flags & 0x08),
    mpegSurround: flags & 0x07,
  };
  if (format.parametricStereo && (!format.sbr || format.stereo))
    return { rejection: "header", correctedColumns: subchannelIndex };
  const count = format.dacRate ? (format.sbr ? 3 : 6) : format.sbr ? 2 : 4;
  const headerBytes = Math.ceil((24 + (count - 1) * 12) / 8);
  const starts = [headerBytes];
  for (let index = 1; index < count; index += 1)
    starts.push(read12(data, 24 + (index - 1) * 12));
  starts.push(data.length);
  for (let index = 0; index < count; index += 1) {
    if (
      starts[index]! < headerBytes ||
      starts[index]! >= starts[index + 1]! ||
      starts[index + 1]! > data.length
    )
      return { rejection: "header", correctedColumns: subchannelIndex };
  }

  const accessUnits: DabPlusAccessUnit[] = [];
  let rejectedAccessUnits = 0;
  for (let index = 0; index < count; index += 1) {
    const framed = data.subarray(starts[index]!, starts[index + 1]!);
    if (framed.length < 2) {
      rejectedAccessUnits += 1;
      continue;
    }
    const payload = framed.subarray(0, framed.length - 2);
    const storedCrc =
      (framed[framed.length - 2]! << 8) | framed[framed.length - 1]!;
    if (dabPlusAccessUnitCrc(payload) !== storedCrc) {
      rejectedAccessUnits += 1;
      continue;
    }
    accessUnits.push({ data: payload.slice(), index });
  }
  return {
    correctedColumns: subchannelIndex,
    superframe: {
      format,
      accessUnits,
      rejectedAccessUnits,
      correctedBytes,
      subchannelIndex,
    },
  };
}

/** Apply outer FEC, validate the Fire code, and extract CRC-valid raw AAC AUs. */
export function parseDabPlusSuperframe(
  encoded: Uint8Array,
): DabPlusSuperframe | undefined {
  return inspectDabPlusSuperframe(encoded).superframe;
}

export interface DabPlusSynchronizerStats {
  candidateWindows: number;
  reedSolomonFailures: number;
  fireCodeFailures: number;
  headerFailures: number;
  lastCorrectedColumns: number;
  bestCorrectedColumns: number;
}

/** Sliding five-logical-frame synchronizer described by ETSI TS 102 563. */
export class DabPlusSuperframeSynchronizer {
  private readonly frames: Uint8Array[] = [];
  private frameBytes?: number;
  private stats: DabPlusSynchronizerStats = {
    candidateWindows: 0,
    reedSolomonFailures: 0,
    fireCodeFailures: 0,
    headerFailures: 0,
    lastCorrectedColumns: 0,
    bestCorrectedColumns: 0,
  };
  get diagnostics(): DabPlusSynchronizerStats {
    return { ...this.stats };
  }
  reset(): void {
    this.frames.length = 0;
    this.frameBytes = undefined;
    this.stats = {
      candidateWindows: 0,
      reedSolomonFailures: 0,
      fireCodeFailures: 0,
      headerFailures: 0,
      lastCorrectedColumns: 0,
      bestCorrectedColumns: 0,
    };
  }
  push(frame: Uint8Array): DabPlusSuperframe | undefined {
    if (this.frameBytes !== undefined && frame.length !== this.frameBytes)
      this.reset();
    this.frameBytes = frame.length;
    this.frames.push(frame.slice());
    if (this.frames.length < 5) return undefined;
    if (this.frames.length > 5) this.frames.shift();
    const encoded = new Uint8Array(frame.length * 5);
    this.frames.forEach((item, index) =>
      encoded.set(item, index * frame.length),
    );
    const inspection = inspectDabPlusSuperframe(encoded);
    this.stats.candidateWindows += 1;
    this.stats.lastCorrectedColumns = inspection.correctedColumns;
    this.stats.bestCorrectedColumns = Math.max(
      this.stats.bestCorrectedColumns,
      inspection.correctedColumns,
    );
    if (inspection.rejection === "reed-solomon")
      this.stats.reedSolomonFailures += 1;
    else if (inspection.rejection === "fire-code")
      this.stats.fireCodeFailures += 1;
    else if (inspection.rejection) this.stats.headerFailures += 1;
    if (inspection.superframe) this.frames.length = 0;
    return inspection.superframe;
  }
}

export interface DabPlusProgrammeStats {
  pad?: ReturnType<DabPlusProgrammeDecoder["padDiagnostics"]>;
  format?: DabPlusAudioFormat;
  superframes: number;
  accessUnits: number;
  rejectedAccessUnits: number;
  correctedBytes: number;
  candidateWindows: number;
  reedSolomonFailures: number;
  fireCodeFailures: number;
  headerFailures: number;
  lastCorrectedColumns: number;
  bestCorrectedColumns: number;
}

/** MSC-side endpoint: decoded 24 ms subchannel frames in, browser PCM out. */
export class DabPlusProgrammeDecoder {
  private readonly synchronizer = new DabPlusSuperframeSynchronizer();
  private readonly pad: DabPadDecoder;
  padDiagnostics() {
    return this.pad.diagnostics;
  }
  private configuredFormat?: string;
  private delivery = Promise.resolve();
  private generation = 0;
  private stats: DabPlusProgrammeStats = {
    superframes: 0,
    accessUnits: 0,
    rejectedAccessUnits: 0,
    correctedBytes: 0,
    candidateWindows: 0,
    reedSolomonFailures: 0,
    fireCodeFailures: 0,
    headerFailures: 0,
    lastCorrectedColumns: 0,
    bestCorrectedColumns: 0,
  };
  constructor(
    private readonly audio: WebCodecsDabAudioDecoder,
    private readonly onStats: (stats: DabPlusProgrammeStats) => void = () =>
      undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
    onMetadata: (metadata: DabProgrammeMetadata) => void = () => undefined,
  ) {
    this.pad = new DabPadDecoder(onMetadata);
  }
  pushLogicalFrame(frame: Uint8Array): void {
    const previousFailures = this.synchronizer.diagnostics.reedSolomonFailures;
    const superframe = this.synchronizer.push(frame);
    this.publishSynchronizerStats();
    if (!superframe) {
      if (
        this.synchronizer.diagnostics.reedSolomonFailures !== previousFailures
      )
        this.pad.discontinuity();
      return;
    }
    let expectedIndex = 0;
    for (const unit of superframe.accessUnits) {
      if (unit.index !== expectedIndex) this.pad.discontinuity();
      this.pad.processAccessUnit(unit.data);
      expectedIndex = unit.index + 1;
    }
    if (
      expectedIndex !==
      superframe.accessUnits.length + superframe.rejectedAccessUnits
    )
      this.pad.discontinuity();
    const generation = this.generation;
    this.delivery = this.delivery
      .then(() =>
        generation === this.generation
          ? this.deliver(superframe, generation)
          : undefined,
      )
      .catch((error: unknown) => {
        if (generation === this.generation) this.onError(error);
      });
  }
  async flush(): Promise<void> {
    await this.delivery;
    await this.audio.flush();
  }
  reset(): void {
    this.generation += 1;
    this.pad.reset();
    this.synchronizer.reset();
    this.audio.reset();
    this.configuredFormat = undefined;
    this.stats = {
      superframes: 0,
      accessUnits: 0,
      rejectedAccessUnits: 0,
      correctedBytes: 0,
      candidateWindows: 0,
      reedSolomonFailures: 0,
      fireCodeFailures: 0,
      headerFailures: 0,
      lastCorrectedColumns: 0,
      bestCorrectedColumns: 0,
    };
  }
  close(): void {
    this.reset();
    this.audio.close();
  }
  private async deliver(
    superframe: DabPlusSuperframe,
    generation: number,
  ): Promise<void> {
    const formatKey = JSON.stringify(superframe.format);
    if (formatKey !== this.configuredFormat) {
      await this.audio.configure(superframe.format);
      if (generation !== this.generation) return;
      this.configuredFormat = formatKey;
    }
    for (const unit of superframe.accessUnits) this.audio.decode(unit.data);
    this.stats = {
      pad: this.pad.diagnostics,
      format: superframe.format,
      superframes: this.stats.superframes + 1,
      accessUnits: this.stats.accessUnits + superframe.accessUnits.length,
      rejectedAccessUnits:
        this.stats.rejectedAccessUnits + superframe.rejectedAccessUnits,
      correctedBytes: this.stats.correctedBytes + superframe.correctedBytes,
      candidateWindows: this.stats.candidateWindows,
      reedSolomonFailures: this.stats.reedSolomonFailures,
      fireCodeFailures: this.stats.fireCodeFailures,
      headerFailures: this.stats.headerFailures,
      lastCorrectedColumns: this.stats.lastCorrectedColumns,
      bestCorrectedColumns: this.stats.bestCorrectedColumns,
    };
    this.onStats({ ...this.stats });
  }

  private publishSynchronizerStats(): void {
    this.stats = {
      ...this.stats,
      ...this.synchronizer.diagnostics,
      pad: this.pad.diagnostics,
    };
    this.onStats({ ...this.stats });
  }
}
