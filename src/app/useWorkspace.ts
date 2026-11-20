import { reactive, ref, provide, watch } from "vue";
import { createDocument } from "../shared/defaults";
import { studioKey } from "../shared/context";
import { generate } from "../features/mapping";
import {
  calibrationKey,
  createCalibrationStore,
} from "../features/calibration/lib/state";
import { releaseSourceBuffers } from "../features/calibration/lib/sampler";

export function useWorkspace() {
  const doc = reactive(createDocument());
  const busy = ref(false),
    notice = ref("所有处理均在你的浏览器中完成");
  let timer: ReturnType<typeof setTimeout>;
  function invalidate() {
    doc.revision++;
    busy.value = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        doc.grid = generate(doc);
      } catch (e) {
        notice.value = e instanceof Error ? e.message : "生成失败";
      } finally {
        busy.value = false;
      }
    }, 60);
  }

  // 先构造 studio 上下文并 provide，再把同一引用交给校准 store
  const studio = { doc, busy, notice, invalidate };
  const calibration = createCalibrationStore(studio);

  // 背景色只影响填充采样，不改变几何：旧校准仍然有效，仅重新生成
  watch(() => doc.settings.background, invalidate);

  // 密度 / 裁剪变化：覆盖范围必须重新推导，旧格索引不得直接搬运
  watch(
    () => [
      doc.settings.columns,
      doc.crop.x,
      doc.crop.y,
      doc.crop.width,
      doc.crop.height,
    ],
    () => calibration.handleConfigChange(),
  );

  // 更换原图：释放像素缓冲并清空全部校准
  watch(
    () => doc.asset,
    (asset, old) => {
      if (asset !== old) {
        releaseSourceBuffers();
        calibration.resetAll();
      }
    },
  );

  provide(studioKey, studio);
  provide(calibrationKey, calibration);
  return { doc, busy, notice };
}
