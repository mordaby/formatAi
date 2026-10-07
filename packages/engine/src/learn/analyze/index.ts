// Column profile (SPEC 7.1) and pair analysis (SPEC 6.2), run in the browser
// on the real data before any LLM call. Consumed by pre-flight, the local fast
// path and the payload builder.

export { analyzePair, DEFAULT_MIN_COVERAGE, DEFAULT_SAMPLE_SIZE, DEFAULT_SEED } from './analyzePair';
export { constantDerivation, findDerivation, isDerivedColumn, isExternalColumn, MAX_BREAKPOINTS } from './derived';
export { isSafeShape, profileColumns, toPayloadColumn, shapeOf } from './profile';
export { mulberry32, sampleIndices } from './prng';
export type * from './types';
