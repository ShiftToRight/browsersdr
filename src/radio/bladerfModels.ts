export type BladeRfMicroModel = "xA4" | "xA5" | "xA9";

export interface BladeRfFirmwareVersion {
  major: number;
  minor: number;
}

export type BladeRfVariantValidation = "existing-xa4-profile" | "experimental";

const MODELS: readonly BladeRfMicroModel[] = ["xA4", "xA5", "xA9"];

export function isBladeRfMicroModel(
  value: unknown,
): value is BladeRfMicroModel {
  return (
    typeof value === "string" && MODELS.includes(value as BladeRfMicroModel)
  );
}

export function assertBladeRfMicroModel(
  value: unknown,
): asserts value is BladeRfMicroModel {
  if (!isBladeRfMicroModel(value))
    throw new Error(
      "The detected bladeRF 2.0 Micro model is invalid or unsupported.",
    );
}

export function bladeRfModelLabel(model: BladeRfMicroModel): string {
  assertBladeRfMicroModel(model);
  return `bladeRF 2.0 Micro ${model}`;
}

export function bladeRfModelValidation(
  model: BladeRfMicroModel,
): BladeRfVariantValidation {
  assertBladeRfMicroModel(model);
  return model === "xA4" ? "existing-xa4-profile" : "experimental";
}
