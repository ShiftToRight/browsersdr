export const RS41_RS_N = 255;
export const RS41_RS_K = 231;
export const RS41_RS_PARITY = 24;
export const RS41_RS_CAPABILITY = 12;

const EXP = new Uint8Array(512);
const LOG = new Int16Array(256).fill(-1);
let value = 1;
for (let index = 0; index < 255; index++) {
  EXP[index] = value;
  LOG[value] = index;
  value <<= 1;
  if ((value & 0x100) !== 0) value ^= 0x11d;
}
for (let index = 255; index < EXP.length; index++)
  EXP[index] = EXP[index - 255]!;

function multiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[LOG[left]! + LOG[right]!]!;
}

function divide(left: number, right: number): number {
  if (right === 0) throw new Error("Reed-Solomon division by zero.");
  if (left === 0) return 0;
  return EXP[(LOG[left]! - LOG[right]! + 255) % 255]!;
}

export function rs41Syndromes(codeword: Uint8Array): Uint8Array {
  if (codeword.length !== RS41_RS_N)
    throw new Error("RS41 codeword must contain 255 bytes.");
  return Uint8Array.from({ length: RS41_RS_PARITY }, (_, root) => {
    const x = EXP[root]!;
    let power = 1;
    let syndrome = 0;
    for (const coefficient of codeword) {
      syndrome ^= multiply(coefficient, power);
      power = multiply(power, x);
    }
    return syndrome;
  });
}

function errorLocator(syndromes: Uint8Array): number[] | undefined {
  const locator = Array<number>(RS41_RS_PARITY + 1).fill(0);
  const previous = Array<number>(RS41_RS_PARITY + 1).fill(0);
  locator[0] = previous[0] = 1;
  let degree = 0;
  let distance = 1;
  let lastDiscrepancy = 1;
  for (let step = 0; step < syndromes.length; step++) {
    let discrepancy = syndromes[step]!;
    for (let index = 1; index <= degree; index++)
      discrepancy ^= multiply(locator[index]!, syndromes[step - index]!);
    if (discrepancy === 0) {
      distance++;
      continue;
    }
    const saved = locator.slice();
    const scale = divide(discrepancy, lastDiscrepancy);
    for (let index = 0; index + distance < locator.length; index++)
      locator[index + distance] =
        locator[index + distance]! ^ multiply(scale, previous[index]!);
    if (2 * degree <= step) {
      degree = step + 1 - degree;
      for (let index = 0; index < previous.length; index++)
        previous[index] = saved[index]!;
      lastDiscrepancy = discrepancy;
      distance = 1;
    } else distance++;
  }
  return degree <= RS41_RS_CAPABILITY
    ? locator.slice(0, degree + 1)
    : undefined;
}

function findErrorPositions(locator: number[]): number[] | undefined {
  const count = locator.length - 1;
  const positions: number[] = [];
  for (let position = 0; position < RS41_RS_N; position++) {
    const inverseLocation = EXP[(255 - position) % 255]!;
    let value = 0;
    let power = 1;
    for (const coefficient of locator) {
      value ^= multiply(coefficient, power);
      power = multiply(power, inverseLocation);
    }
    if (value === 0) positions.push(position);
  }
  return positions.length === count ? positions : undefined;
}

function solveMagnitudes(
  positions: number[],
  syndromes: Uint8Array,
): number[] | undefined {
  const count = positions.length;
  const matrix = Array.from({ length: count }, (_, row) => {
    const values = positions.map((position) => {
      const location = EXP[position % 255]!;
      return row === 0 ? 1 : EXP[(LOG[location]! * row) % 255]!;
    });
    values.push(syndromes[row]!);
    return values;
  });
  for (let column = 0; column < count; column++) {
    const pivot = matrix.findIndex(
      (row, index) => index >= column && row[column] !== 0,
    );
    if (pivot < 0) return undefined;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    const divisor = matrix[column]![column]!;
    for (let j = column; j <= count; j++)
      matrix[column]![j] = divide(matrix[column]![j]!, divisor);
    for (let row = 0; row < count; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      if (factor === 0) continue;
      for (let j = column; j <= count; j++)
        matrix[row]![j] =
          matrix[row]![j]! ^ multiply(factor, matrix[column]![j]!);
    }
  }
  return matrix.map((row) => row[count]!);
}

export interface ReedSolomonResult {
  status: "uncorrected" | "corrected" | "rejected";
  correctedErrors: number;
  codeword: Uint8Array;
}

export function decodeRs41Codeword(input: Uint8Array): ReedSolomonResult {
  const codeword = input.slice();
  const syndromes = rs41Syndromes(codeword);
  if (syndromes.every((syndrome) => syndrome === 0))
    return { status: "uncorrected", correctedErrors: 0, codeword };
  const locator = errorLocator(syndromes);
  const positions = locator && findErrorPositions(locator);
  if (
    !positions ||
    positions.length === 0 ||
    positions.length > RS41_RS_CAPABILITY
  )
    return { status: "rejected", correctedErrors: 0, codeword };
  const magnitudes = solveMagnitudes(positions, syndromes);
  if (!magnitudes) return { status: "rejected", correctedErrors: 0, codeword };
  for (let index = 0; index < positions.length; index++)
    codeword[positions[index]!] =
      codeword[positions[index]!]! ^ magnitudes[index]!;
  if (!rs41Syndromes(codeword).every((syndrome) => syndrome === 0))
    return { status: "rejected", correctedErrors: 0, codeword: input.slice() };
  return { status: "corrected", correctedErrors: positions.length, codeword };
}

export interface Rs41FrameFecResult {
  status: "uncorrected" | "corrected" | "rejected";
  correctedErrors: number;
  frame: Uint8Array;
}

export function correctRs41Frame(input: Uint8Array): Rs41FrameFecResult {
  if (input.length !== 320 && input.length !== 518)
    throw new Error("RS41 frame must contain 320 or 518 bytes.");
  const frame = new Uint8Array(518);
  frame.set(input);
  const first = new Uint8Array(255);
  const second = new Uint8Array(255);
  first.set(frame.subarray(8, 32), 0);
  second.set(frame.subarray(32, 56), 0);
  for (let index = 0; index < RS41_RS_K; index++) {
    first[24 + index] = frame[56 + index * 2]!;
    second[24 + index] = frame[57 + index * 2]!;
  }
  const result1 = decodeRs41Codeword(first);
  const result2 = decodeRs41Codeword(second);
  if (result1.status === "rejected" || result2.status === "rejected")
    return { status: "rejected", correctedErrors: 0, frame: input.slice() };
  frame.set(result1.codeword.subarray(0, 24), 8);
  frame.set(result2.codeword.subarray(0, 24), 32);
  for (let index = 0; index < RS41_RS_K; index++) {
    frame[56 + index * 2] = result1.codeword[24 + index]!;
    frame[57 + index * 2] = result2.codeword[24 + index]!;
  }
  return {
    status:
      result1.status === "corrected" || result2.status === "corrected"
        ? "corrected"
        : "uncorrected",
    correctedErrors: result1.correctedErrors + result2.correctedErrors,
    frame: frame.slice(0, input.length),
  };
}
