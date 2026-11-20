export { default as InspectStage } from "./ui/InspectStage.vue";
export { default as CalibrationPanel } from "./ui/CalibrationPanel.vue";
export {
  calibrationKey,
  createCalibrationStore,
  useCalibration,
  type Calibration,
  type CalibrationMode,
  type CalibrationStore,
} from "./lib/state";
export {
  configSignature,
  gridGeometry,
  validateLocal,
  revalidateAround,
  globalBounds,
  type GridGeometry,
  type ValidationResult,
} from "./lib/coverage";
export {
  sampleCell,
  sampleNominalCell,
  sampleGrid,
  toHex,
  releaseSourceBuffers,
} from "./lib/sampler";
