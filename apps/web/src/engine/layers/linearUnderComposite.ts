// Straight-alpha composition of sRGB bytes; match the linear-light viewport.
import {SRGB_BYTE_TO_LINEAR as linear,linearToSrgbByte} from '../bake/qualityBlendCpuPixel';
export function compositeLinearChannel(front:number, under:number, af:number, au:number, alpha:number) {
  const c=(linear[front]*af+linear[under]*au)/alpha;
  return linearToSrgbByte(c);
}
