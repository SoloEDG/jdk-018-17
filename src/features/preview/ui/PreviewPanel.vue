<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Code2, Scan, Minus, Plus, Crosshair, Maximize2, X } from "lucide-vue-next";
import { usePreview } from "../model/usePreview";
import { useCalibration } from "../../calibration";
import { gridRows } from "../lib/rows";
import ArtCanvas from "./ArtCanvas.vue";
import { InspectStage, CalibrationPanel } from "../../calibration";

const p = usePreview();
const cal = useCalibration();
const stageRef = ref<InstanceType<typeof InspectStage>>();
const text = computed(() =>
  p.doc.grid ? gridRows(p.doc.grid).join("\n") : "",
);

// 取消校准或更换原图会把 inspecting 置回 false，检查 tab 同步退出，
// 避免在已失效的检查视图里继续操作
watch(
  () => cal.inspecting.value,
  (v) => {
    if (!v && p.mode.value === "inspect") p.mode.value = "art";
  },
);

function enterInspect() {
  p.mode.value = "inspect";
  cal.open();
}
function leaveInspect() {
  // 退出检查：丢弃草稿（取消语义），已确认校准与网格不受影响
  cal.close();
  p.mode.value = "art";
}
function stageZoom(f: number) {
  stageRef.value?.zoomBy(f);
}
function stageFit() {
  stageRef.value?.fit();
}
</script>

<template>
  <main class="workspace">
    <div class="preview-toolbar">
      <div class="tabs">
        <button
          :class="{ active: p.mode.value === 'art' }"
          @click="p.mode.value = 'art'"
        >
          <Scan :size="14" /> 字符预览</button
        ><button
          :class="{ active: p.mode.value === 'text' }"
          @click="p.mode.value = 'text'"
        >
          <Code2 :size="14" /> 纯文本</button
        ><button
          :class="{ active: p.mode.value === 'inspect' }"
          :disabled="!p.doc.asset"
          @click="enterInspect"
        >
          <Crosshair :size="14" /> 采样检查
        </button>
      </div>
      <label v-if="p.mode.value !== 'inspect'" class="color-toggle"
        ><span class="color-dot" /> 彩色<input
          aria-label="彩色预览"
          type="checkbox"
          v-model="p.doc.settings.color"
      /></label>
    </div>

    <!-- 检查模式：原图采样空间，缩放/平移/高分屏仅作用于显示 -->
    <template v-if="p.mode.value === 'inspect' && p.doc.asset">
      <div class="inspect-layout">
        <div class="art-stage inspect-stage-wrap">
          <div class="stage-label">
            ORIGINAL IMAGE / SOURCE SAMPLING SPACE <span>●</span>
          </div>
          <InspectStage ref="stageRef" />
          <div class="inspect-zoom">
            <button aria-label="缩小" @click="stageZoom(1 / 1.25)">
              <Minus :size="13" />
            </button>
            <button aria-label="适应窗口" @click="stageFit">
              <Maximize2 :size="13" />
            </button>
            <button aria-label="放大" @click="stageZoom(1.25)">
              <Plus :size="13" />
            </button>
          </div>
          <button
            class="inspect-exit"
            aria-label="退出检查"
            @click="leaveInspect"
          >
            <X :size="14" /> 退出检查
          </button>
          <div class="stage-corner inspect-corner">
            校准：{{
              p.doc.grid?.calibrationMode === "global"
                ? "全局偏移"
                : p.doc.grid?.calibrationMode === "local"
                  ? "局部平滑"
                  : "未校准"
            }}
          </div>
        </div>
        <CalibrationPanel />
      </div>
    </template>

    <template v-else>
      <div class="art-stage">
        <div class="stage-label">OUTPUT / LIVE RENDER <span>●</span></div>
        <div class="art-scroll">
          <ArtCanvas
            v-if="p.doc.grid && p.mode.value === 'art'"
            :grid="p.doc.grid"
            :color="p.doc.settings.color"
            :background="p.doc.settings.background"
            :zoom="p.zoom.value"
          />
          <pre
            v-else-if="p.doc.grid"
            data-testid="text-preview"
            :style="{
              fontSize: (14 * p.zoom.value) / 100 + 'px',
              lineHeight: (16 * p.zoom.value) / 100 + 'px',
            }"
            >{{ text }}</pre
          >
          <span v-else>正在准备字符画…</span>
        </div>
        <div class="stage-corner">
          {{ p.doc.grid?.columns }} COL × {{ p.doc.grid?.rows }} ROW
        </div>
      </div>
      <div class="preview-bottom">
        <span class="mono"
          ><i class="status-dot" />{{
            p.busy.value
              ? "生成中"
              : p.doc.grid?.revision === p.doc.revision
                ? "已同步"
                : "待重新生成"
          }}
          <span class="muted">/ {{ p.count.value }} 个字符</span>
          <em
            v-if="p.doc.grid?.calibrationMode"
            class="cal-badge"
            :class="p.doc.grid.calibrationMode"
          >
            {{
              p.doc.grid.calibrationMode === "global"
                ? "全局偏移校准"
                : "局部平滑校准"
            }}
          </em></span
        >
        <div class="zoom">
          <button
            aria-label="缩小"
            @click="p.zoom.value = Math.max(25, p.zoom.value - 25)"
          >
            <Minus :size="14" /></button
          ><span>{{ p.zoom.value }}%</span
          ><button
            aria-label="放大"
            @click="p.zoom.value = Math.min(200, p.zoom.value + 25)"
          >
            <Plus :size="14" />
          </button>
        </div>
      </div>
      <div class="workspace-note">
        <span>从像素，到字符。</span
        ><small>每一个符号，都是光影的另一种表达。</small
        ><span class="note-symbol">{ Aa }</span>
      </div>
    </template>
  </main>
</template>
