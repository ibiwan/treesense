import { scale, clamp, type Options } from "./helper.js";

export function run(seed: number): number {
  // Bare identifier argument: `trace` can follow this one into `scale`.
  const scaled = scale(seed, 3);

  // Argument is an expression, not a bare identifier: `trace` must stop here
  // reporting `non-ident-arg` rather than following it.
  const clamped = clamp(scaled + 1, 100);

  return clamped;
}

export const config: Options = { name: "demo", value: 1 };
