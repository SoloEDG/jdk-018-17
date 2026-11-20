import type { StudioDocument, Grid, Cell } from "../../../shared/document";
import { glyphs } from "../lib/charsets";
import { gridSize } from "../lib/gridSize";
import { tone, luminance } from "../lib/tone";
import { sample } from "../lib/sample";
import {
  configSignature,
  gridGeometry,
} from "../../calibration/lib/coverage";
import type { Calibration } from "../../calibration/lib/state";
import { sampleGrid } from "../../calibration/lib/sampler";

/**
 * 正式生成：仅当已确认校准的指纹与当前（原图 × 裁剪 × 密度）完全匹配时才启用。
 * 密度或裁剪变化后签名失配，退回未校准采样，旧格索引/旧场一律不沿用。
 */
export function generate(doc: StudioDocument): Grid | null {
  if (!doc.asset) return null;
  const s = doc.settings;
  const size = gridSize(
    doc.asset.width * doc.crop.width,
    doc.asset.height * doc.crop.height,
    s.columns,
  );

  let active: Calibration | null = null;
  let pixels: Uint8ClampedArray;
  if (doc.calibration && doc.calibration.signature === configSignature(doc)) {
    active = doc.calibration;
    const geo = gridGeometry(doc);
    pixels = sampleGrid(doc.asset, s, geo, doc.calibration);
  } else {
    pixels = sample(
      doc.asset,
      doc.crop,
      size.columns,
      size.rows,
      s.background,
    );
  }

  const chars = glyphs(s.charset, s.custom);
  const cells: Cell[] = [];
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i]!,
      g = pixels[i + 1]!,
      b = pixels[i + 2]!;
    const t = tone(luminance(r, g, b), s.contrast, s.gamma, s.invert);
    cells.push({
      glyph: chars[Math.round(t * (chars.length - 1))]!,
      color:
        "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join(""),
    });
  }
  return {
    ...size,
    cells,
    revision: doc.revision,
    calibrationMode: active?.mode ?? null,
  };
}
