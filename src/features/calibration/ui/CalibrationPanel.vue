<script setup lang="ts">
import { computed } from "vue";
import {
  Crosshair,
  Move3d,
  Grid3x3,
  TriangleAlert,
  Check,
  X,
  RotateCcw,
  Ruler,
} from "lucide-vue-next";
import { useStudio } from "../../../shared/useStudio";
import { useCalibration } from "../lib/state";
import {
  cellCorners,
  cellWeight,
  globalBounds,
  type Corners,
} from "../lib/coverage";
import {
  sampleCell,
  sampleNominalCell,
  toHex,
} from "../lib/sampler";
import { tone, luminance } from "../../mapping/lib/tone";
import { glyphs } from "../../mapping/lib/charsets";

const { doc, notice } = useStudio();
const cal = useCalibration();

const geometryError = computed(() => {
  try {
    cal.geometry();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "采样几何推导失败";
  }
});
const geo = computed(() => {
  try {
    return cal.geometry();
  } catch {
    return {
      cols: 1,
      rows: 1,
      cropX: 0,
      cropY: 0,
      cropW: doc.asset?.width ?? 1,
      cropH: doc.asset?.height ?? 1,
      cellW: doc.asset?.width ?? 1,
      cellH: doc.asset?.height ?? 1,
    };
  }
});
const selectedCell = computed(() => {
  const sel = cal.selected.value;
  if (sel == null) return null;
  const cols = geo.value.cols;
  return { index: sel, cy: Math.floor(sel / cols), cx: sel % cols };
});

const draftCalibration = computed(() => {
  if (cal.mode.value === "global") {
    if (cal.dx.value === 0 && cal.dy.value === 0) return null;
    return {
      mode: "global" as const,
      dx: cal.dx.value,
      dy: cal.dy.value,
      field: new Float32Array(0),
      signature: "",
      confirmedAt: 0,
    };
  }
  const field = cal.draftField.value;
  if (!field) return null;
  return {
    mode: "local" as const,
    dx: 0,
    dy: 0,
    field,
    signature: "",
    confirmedAt: 0,
  };
});

// 草稿变化时重算报告
const reportVersion = computed(() => cal.draftVersion.value);

const report = computed(() => {
  void reportVersion.value;
  const cell = selectedCell.value;
  const asset = doc.asset;
  if (!cell || !asset) return null;
  const gm = geo.value;
  const s = doc.settings;

  // 1. 原始格色：名义覆盖范围、未施加任何校准
  const raw = sampleNominalCell(asset, s, gm, cell.cy, cell.cx);
  // 2. 校正后格色：按当前草稿校准的实际覆盖采样
  const adjusted = sampleCell(
    asset,
    s,
    gm,
    draftCalibration.value,
    cell.cy,
    cell.cx,
  );
  // 3. 最终亮度：校正后格色经对比度/伽马/反转映射到字符阶梯的亮度值
  const lum = luminance(adjusted.r, adjusted.g, adjusted.b);
  const finalTone = tone(lum, s.contrast, s.gamma, s.invert);

  const corners: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  if (draftCalibration.value && draftCalibration.value.mode === "global") {
    cellCorners(gm, null, cell.cy, cell.cx, corners);
    for (const q of corners) {
      q.x += draftCalibration.value.dx;
      q.y += draftCalibration.value.dy;
    }
  } else if (draftCalibration.value) {
    cellCorners(gm, draftCalibration.value.field, cell.cy, cell.cx, corners);
  } else {
    cellCorners(gm, null, cell.cy, cell.cx, corners);
  }
  const weight = cellWeight(gm, corners);

  // 当前网格字符（可能来自旧采样）与按当前草稿推导的候选字符分开显示，
  // 避免用旧采样解释新的覆盖范围
  const currentGlyph = doc.grid?.cells[cell.index]?.glyph ?? "·";
  const chars = glyphs(s.charset, s.custom);
  const prospectGlyph =
    chars[Math.round(finalTone * (chars.length - 1))] ?? "·";

  return {
    rawHex: toHex(raw),
    adjustedHex: toHex(adjusted),
    rawLum: luminance(raw.r, raw.g, raw.b),
    adjustedLum: lum,
    finalTone,
    weight,
    currentGlyph,
    prospectGlyph,
    coverageW: corners[1]!.x - corners[0]!.x,
    coverageH: corners[3]!.y - corners[0]!.y,
    nominalW: gm.cellW,
    nominalH: gm.cellH,
  };
});

const validation = computed(() => {
  void reportVersion.value;
  // 与检查画布共享同一份增量校验结果，避免面板内重复全量扫描
  return cal.mode.value === "local" ? cal.validation.value : null;
});

const globalInvalid = computed(() => {
  void reportVersion.value;
  if (cal.mode.value !== "global" || !doc.asset) return false;
  return !globalBounds(doc.asset, geo.value, cal.dx.value, cal.dy.value).ok;
});

const invalid = computed(
  () =>
    geometryError.value !== null ||
    (cal.mode.value === "local"
      ? (validation.value?.count ?? 0) > 0
      : globalInvalid.value),
);

const stale = computed(
  () =>
    !!cal.confirmed.value &&
    cal.confirmed.value.signature !== cal.signature(),
);

function confirmCalibration() {
  if (invalid.value) {
    notice.value = "存在折叠或越界的无效采样范围，禁止确认";
    return;
  }
  cal.confirm();
}
</script>

<template>
  <section class="panel inspect-panel">
    <div class="section-title">
      <span>04 / SAMPLING INSPECT</span><Crosshair :size="15" />
    </div>

    <div class="mode-switch" role="tablist" aria-label="校准方式">
      <button
        :class="{ active: cal.mode.value === 'global' }"
        @click="cal.setMode('global')"
      >
        <Move3d :size="13" /> 全局偏移校准
      </button>
      <button
        :class="{ active: cal.mode.value === 'local' }"
        @click="cal.setMode('local')"
      >
        <Grid3x3 :size="13" /> 局部平滑校准
      </button>
    </div>

    <p class="mode-hint">
      <template v-if="cal.mode.value === 'global'">
        平移量作用于全部格的采样原点，单位为原图像素；缩放与滚动不改变校准值。
      </template>
      <template v-else>
        拖动节点在原图空间拉动采样网格，双线性插值保证相邻格连续；红色范围表示折叠或越界。
      </template>
    </p>

    <div v-if="geometryError" class="invalid-banner">
      <TriangleAlert :size="13" />
      {{ geometryError }}
    </div>

    <div v-if="cal.mode.value === 'global'" class="global-controls">
      <label class="field"
        >水平偏移 dx <b>{{ cal.dx.value.toFixed(1) }} px</b
        ><input
          aria-label="水平偏移"
          type="range"
          :min="-Math.round(geo.cropX)"
          :max="Math.round(doc.asset!.width - geo.cropX - geo.cropW)"
          step="0.5"
          :value="cal.dx.value"
          @input="cal.setGlobal(Number(($event.target as HTMLInputElement).value), cal.dy.value)"
      /></label>
      <label class="field"
        >垂直偏移 dy <b>{{ cal.dy.value.toFixed(1) }} px</b
        ><input
          aria-label="垂直偏移"
          type="range"
          :min="-Math.round(geo.cropY)"
          :max="Math.round(doc.asset!.height - geo.cropY - geo.cropH)"
          step="0.5"
          :value="cal.dy.value"
          @input="cal.setGlobal(cal.dx.value, Number(($event.target as HTMLInputElement).value))"
      /></label>
      <div class="nudge-row">
        <button class="icon-button" @click="cal.nudgeGlobal(-1, 0)">←1px</button>
        <button class="icon-button" @click="cal.nudgeGlobal(1, 0)">1px→</button>
        <button class="icon-button" @click="cal.nudgeGlobal(0, -1)">↑1px</button>
        <button class="icon-button" @click="cal.nudgeGlobal(0, 1)">1px↓</button>
        <button class="icon-button" aria-label="重置偏移" @click="cal.resetDraft">
          <RotateCcw :size="13" />
        </button>
      </div>
    </div>

    <div v-else class="local-controls">
      <div class="row hint">
        <span><Ruler :size="12" /> 直接在原图上拖动手柄校正采样</span>
        <button class="icon-button" aria-label="重置局部场" @click="cal.resetDraft">
          <RotateCcw :size="13" />
        </button>
      </div>
      <div v-if="validation" class="validation-line">
        <span v-if="validation.count === 0" class="ok">全部格采样有效</span>
        <span v-else class="bad">
          <TriangleAlert :size="12" />
          无效 {{ validation.count }} 格（折叠 {{ validation.foldCount }} · 越界
          {{ validation.boundsCount }}）
        </span>
      </div>
    </div>

    <div v-if="globalInvalid" class="invalid-banner">
      <TriangleAlert :size="13" />
      采样区已越出原图边界，超出部分将被钳制，禁止确认
    </div>

    <div v-if="stale" class="stale-banner">
      密度或裁剪已变化，已确认校准与当前格网不匹配，需重新推导覆盖范围
    </div>

    <!-- 检查报告：原始格色 / 校正后格色 / 最终亮度 三栏分离 -->
    <div class="report" v-if="report && selectedCell">
      <div class="report-head">
        <span>格 [{{ selectedCell.cy }}, {{ selectedCell.cx }}]</span>
      </div>
      <div class="glyph-compare">
        <div>
          <small>当前网格字符</small>
          <b>{{ report.currentGlyph === " " ? "␠" : report.currentGlyph }}</b>
        </div>
        <span>→</span>
        <div>
          <small>草稿候选字符</small>
          <b class="prospect">{{
            report.prospectGlyph === " " ? "␠" : report.prospectGlyph
          }}</b>
        </div>
      </div>
      <div class="swatch-row">
        <div class="swatch">
          <i :style="{ background: report.rawHex }" />
          <div>
            <small>原始格色</small>
            <b class="mono">{{ report.rawHex }}</b>
            <em>亮度 {{ report.rawLum.toFixed(0) }}</em>
          </div>
        </div>
        <div class="swatch">
          <i :style="{ background: report.adjustedHex }" />
          <div>
            <small>校正后格色</small>
            <b class="mono">{{ report.adjustedHex }}</b>
            <em>亮度 {{ report.adjustedLum.toFixed(0) }}</em>
          </div>
        </div>
        <div class="swatch tone-swatch">
          <i
            :style="{
              background: `rgb(${Math.round(report.finalTone * 255)},${Math.round(
                report.finalTone * 255,
              )},${Math.round(report.finalTone * 255)})`,
            }"
          />
          <div>
            <small>最终亮度</small>
            <b class="mono">{{ report.finalTone.toFixed(3) }}</b>
            <em>权重 {{ Number.isFinite(report.weight) ? `×${report.weight.toFixed(3)}` : "∞（面积趋零）" }}</em>
          </div>
        </div>
      </div>
      <div class="measure mono">
        名义覆盖 {{ report.nominalW.toFixed(1) }}×{{ report.nominalH.toFixed(1) }} px
        → 实际 {{ Math.abs(report.coverageW).toFixed(1) }}×{{
          Math.abs(report.coverageH).toFixed(1)
        }}
        px
      </div>
    </div>
    <div v-else class="report empty">
      在原图上点选一格，查看实际采样覆盖、权重与三色报告
    </div>

    <div class="inspect-actions">
      <button class="secondary" @click="cal.cancel()">
        <X :size="14" /> 取消
      </button>
      <button class="primary" :disabled="invalid" @click="confirmCalibration">
        <Check :size="14" /> 确认校准
      </button>
    </div>
  </section>
</template>
