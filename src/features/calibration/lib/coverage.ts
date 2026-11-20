import type { Asset, StudioDocument } from "../../../shared/document";
import { gridSize } from "../../mapping/lib/gridSize";

/**
 * 采样几何全部描述在「原图像素空间」。
 * 缩放 / 滚动 / 高分屏只改变检查画布的显示变换，绝不进入这里的数学。
 */
export interface GridGeometry {
  cols: number;
  rows: number;
  cropX: number;
  cropY: number;
  cropW: number;
  cropH: number;
  cellW: number;
  cellH: number;
}

export function gridGeometry(doc: StudioDocument): GridGeometry {
  const asset = doc.asset;
  if (!asset) throw new Error("缺少原图");
  const cropW = asset.width * doc.crop.width;
  const cropH = asset.height * doc.crop.height;
  const size = gridSize(cropW, cropH, doc.settings.columns);
  const cropX = doc.crop.x * asset.width;
  const cropY = doc.crop.y * asset.height;
  return {
    cols: size.columns,
    rows: size.rows,
    cropX,
    cropY,
    cropW,
    cropH,
    cellW: cropW / size.columns,
    cellH: cropH / size.rows,
  };
}

/**
 * 采样配置指纹：原图、裁剪、密度共同决定格网。
 * 任一项变化后旧校准签名失配，必须重新推导覆盖范围，禁止沿用旧格索引。
 */
export function configSignature(doc: StudioDocument): string {
  if (!doc.asset) return "no-asset";
  const g = gridGeometry(doc);
  const c = doc.crop;
  return [
    doc.asset.name,
    doc.asset.width,
    doc.asset.height,
    c.x.toFixed(6),
    c.y.toFixed(6),
    c.width.toFixed(6),
    c.height.toFixed(6),
    g.cols,
    g.rows,
  ].join("|");
}

export interface Pt {
  x: number;
  y: number;
}

export function fieldLength(geo: GridGeometry): number {
  return 2 * (geo.rows + 1) * (geo.cols + 1);
}

export function createField(geo: GridGeometry): Float32Array {
  return new Float32Array(fieldLength(geo));
}

export function nodeIndex(geo: GridGeometry, i: number, j: number): number {
  return 2 * (i * (geo.cols + 1) + j);
}

/** 节点 (i,j) 的实际位置 = 名义位置 + 局部位移；field 为 null 时返回名义位置。 */
export function nodePosition(
  geo: GridGeometry,
  field: Float32Array | null,
  i: number,
  j: number,
  out: Pt,
): Pt {
  out.x = geo.cropX + j * geo.cellW;
  out.y = geo.cropY + i * geo.cellH;
  if (field) {
    const k = nodeIndex(geo, i, j);
    out.x += field[k]!;
    out.y += field[k + 1]!;
  }
  return out;
}

/** 单元四角，顺序 TL, TR, BR, BL。 */
export type Corners = [Pt, Pt, Pt, Pt];

export function cellCorners(
  geo: GridGeometry,
  field: Float32Array | null,
  cy: number,
  cx: number,
  out: Corners,
): Corners {
  nodePosition(geo, field, cy, cx, out[0]!);
  nodePosition(geo, field, cy, cx + 1, out[1]!);
  nodePosition(geo, field, cy + 1, cx + 1, out[2]!);
  nodePosition(geo, field, cy + 1, cx, out[3]!);
  return out;
}

/** 双线性映射：单元局部坐标 (u,v) -> 原图坐标。局部平滑校准靠它保证连续。 */
export function mapPoint(c: Corners, u: number, v: number, out: Pt): Pt {
  const w00 = (1 - u) * (1 - v);
  const w10 = u * (1 - v);
  const w11 = u * v;
  const w01 = (1 - u) * v;
  out.x = w00 * c[0]!.x + w10 * c[1]!.x + w11 * c[2]!.x + w01 * c[3]!.x;
  out.y = w00 * c[0]!.y + w10 * c[1]!.y + w11 * c[2]!.y + w01 * c[3]!.y;
  return out;
}

export function quadArea(c: Corners): number {
  let s = 0;
  for (let k = 0; k < 4; k++) {
    const a = c[k]!;
    const b = c[(k + 1) % 4]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

/** 相对采样权重：名义面积 / 实际覆盖面积，>1 表示被压缩、单位像素权重升高。 */
export function cellWeight(geo: GridGeometry, c: Corners): number {
  const area = quadArea(c);
  if (area <= 1e-9) return Number.POSITIVE_INFINITY;
  return (geo.cellW * geo.cellH) / area;
}

export interface ValidationResult {
  invalid: Uint8Array;
  fold: Uint8Array;
  bounds: Uint8Array;
  count: number;
  foldCount: number;
  boundsCount: number;
}

function checkCell(
  geo: GridGeometry,
  asset: Asset,
  field: Float32Array,
  cy: number,
  cx: number,
  corners: Corners,
  pu: Pt,
  pv: Pt,
): { folded: boolean; outOfBounds: boolean } {
  cellCorners(geo, field, cy, cx, corners);
  const b = 1e-3;
  let outOfBounds = false;
  for (const q of corners) {
    if (
      q.x < -b ||
      q.y < -b ||
      q.x > asset.width + b ||
      q.y > asset.height + b
    ) {
      outOfBounds = true;
      break;
    }
  }
  const epsArea = 1e-6 * geo.cellW * geo.cellH;
  let folded = false;
  for (let s = 0; s <= 2 && !folded; s++) {
    for (let t = 0; t <= 2; t++) {
      const u = s / 2;
      const v = t / 2;
      pu.x =
        (1 - v) * (corners[1]!.x - corners[0]!.x) +
        v * (corners[2]!.x - corners[3]!.x);
      pu.y =
        (1 - v) * (corners[1]!.y - corners[0]!.y) +
        v * (corners[2]!.y - corners[3]!.y);
      pv.x =
        (1 - u) * (corners[3]!.x - corners[0]!.x) +
        u * (corners[2]!.x - corners[1]!.x);
      pv.y =
        (1 - u) * (corners[3]!.y - corners[0]!.y) +
        u * (corners[2]!.y - corners[1]!.y);
      const det = pu.x * pv.y - pu.y * pv.x;
      if (!(det > epsArea)) {
        folded = true;
        break;
      }
    }
  }
  return { folded, outOfBounds };
}

/**
 * 局部场全量校验：
 * 1. 越界 —— 任一角点跑出原图范围（双线性像落在四角凸包内，角点合法即整格合法）；
 * 2. 折叠 —— 雅可比行列式在 3x3 采样点上必须全部为正，防止局部拉动造成区域折叠。
 */
export function validateLocal(
  geo: GridGeometry,
  asset: Asset,
  field: Float32Array,
): ValidationResult {
  const total = geo.rows * geo.cols;
  const result: ValidationResult = {
    invalid: new Uint8Array(total),
    fold: new Uint8Array(total),
    bounds: new Uint8Array(total),
    count: 0,
    foldCount: 0,
    boundsCount: 0,
  };
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  const pu = { x: 0, y: 0 };
  const pv = { x: 0, y: 0 };
  for (let cy = 0; cy < geo.rows; cy++) {
    for (let cx = 0; cx < geo.cols; cx++) {
      const { folded, outOfBounds } = checkCell(
        geo,
        asset,
        field,
        cy,
        cx,
        corners,
        pu,
        pv,
      );
      const idx = cy * geo.cols + cx;
      if (folded) {
        result.fold[idx] = 1;
        result.foldCount++;
      }
      if (outOfBounds) {
        result.bounds[idx] = 1;
        result.boundsCount++;
      }
      if (folded || outOfBounds) {
        result.invalid[idx] = 1;
        result.count++;
      }
    }
  }
  return result;
}

/**
 * 增量校验：节点 (i,j) 只属于相邻至多 4 个单元，
 * 拖动节点时重算这些单元即可，避免对整网做 O(rows*cols) 扫描。
 * 直接改写传入的校验结果并返回同一引用。
 */
export function revalidateAround(
  geo: GridGeometry,
  asset: Asset,
  field: Float32Array,
  result: ValidationResult,
  i: number,
  j: number,
): ValidationResult {
  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  const pu = { x: 0, y: 0 };
  const pv = { x: 0, y: 0 };
  for (let cy = Math.max(0, i - 1); cy <= Math.min(geo.rows - 1, i); cy++) {
    for (
      let cx = Math.max(0, j - 1);
      cx <= Math.min(geo.cols - 1, j);
      cx++
    ) {
      const idx = cy * geo.cols + cx;
      // 先扣除旧标记
      if (result.fold[idx]) {
        result.fold[idx] = 0;
        result.foldCount--;
      }
      if (result.bounds[idx]) {
        result.bounds[idx] = 0;
        result.boundsCount--;
      }
      if (result.invalid[idx]) {
        result.invalid[idx] = 0;
        result.count--;
      }
      const { folded, outOfBounds } = checkCell(
        geo,
        asset,
        field,
        cy,
        cx,
        corners,
        pu,
        pv,
      );
      if (folded) {
        result.fold[idx] = 1;
        result.foldCount++;
      }
      if (outOfBounds) {
        result.bounds[idx] = 1;
        result.boundsCount++;
      }
      if (folded || outOfBounds) {
        result.invalid[idx] = 1;
        result.count++;
      }
    }
  }
  return result;
}

/** 全局偏移校验：平移后的整个采样区必须仍在原图边界内。 */
export function globalBounds(
  asset: Asset,
  geo: GridGeometry,
  dx: number,
  dy: number,
): { ok: boolean; dxOk: boolean; dyOk: boolean } {
  const e = 1e-3;
  const dxOk =
    geo.cropX + dx >= -e && geo.cropX + geo.cropW + dx <= asset.width + e;
  const dyOk =
    geo.cropY + dy >= -e && geo.cropY + geo.cropH + dy <= asset.height + e;
  return { ok: dxOk && dyOk, dxOk, dyOk };
}

export function pointInQuad(p: Pt, c: Corners): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const a = c[k]!;
    const b = c[(k + 1) % 4]!;
    const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 只在名义节点附近检索，避免对几十万节点做全量扫描。 */
export function nearestNode(
  geo: GridGeometry,
  p: Pt,
): { i: number; j: number } {
  const j = Math.round((p.x - geo.cropX) / geo.cellW);
  const i = Math.round((p.y - geo.cropY) / geo.cellH);
  return {
    i: Math.max(0, Math.min(geo.rows, i)),
    j: Math.max(0, Math.min(geo.cols, j)),
  };
}

export function cellAt(
  geo: GridGeometry,
  p: Pt,
): { cx: number; cy: number } | null {
  if (
    p.x < geo.cropX ||
    p.y < geo.cropY ||
    p.x > geo.cropX + geo.cropW ||
    p.y > geo.cropY + geo.cropH
  )
    return null;
  const cx = Math.min(
    geo.cols - 1,
    Math.max(0, Math.floor((p.x - geo.cropX) / geo.cellW)),
  );
  const cy = Math.min(
    geo.rows - 1,
    Math.max(0, Math.floor((p.y - geo.cropY) / geo.cellH)),
  );
  return { cx, cy };
}
