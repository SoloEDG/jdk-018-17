import type { Asset, Settings } from "../../../shared/document";
import type { Calibration } from "./state";
import {
  type Corners,
  type GridGeometry,
  cellCorners,
  mapPoint,
} from "./coverage";

/**
 * 原图级离屏缓冲：校准采样直接读取原图像素（含背景填充），
 * 与旧的 drawImage 降采样路径分离。缓存按 asset 复用，换图即释放。
 */
class SourceBuffer {
  private constructor(
    readonly data: Uint8ClampedArray,
    readonly width: number,
    readonly height: number,
  ) {}

  static acquire(asset: Asset, background: string): SourceBuffer {
    const key = asset.url + "\0" + background;
    const hit = SourceBuffer.cache.get(key);
    if (hit) return hit;
    const canvas = document.createElement("canvas");
    canvas.width = asset.width;
    canvas.height = asset.height;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.fillStyle = background;
    g.fillRect(0, 0, asset.width, asset.height);
    g.drawImage(asset.image, 0, 0);
    const data = g.getImageData(0, 0, asset.width, asset.height).data;
    const buffer = new SourceBuffer(data, asset.width, asset.height);
    SourceBuffer.cache.set(key, buffer);
    // 只保留最近两个（不同背景色）缓冲，避免大图长期占用内存
    if (SourceBuffer.cache.size > 2) {
      const oldest = SourceBuffer.cache.keys().next().value as string;
      SourceBuffer.cache.delete(oldest);
    }
    return buffer;
  }

  static clear(): void {
    SourceBuffer.cache.clear();
  }

  private static cache = new Map<string, SourceBuffer>();

  /** 双线性取色；越界按边缘像素钳制（画布绘制时的边缘行为与之相同）。 */
  sample(x: number, y: number, out: number[]): void {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const xa = Math.max(0, Math.min(this.width - 1, x0));
    const xb = Math.max(0, Math.min(this.width - 1, x0 + 1));
    const ya = Math.max(0, Math.min(this.height - 1, y0));
    const yb = Math.max(0, Math.min(this.height - 1, y0 + 1));
    const ia = (ya * this.width + xa) * 4;
    const ib = (ya * this.width + xb) * 4;
    const ic = (yb * this.width + xa) * 4;
    const id = (yb * this.width + xb) * 4;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    for (let ch = 0; ch < 3; ch++) {
      out[ch] =
        this.data[ia + ch]! * w00 +
        this.data[ib + ch]! * w10 +
        this.data[ic + ch]! * w01 +
        this.data[id + ch]! * w11;
    }
  }
}

export function releaseSourceBuffers(): void {
  SourceBuffer.clear();
}

export interface SampleResult {
  r: number;
  g: number;
  b: number;
}

function cornersFor(
  geo: GridGeometry,
  calibration: Calibration | null,
  cy: number,
  cx: number,
  out: Corners,
): Corners {
  if (!calibration) return cellCorners(geo, null, cy, cx, out);
  if (calibration.mode === "global") {
    cellCorners(geo, null, cy, cx, out);
    for (const q of out) {
      q.x += calibration.dx;
      q.y += calibration.dy;
    }
    return out;
  }
  return cellCorners(geo, calibration.field, cy, cx, out);
}

function averageSamples(
  buffer: SourceBuffer,
  corners: Corners,
  k: number,
): SampleResult {
  const p = { x: 0, y: 0 };
  const rgb = [0, 0, 0];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let v = 0; v < k; v++) {
    for (let u = 0; u < k; u++) {
      mapPoint(corners, (u + 0.5) / k, (v + 0.5) / k, p);
      buffer.sample(p.x, p.y, rgb);
      r += rgb[0]!;
      g += rgb[1]!;
      b += rgb[2]!;
    }
  }
  const n = k * k;
  return { r: r / n, g: g / n, b: b / n };
}

/** 正式生成用的全格网加权采样，K=3 超采样。 */
export function sampleGrid(
  asset: Asset,
  settings: Settings,
  geo: GridGeometry,
  calibration: Calibration | null,
): Uint8ClampedArray {
  const buffer = SourceBuffer.acquire(asset, settings.background);
  const out = new Uint8ClampedArray(geo.cols * geo.rows * 4);
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  const k = 3;
  let idx = 0;
  for (let cy = 0; cy < geo.rows; cy++) {
    for (let cx = 0; cx < geo.cols; cx++) {
      cornersFor(geo, calibration, cy, cx, corners);
      const s = averageSamples(buffer, corners, k);
      out[idx++] = s.r;
      out[idx++] = s.g;
      out[idx++] = s.b;
      out[idx++] = 255;
    }
  }
  return out;
}

/** 检查报告用的单格高精度采样，K=5，可按草稿校准实时预览。 */
export function sampleCell(
  asset: Asset,
  settings: Settings,
  geo: GridGeometry,
  calibration: Calibration | null,
  cy: number,
  cx: number,
  k = 5,
): SampleResult {
  const buffer = SourceBuffer.acquire(asset, settings.background);
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  cornersFor(geo, calibration, cy, cx, corners);
  return averageSamples(buffer, corners, k);
}

/** 未校准（名义覆盖）单格采样，用于报告里的「原始格色」对照。 */
export function sampleNominalCell(
  asset: Asset,
  settings: Settings,
  geo: GridGeometry,
  cy: number,
  cx: number,
): SampleResult {
  return sampleCell(asset, settings, geo, null, cy, cx);
}

export function toHex(s: SampleResult): string {
  return (
    "#" +
    [s.r, s.g, s.b]
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(v)))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}
