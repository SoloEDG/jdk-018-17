/**
 * 采样几何纯逻辑校验（不依赖 DOM / Vue）。
 * 运行：node --experimental-strip-types scripts/check-coverage.ts
 *
 * coverage.ts 的运行时依赖只有 gridSize，这里在系统临时目录生成
 * 一份等价源码并注入桩模块，保证被测函数与生产代码同源。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "coverage-check-"));
writeFileSync(join(dir, "document.ts"), "export {};\n");
writeFileSync(
  join(dir, "gridSize.ts"),
  "export function gridSize(width:number,height:number,columns:number){" +
    "const n=Math.round(Math.max(30,Math.min(220,columns)));" +
    "const rows=Math.max(1,Math.round((height/width)*n*0.5));" +
    "return {columns:n,rows};}\n",
);
let source = readFileSync(
  new URL("../src/features/calibration/lib/coverage.ts", import.meta.url),
  "utf8",
);
source = source
  .replace(
    /from\s+"[^"]*shared\/document"/,
    `from "${pathToFileURL(join(dir, "document.ts")).href}"`,
  )
  .replace(
    /from\s+"[^"]*gridSize"/,
    `from "${pathToFileURL(join(dir, "gridSize.ts")).href}"`,
  );
const coveragePath = join(dir, "coverage.ts");
writeFileSync(coveragePath, source);
const {
  cellCorners,
  globalBounds,
  mapPoint,
  quadArea,
  cellWeight,
  validateLocal,
  revalidateAround,
  createField,
  nodeIndex,
  nearestNode,
  pointInQuad,
  cellAt,
} = await import(pathToFileURL(coveragePath).href);

const asset = { width: 100, height: 80 };
const geo = {
  cols: 10,
  rows: 8,
  cropX: 0,
  cropY: 0,
  cropW: 100,
  cropH: 80,
  cellW: 10,
  cellH: 10,
};

// 1. 名义四角与面积、权重
const corners = [{}, {}, {}, {}];
cellCorners(geo, null, 0, 0, corners);
assert.deepStrictEqual(
  corners.map((q) => [q.x, q.y]),
  [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ],
);
assert.equal(quadArea(corners), 100);
assert.equal(cellWeight(geo, corners), 1);

// 2. 双线性映射：中心 = 四角平均，角点恒等
const mid = mapPoint(corners, 0.5, 0.5, { x: 0, y: 0 });
assert.equal(mid.x, 5);
assert.equal(mid.y, 5);
assert.deepStrictEqual(mapPoint(corners, 0, 0, { x: 0, y: 0 }), {
  x: 0,
  y: 0,
});
assert.deepStrictEqual(mapPoint(corners, 1, 1, { x: 0, y: 0 }), {
  x: 10,
  y: 10,
});

// 3. 零场校验：无折叠、无越界
let r = validateLocal(geo, asset, createField(geo));
assert.equal(r.count, 0, "零场应全部有效");

// 4. 制造折叠：让单元 (0,0) 的两个节点交叉 -> 雅可比行列式变负
const fold = createField(geo);
fold[nodeIndex(geo, 0, 1)] = -15; // (0,1) 向左越过 (0,0)
r = validateLocal(geo, asset, fold);
assert.ok(r.foldCount >= 1, "应检出折叠");
assert.equal(r.invalid[0], 1, "单元 (0,0) 应标记无效");

// 5. 越界：把右下节点拖出原图
const oob = createField(geo);
oob[nodeIndex(geo, 8, 10)] = 50;
r = validateLocal(geo, asset, oob);
assert.ok(r.boundsCount >= 1, "应检出越界");

// 6. 全局偏移边界
assert.deepStrictEqual(globalBounds(asset, geo, 0, 0), {
  ok: true,
  dxOk: true,
  dyOk: true,
});
assert.equal(globalBounds(asset, geo, 5, 0).ok, false);
assert.equal(globalBounds(asset, geo, -1, 0).ok, false);
assert.equal(globalBounds(asset, geo, 0, 1).ok, false);

// 7. 点在四边形内判定
assert.equal(pointInQuad({ x: 5, y: 5 }, corners), true);
assert.equal(pointInQuad({ x: 50, y: 50 }, corners), false);

// 8. 最近节点检索与边界钳制
assert.deepStrictEqual(nearestNode(geo, { x: 24, y: 36 }), { i: 4, j: 2 });
assert.deepStrictEqual(nearestNode(geo, { x: 9999, y: 9999 }), {
  i: 8,
  j: 10,
});

// 9. cellAt 与越界返回 null
assert.deepStrictEqual(cellAt(geo, { x: 25, y: 45 }), { cx: 2, cy: 4 });
assert.equal(cellAt(geo, { x: -1, y: 0 }), null);

// 10. 整体平移不产生折叠，但右/下边缘必然越界
const shift = createField(geo);
for (let i = 0; i < shift.length; i += 2) {
  shift[i] = 2;
  shift[i + 1] = 1;
}
r = validateLocal(geo, asset, shift);
assert.equal(r.foldCount, 0, "整体平移不应折叠");
assert.ok(r.boundsCount > 0, "右/下边缘应越界");

// 11. 权重随拉伸变化：单元宽度拉大一倍 -> 权重减半
const wide = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 10 },
  { x: 0, y: 10 },
];
assert.equal(quadArea(wide), 200);
assert.equal(cellWeight(geo, wide), 0.5);

// 12. 增量校验与全量校验结果一致
const inc = createField(geo);
let full = validateLocal(geo, asset, inc);
let partial = revalidateAround(geo, asset, inc, validateLocal(geo, asset, inc), 0, 1);
assert.equal(partial.count, full.count);
assert.equal(partial.foldCount, full.foldCount);
assert.equal(partial.boundsCount, full.boundsCount);

// 制造折叠后只增量重算受影响节点周围，计数必须与全量相同
inc[nodeIndex(geo, 0, 1)] = -15;
full = validateLocal(geo, asset, inc);
partial = revalidateAround(
  geo,
  asset,
  inc,
  validateLocal(geo, asset, createField(geo)),
  0,
  1,
);
assert.equal(partial.foldCount, full.foldCount);
assert.equal(partial.count, full.count);
for (let k = 0; k < full.invalid.length; k++) {
  assert.equal(partial.invalid[k], full.invalid[k], `invalid[${k}] 不一致`);
}

// 边界节点只相邻两个单元，不能越界扫描
const edge = createField(geo);
edge[nodeIndex(geo, 8, 10)] = -8;
full = validateLocal(geo, asset, edge);
partial = revalidateAround(
  geo,
  asset,
  edge,
  validateLocal(geo, asset, createField(geo)),
  8,
  10,
);
assert.equal(partial.count, full.count);
assert.equal(partial.boundsCount, full.boundsCount);

console.log("coverage 几何校验全部通过 ✓");
