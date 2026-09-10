export declare const EMPTY_PROJECTION_COVERAGE_FEATHER_END: 0.12;
export declare const EMPTY_PROJECTION_MAX_VISIBLE_ALPHA: number;
export declare const PROJECTION_RELIABILITY_CUTOFF: number;
export declare function reliableProjectionSupport(support: number): number;
export declare const RELIABLE_PROJECTION_GLSL: string;
export declare function projectionGapMaskFromAlpha(
  image: { width: number; height: number; data: ArrayLike<number> },
  objectMask: { width: number; height: number; data: ArrayLike<number> },
): { width: number; height: number; data: Uint8ClampedArray };
