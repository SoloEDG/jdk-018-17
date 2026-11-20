import { inject, ref, shallowRef, type InjectionKey, type Ref } from "vue";
import type { StudioContext } from "../../../shared/context";
import {
  type GridGeometry,
  type ValidationResult,
  configSignature,
  createField,
  fieldLength,
  globalBounds,
  gridGeometry,
  revalidateAround,
  validateLocal,
} from "./coverage";

export type CalibrationMode = "global" | "local";

/**
 * 已确认的采样校准。
 * 全部位移均在原图像素空间；field 只存节点位移（不含绝对坐标），
 * 因此密度/裁剪变化后签名必然失配，不会被错误地搬到新格网上。
 */
export interface Calibration {
  mode: CalibrationMode;
  /** 全局平移（原图像素） */
  dx: number;
  dy: number;
  /** 局部平滑场：每个节点一个 (dx,dy)，长度 2*(rows+1)*(cols+1) */
  field: Float32Array;
  /** 确认时的采样配置指纹 */
  signature: string;
  confirmedAt: number;
}

export interface CalibrationStore {
  inspecting: Ref<boolean>;
  mode: Ref<CalibrationMode>;
  dx: Ref<number>;
  dy: Ref<number>;
  draftField: Ref<Float32Array | null>;
  draftVersion: Ref<number>;
  selected: Ref<number | null>;
  confirmed: Ref<Calibration | null>;
  /** 当前局部草稿的折叠/越界校验结果（增量维护，画布与面板共享） */
  validation: Ref<ValidationResult | null>;
  open: () => void;
  close: () => void;
  setMode: (mode: CalibrationMode) => void;
  setGlobal: (dx: number, dy: number) => void;
  nudgeGlobal: (ddx: number, ddy: number) => void;
  resetDraft: () => void;
  moveNode: (i: number, j: number, ndx: number, ndy: number) => void;
  select: (index: number | null) => void;
  confirm: () => boolean;
  cancel: () => void;
  handleConfigChange: () => void;
  resetAll: () => void;
  geometry: () => GridGeometry;
  signature: () => string;
}

export const calibrationKey: InjectionKey<CalibrationStore> =
  Symbol("calibration");

/** 组件侧入口：注入由 useWorkspace 创建的单例 store。 */
export function useCalibration(): CalibrationStore {
  const store = inject(calibrationKey);
  if (!store) throw new Error("Missing calibration store");
  return store;
}

/**
 * 工厂由 useWorkspace 调用并显式传入 studio 上下文，
 * 避免在 provide 之前于构造期触发 inject。
 */
export function createCalibrationStore(studio: StudioContext): CalibrationStore {
  const { doc, notice, invalidate } = studio;

  const inspecting = ref(false);
  const mode = ref<CalibrationMode>("global");
  const dx = ref(0);
  const dy = ref(0);
  const draftField = shallowRef<Float32Array | null>(null);
  const draftVersion = ref(0);
  const selected = ref<number | null>(null);
  const confirmed = shallowRef<Calibration | null>(null);
  const validation = shallowRef<ValidationResult | null>(null);

  function geometry(): GridGeometry {
    return gridGeometry(doc);
  }
  function signature(): string {
    return configSignature(doc);
  }

  function touch(): void {
    draftVersion.value++;
  }

  /** 按当前草稿场重建校验结果（切模式、重置、从已确认场恢复时调用）。 */
  function rebuildValidation(): void {
    const field = draftField.value;
    if (mode.value !== "local" || !field || !doc.asset) {
      validation.value = null;
      return;
    }
    const geo = geometry();
    if (field.length !== fieldLength(geo)) {
      validation.value = null;
      return;
    }
    validation.value = validateLocal(geo, doc.asset, field);
  }

  function open(): void {
    inspecting.value = true;
    if (confirmed.value && confirmed.value.signature === signature()) {
      // 从已确认校准继续编辑：复制一份草稿
      mode.value = confirmed.value.mode;
      dx.value = confirmed.value.dx;
      dy.value = confirmed.value.dy;
      draftField.value =
        confirmed.value.mode === "local"
          ? confirmed.value.field.slice()
          : null;
    } else if (confirmed.value?.mode === "global") {
      // 配置变化后保留旧的全局像素偏移供复核，但签名失配期间不会生效
      mode.value = "global";
      dx.value = confirmed.value.dx;
      dy.value = confirmed.value.dy;
      draftField.value = null;
      notice.value = "裁剪或密度已变化，请复核偏移后重新确认";
    } else {
      resetDraft();
    }
    rebuildValidation();
    touch();
  }

  function close(): void {
    inspecting.value = false;
    selected.value = null;
    // 关闭检查仅丢弃草稿，已确认校准与现有网格不受影响
  }

  function setMode(next: CalibrationMode): void {
    if (mode.value === next) return;
    mode.value = next;
    if (next === "local") {
      if (!draftField.value)
        draftField.value = new Float32Array(createField(geometry()));
      if (
        confirmed.value?.mode === "local" &&
        confirmed.value.signature === signature()
      ) {
        dx.value = confirmed.value.dx;
        dy.value = confirmed.value.dy;
        draftField.value = confirmed.value.field.slice();
      }
    }
    rebuildValidation();
    touch();
  }

  function setGlobal(nextDx: number, nextDy: number): void {
    dx.value = nextDx;
    dy.value = nextDy;
    touch();
  }

  function nudgeGlobal(ddx: number, ddy: number): void {
    dx.value += ddx;
    dy.value += ddy;
    touch();
  }

  function resetDraft(): void {
    dx.value = 0;
    dy.value = 0;
    draftField.value =
      mode.value === "local"
        ? new Float32Array(createField(geometry()))
        : null;
    rebuildValidation();
    touch();
  }

  function moveNode(i: number, j: number, ndx: number, ndy: number): void {
    const geo = geometry();
    let field = draftField.value;
    if (!field || field.length !== fieldLength(geo)) {
      field = new Float32Array(fieldLength(geo));
      draftField.value = field;
    }
    const k = 2 * (i * (geo.cols + 1) + j);
    field[k] = ndx;
    field[k + 1] = ndy;
    // 增量校验：仅重算该节点相邻至多 4 格，O(1)
    if (doc.asset) {
      if (
        !validation.value ||
        validation.value.invalid.length !== geo.rows * geo.cols
      ) {
        validation.value = validateLocal(geo, doc.asset, field);
      } else {
        validation.value = revalidateAround(
          geo,
          doc.asset,
          field,
          validation.value,
          i,
          j,
        );
      }
    }
    touch();
  }

  function select(index: number | null): void {
    selected.value = index;
  }

  function confirm(): boolean {
    const sig = signature();
    const geo = geometry();
    if (mode.value === "local") {
      const field = draftField.value;
      if (!field) {
        notice.value = "局部校准为空，请先在原图上拉动节点";
        return false;
      }
      if (field.length !== fieldLength(geo)) {
        notice.value = "校准场与当前格网不匹配，需重新推导覆盖范围";
        return false;
      }
      if (!doc.asset) return false;
      // 优先复用增量维护的结果；必要时兜底全量重算
      const result =
        validation.value &&
        validation.value.invalid.length === geo.rows * geo.cols
          ? validation.value
          : validateLocal(geo, doc.asset, field);
      if (result.count > 0) {
        notice.value = `存在 ${result.count} 个无效采样范围（折叠 ${result.foldCount} · 越界 ${result.boundsCount}），禁止确认`;
        return false;
      }
    } else if (doc.asset) {
      const check = globalBounds(doc.asset, geo, dx.value, dy.value);
      if (!check.ok) {
        notice.value = "全局偏移使采样区越出原图边界，禁止确认";
        return false;
      }
    }
    confirmed.value = {
      mode: mode.value,
      dx: dx.value,
      dy: dy.value,
      field:
        mode.value === "local" && draftField.value
          ? draftField.value.slice()
          : new Float32Array(0),
      signature: sig,
      confirmedAt: Date.now(),
    };
    // 正式生效：写入文档，之后所有格统一按此校准重新采样
    doc.calibration = confirmed.value;
    notice.value =
      mode.value === "global"
        ? "全局偏移校准已确认，所有格统一重新采样"
        : "局部平滑校准已确认，所有格统一重新采样";
    invalidate();
    return true;
  }

  function cancel(): void {
    // 取消：草稿丢弃，已确认校准与旧网格原样保留
    if (confirmed.value && confirmed.value.signature === signature()) {
      mode.value = confirmed.value.mode;
      dx.value = confirmed.value.dx;
      dy.value = confirmed.value.dy;
      draftField.value =
        confirmed.value.mode === "local"
          ? confirmed.value.field.slice()
          : null;
    } else {
      resetDraft();
    }
    rebuildValidation();
    selected.value = null;
    inspecting.value = false;
    notice.value = "已取消校准调整，保留原网格";
  }

  /**
   * 密度或裁剪变化后调用：重新推导覆盖范围。
   * 局部场与新格网无法逐节点对应，直接作废；全局平移保留数值但标记为待复核，
   * 签名失配期间 generate 不会使用任何旧校准，也不会用旧采样解释新字符。
   */
  function handleConfigChange(): void {
    const still =
      confirmed.value && confirmed.value.signature === signature();
    if (!still) {
      if (confirmed.value?.mode === "local") {
        // 局部场与新格网无法逐节点对应，连同文档中的生效校准一起作废
        confirmed.value = null;
        doc.calibration = null;
      }
      // 全局模式保留数值供复核，但签名已失配，generate 不会使用它
      draftField.value = null;
      validation.value = null;
      selected.value = null;
      if (inspecting.value) resetDraft();
    }
  }

  function resetAll(): void {
    confirmed.value = null;
    doc.calibration = null;
    draftField.value = null;
    validation.value = null;
    selected.value = null;
    dx.value = 0;
    dy.value = 0;
    mode.value = "global";
    inspecting.value = false;
    draftVersion.value++;
  }

  return {
    inspecting,
    mode,
    dx,
    dy,
    draftField,
    draftVersion,
    selected,
    confirmed,
    validation,
    open,
    close,
    setMode,
    setGlobal,
    nudgeGlobal,
    resetDraft,
    moveNode,
    select,
    confirm,
    cancel,
    handleConfigChange,
    resetAll,
    geometry,
    signature,
  };
}
