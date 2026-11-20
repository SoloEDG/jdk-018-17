<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useStudio } from "../../../shared/useStudio";
import { useCalibration, type Calibration } from "../lib/state";
import {
  type Corners,
  type GridGeometry,
  cellAt,
  cellCorners,
  cellWeight,
  globalBounds,
  mapPoint,
  nearestNode,
  nodeIndex,
} from "../lib/coverage";

const { doc } = useStudio();
const cal = useCalibration();

const wrap = ref<HTMLDivElement>();
const canvasEl = ref<HTMLCanvasElement>();

// 显示层状态：缩放/平移/高分屏只影响这两个值与 DPR，绝不进入采样数学
const scale = ref(1);
const offset = shallowRef({ x: 0, y: 0 });
let dpr = 1;

type Drag =
  | { kind: "pan"; startX: number; startY: number; ox: number; oy: number }
  | {
      kind: "global-pending";
      startImgX: number;
      startImgY: number;
      baseDx: number;
      baseDy: number;
    }
  | {
      kind: "global";
      startImgX: number;
      startImgY: number;
      baseDx: number;
      baseDy: number;
    }
  | { kind: "node"; i: number; j: number; grabDx: number; grabDy: number };
let drag: Drag | null = null;
const DRAG_THRESHOLD = 3;

const geometryError = ref<string | null>(null);

const geo = computed<GridGeometry>(() => {
  // 配置变化（含密度/裁剪）后重新推导覆盖范围；极端狭长裁剪会抛出可读错误
  try {
    const value = cal.geometry();
    geometryError.value = null;
    return value;
  } catch (e) {
    geometryError.value = e instanceof Error ? e.message : "采样几何推导失败";
    // 兜底几何，保证画布渲染函数不崩溃，错误信息会覆盖在检查区上
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

/** 当前草稿对应的校准对象（仅用于检查显示与报告预览，不影响已生成网格）。 */
const draftCalibration = computed<Calibration | null>(() => {
  if (cal.mode.value === "global") {
    if (cal.dx.value === 0 && cal.dy.value === 0) return null;
    return {
      mode: "global",
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
    mode: "local",
    dx: 0,
    dy: 0,
    field,
    signature: "",
    confirmedAt: 0,
  };
});

// 触发重绘的版本号：草稿每次修改都会递增
const redrawVersion = computed(
  () =>
    cal.draftVersion.value +
    (cal.selected.value ?? -1) +
    (cal.inspecting.value ? 1 : 0),
);

const validation = computed(() => {
  // 草稿版本建立依赖；校验本体由 store 在节点移动时增量维护
  void cal.draftVersion.value;
  return cal.validation.value;
});

const globalCheck = computed(() => {
  void cal.draftVersion.value;
  if (cal.mode.value !== "global" || !doc.asset)
    return { ok: true, dxOk: true, dyOk: true };
  return globalBounds(doc.asset, geo.value, cal.dx.value, cal.dy.value);
});

function cornersFor(cy: number, cx: number, out: Corners): Corners {
  const dc = draftCalibration.value;
  if (!dc) return cellCorners(geo.value, null, cy, cx, out);
  if (dc.mode === "global") {
    cellCorners(geo.value, null, cy, cx, out);
    for (const q of out) {
      q.x += dc.dx;
      q.y += dc.dy;
    }
    return out;
  }
  return cellCorners(geo.value, dc.field, cy, cx, out);
}

function toScreen(x: number, y: number) {
  return { x: x * scale.value + offset.value.x, y: y * scale.value + offset.value.y };
}
function toImage(clientX: number, clientY: number) {
  const b = canvasEl.value!.getBoundingClientRect();
  return {
    x: (clientX - b.left - offset.value.x) / scale.value,
    y: (clientY - b.top - offset.value.y) / scale.value,
  };
}

function fit() {
  const el = wrap.value;
  if (!el || !doc.asset) return;
  const rect = el.getBoundingClientRect();
  const s = Math.min(
    rect.width / doc.asset.width,
    rect.height / doc.asset.height,
  ) * 0.96;
  scale.value = s;
  offset.value = {
    x: (rect.width - doc.asset.width * s) / 2,
    y: (rect.height - doc.asset.height * s) / 2,
  };
}

let raf = 0;
function scheduleDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function draw() {
  const canvas = canvasEl.value;
  const wrapEl = wrap.value;
  const asset = doc.asset;
  if (!canvas || !wrapEl || !asset) return;
  const rect = wrapEl.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }
  const g = canvas.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = "#0c0e11";
  g.fillRect(0, 0, w, h);

  const s = scale.value;
  const ox = offset.value.x;
  const oy = offset.value.y;
  g.translate(ox, oy);
  g.scale(s, s);

  // 原图（检查底图，不含任何导出内容）
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(asset.image, 0, 0);

  const gm = geo.value;

  // 裁剪区之外压暗
  g.fillStyle = "rgba(8,10,12,0.62)";
  g.fillRect(0, 0, asset.width, gm.cropY);
  g.fillRect(
    0,
    gm.cropY + gm.cropH,
    asset.width,
    asset.height - gm.cropY - gm.cropH,
  );
  g.fillRect(0, gm.cropY, gm.cropX, gm.cropH);
  g.fillRect(
    gm.cropX + gm.cropW,
    gm.cropY,
    asset.width - gm.cropX - gm.cropW,
    gm.cropH,
  );

  const inv = validation.value;
  const sel = cal.selected.value;
  const selCx = sel == null ? -1 : sel % gm.cols;
  const selCy = sel == null ? -1 : Math.floor(sel / gm.cols);
  const scratch: Corners = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];

  // 无效范围：红色斜纹填充，必须始终可见
  if (inv && inv.count > 0) {
    g.save();
    g.strokeStyle = "rgba(255,86,86,0.9)";
    g.fillStyle = "rgba(255,60,60,0.22)";
    g.lineWidth = 1 / s;
    for (let cy = 0; cy < gm.rows; cy++) {
      for (let cx = 0; cx < gm.cols; cx++) {
        if (!inv.invalid[cy * gm.cols + cx]) continue;
        const c = cornersFor(cy, cx, scratch);
        g.beginPath();
        g.moveTo(c[0]!.x, c[0]!.y);
        for (let k = 1; k < 4; k++) g.lineTo(c[k]!.x, c[k]!.y);
        g.closePath();
        g.fill();
        g.stroke();
      }
    }
    g.restore();
  }

  // 全局模式越界：把越出原图的采样区用红框标出
  if (cal.mode.value === "global" && !globalCheck.value.ok) {
    g.save();
    g.strokeStyle = "rgba(255,86,86,0.95)";
    g.lineWidth = 2 / s;
    g.setLineDash([8 / s, 6 / s]);
    g.strokeRect(
      gm.cropX + cal.dx.value,
      gm.cropY + cal.dy.value,
      gm.cropW,
      gm.cropH,
    );
    g.restore();
  }

  // 名义格网（细线，仅在缩放足够大时绘制，避免百万线段卡顿）
  if (s * gm.cellW > 5) {
    g.save();
    g.strokeStyle = "rgba(220,240,180,0.16)";
    g.lineWidth = 1 / s;
    g.beginPath();
    for (let j = 0; j <= gm.cols; j++) {
      const x = gm.cropX + j * gm.cellW;
      g.moveTo(x, gm.cropY);
      g.lineTo(x, gm.cropY + gm.cropH);
    }
    for (let i = 0; i <= gm.rows; i++) {
      const y = gm.cropY + i * gm.cellH;
      g.moveTo(gm.cropX, y);
      g.lineTo(gm.cropX + gm.cropW, y);
    }
    g.stroke();
    g.restore();
  }

  // 选中格：名义范围（虚线）+ 实际采样覆盖（实线）+ 权重热力
  if (sel != null && selCy >= 0) {
    const nominal: Corners = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ];
    cellCorners(gm, null, selCy, selCx, nominal);
    const actual = cornersFor(selCy, selCx, scratch);
    const rawWeight = cellWeight(gm, actual);
    // 折叠格面积趋零时权重为 Infinity：热力按上限钳制，避免 rgba 出现 NaN
    const w = Number.isFinite(rawWeight) ? Math.min(rawWeight, 4) : 4;

    // 权重热力：w>1 偏暖（压缩、权重升高），w<1 偏冷（拉伸、权重降低）
    const heat = Math.max(-0.75, Math.min(1, w - 1));
    g.save();
    g.fillStyle =
      heat >= 0
        ? `rgba(255,176,82,${0.1 + heat * 0.35})`
        : `rgba(96,176,255,${0.1 + -heat * 0.35})`;
    g.beginPath();
    g.moveTo(actual[0]!.x, actual[0]!.y);
    for (let k = 1; k < 4; k++) g.lineTo(actual[k]!.x, actual[k]!.y);
    g.closePath();
    g.fill();

    // 名义覆盖虚线
    g.strokeStyle = "rgba(233,237,235,0.75)";
    g.lineWidth = 1.2 / s;
    g.setLineDash([5 / s, 4 / s]);
    g.strokeRect(
      nominal[0]!.x,
      nominal[0]!.y,
      gm.cellW,
      gm.cellH,
    );
    g.setLineDash([]);

    // 实际采样覆盖实线
    g.strokeStyle = "#d6ed9e";
    g.lineWidth = 2 / s;
    g.beginPath();
    g.moveTo(actual[0]!.x, actual[0]!.y);
    for (let k = 1; k < 4; k++) g.lineTo(actual[k]!.x, actual[k]!.y);
    g.closePath();
    g.stroke();

    // 实际超采样落点（细线是否被漏采可直接观察）
    const pt = { x: 0, y: 0 };
    g.fillStyle = "#ffd166";
    const dotR = Math.max(1.2 / s, 0.6);
    for (let v = 0; v < 5; v++) {
      for (let u = 0; u < 5; u++) {
        mapPoint(actual, (u + 0.5) / 5, (v + 0.5) / 5, pt);
        g.beginPath();
        g.arc(pt.x, pt.y, dotR, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();
  }

  // 局部模式：节点手柄，仅绘制可见区域内的
  if (cal.mode.value === "local") {
    const field = cal.draftField.value;
    const viewLeft = -ox / s - gm.cellW;
    const viewTop = -oy / s - gm.cellH;
    const viewRight = viewLeft + w / s + gm.cellW * 2;
    const viewBottom = viewTop + h / s + gm.cellH * 2;
    const j0 = Math.max(0, Math.floor((viewLeft - gm.cropX) / gm.cellW));
    const j1 = Math.min(gm.cols, Math.ceil((viewRight - gm.cropX) / gm.cellW));
    const i0 = Math.max(0, Math.floor((viewTop - gm.cropY) / gm.cellH));
    const i1 = Math.min(gm.rows, Math.ceil((viewBottom - gm.cropY) / gm.cellH));
    g.save();
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const p = { x: 0, y: 0 };
        if (field) {
          const k = nodeIndex(gm, i, j);
          p.x = gm.cropX + j * gm.cellW + field[k]!;
          p.y = gm.cropY + i * gm.cellH + field[k + 1]!;
        } else {
          p.x = gm.cropX + j * gm.cellW;
          p.y = gm.cropY + i * gm.cellH;
        }
        const screenR = 4.5;
        g.fillStyle = "rgba(214,237,158,0.9)";
        g.strokeStyle = "rgba(20,26,16,0.9)";
        g.lineWidth = 1.5 / s;
        g.beginPath();
        g.arc(p.x, p.y, screenR / s, 0, Math.PI * 2);
        g.fill();
        g.stroke();
      }
    }
    g.restore();
  }

  // 坐标标签
  if (sel != null && selCy >= 0) {
    const actual = cornersFor(selCy, selCx, scratch);
    const lp = toScreen(actual[0]!.x, actual[0]!.y);
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.font = "11px 'DM Mono', monospace";
    g.fillStyle = "rgba(214,237,158,0.95)";
    g.fillText(`格 [${selCy},${selCx}]`, lp.x + 8, Math.max(14, lp.y - 8));
    g.restore();
  }
}

function hitTestNode(p: { x: number; y: number }) {
  if (cal.mode.value !== "local") return null;
  const gm = geo.value;
  const { i, j } = nearestNode(gm, p);
  const field = cal.draftField.value;
  const k = nodeIndex(gm, i, j);
  const nx = gm.cropX + j * gm.cellW + (field?.[k] ?? 0);
  const ny = gm.cropY + i * gm.cellH + (field?.[k + 1] ?? 0);
  const tol = 10 / scale.value;
  if (Math.hypot(p.x - nx, p.y - ny) <= tol) return { i, j, nx, ny };
  return null;
}

function onPointerDown(e: PointerEvent) {
  if (!canvasEl.value || geometryError.value) return;
  const el = canvasEl.value;
  el.setPointerCapture(e.pointerId);
  const p = toImage(e.clientX, e.clientY);

  // 局部模式优先抓取节点手柄
  const node = hitTestNode(p);
  if (node) {
    drag = {
      kind: "node",
      i: node.i,
      j: node.j,
      grabDx: p.x - node.nx,
      grabDy: p.y - node.ny,
    };
    return;
  }

  // 全局模式：在采样区内按下后，移动超过阈值才进入平移，保留点选能力
  const gm = geo.value;
  if (
    cal.mode.value === "global" &&
    p.x >= gm.cropX &&
    p.x <= gm.cropX + gm.cropW &&
    p.y >= gm.cropY &&
    p.y <= gm.cropY + gm.cropH
  ) {
    drag = {
      kind: "global-pending",
      startImgX: p.x,
      startImgY: p.y,
      baseDx: cal.dx.value,
      baseDy: cal.dy.value,
    };
    return;
  }

  // 其余情况：空白处平移视图（不改变任何采样参数）
  drag = {
    kind: "pan",
    startX: e.clientX,
    startY: e.clientY,
    ox: offset.value.x,
    oy: offset.value.y,
  };
}

function onPointerMove(e: PointerEvent) {
  if (!drag) {
    if (canvasEl.value) {
      const p = toImage(e.clientX, e.clientY);
      canvasEl.value.style.cursor = hitTestNode(p)
        ? "grab"
        : cal.mode.value === "global"
          ? "crosshair"
          : "default";
    }
    return;
  }
  const p = toImage(e.clientX, e.clientY);
  if (drag.kind === "pan") {
    offset.value = {
      x: drag.ox + (e.clientX - drag.startX),
      y: drag.oy + (e.clientY - drag.startY),
    };
  } else if (drag.kind === "global-pending") {
    const d = drag;
    if (
      Math.hypot(p.x - d.startImgX, p.y - d.startImgY) > DRAG_THRESHOLD
    ) {
      // 超过阈值才真正开始平移，阈值内的抬起按点选处理
      drag = {
        kind: "global",
        startImgX: d.startImgX,
        startImgY: d.startImgY,
        baseDx: d.baseDx,
        baseDy: d.baseDy,
      };
    }
    if (drag.kind === "global") {
      cal.setGlobal(
        drag.baseDx + (p.x - drag.startImgX),
        drag.baseDy + (p.y - drag.startImgY),
      );
    }
  } else if (drag.kind === "global") {
    cal.setGlobal(
      drag.baseDx + (p.x - drag.startImgX),
      drag.baseDy + (p.y - drag.startImgY),
    );
  } else {
    const gm = geo.value;
    const nominalX = gm.cropX + drag.j * gm.cellW;
    const nominalY = gm.cropY + drag.i * gm.cellH;
    cal.moveNode(
      drag.i,
      drag.j,
      p.x - drag.grabDx - nominalX,
      p.y - drag.grabDy - nominalY,
    );
  }
  scheduleDraw();
}

function onPointerUp(e: PointerEvent) {
  if (!drag) return;
  const wasClick =
    (drag.kind === "pan" &&
      Math.abs(e.clientX - drag.startX) < 4 &&
      Math.abs(e.clientY - drag.startY) < 4) ||
    drag.kind === "global-pending";
  if (wasClick) {
    const p = toImage(e.clientX, e.clientY);
    const hit = cellAt(geo.value, p);
    if (hit) cal.select(hit.cy * geo.value.cols + hit.cx);
  }
  drag = null;
  scheduleDraw();
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  const el = canvasEl.value!;
  const b = el.getBoundingClientRect();
  const mx = e.clientX - b.left;
  const my = e.clientY - b.top;
  const imgX = (mx - offset.value.x) / scale.value;
  const imgY = (my - offset.value.y) / scale.value;
  const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
  scale.value = Math.max(0.05, Math.min(12, scale.value * factor));
  offset.value = {
    x: mx - imgX * scale.value,
    y: my - imgY * scale.value,
  };
  scheduleDraw();
}

function zoomBy(factor: number) {
  const el = wrap.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const mx = rect.width / 2;
  const my = rect.height / 2;
  const imgX = (mx - offset.value.x) / scale.value;
  const imgY = (my - offset.value.y) / scale.value;
  scale.value = Math.max(0.05, Math.min(12, scale.value * factor));
  offset.value = { x: mx - imgX * scale.value, y: my - imgY * scale.value };
  scheduleDraw();
}

defineExpose({ fit, zoomBy, redraw: scheduleDraw });

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  fit();
  scheduleDraw();
  resizeObserver = new ResizeObserver(() => scheduleDraw());
  if (wrap.value) resizeObserver.observe(wrap.value);
  // 显式非 passive，才能 preventDefault 阻止页面滚动（缩放仅改变检查显示）
  canvasEl.value?.addEventListener("wheel", onWheel, { passive: false });
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  canvasEl.value?.removeEventListener("wheel", onWheel);
  if (raf) cancelAnimationFrame(raf);
});

watch(
  () => doc.asset,
  () => requestAnimationFrame(fit),
);
watch(
  () => cal.inspecting.value,
  (v) => {
    if (v) requestAnimationFrame(() => {
      fit();
      scheduleDraw();
    });
  },
);
watch(
  [redrawVersion, () => doc.settings.background, scale, offset],
  scheduleDraw,
);
</script>

<template>
  <div ref="wrap" class="inspect-stage">
    <canvas
      ref="canvasEl"
      aria-label="采样检查画布"
      class="inspect-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="drag = null"
    />
    <div v-if="geometryError" class="inspect-error" role="alert">
      {{ geometryError }}
    </div>
  </div>
</template>
