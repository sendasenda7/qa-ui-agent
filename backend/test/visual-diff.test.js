import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compareScreenshots, compareRuns } from "../src/visual-diff.js";

/** Construit un PNG uni de test, éventuellement avec un bloc de pixels différent. */
function makePng({ width = 20, height = 20, color = [10, 10, 10], patch = null }) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) << 2;
      const inPatch =
        patch && x >= patch.x && x < patch.x + patch.w && y >= patch.y && y < patch.y + patch.h;
      const [r, g, b] = inPatch ? patch.color : color;
      png.data[idx] = r;
      png.data[idx + 1] = g;
      png.data[idx + 2] = b;
      png.data[idx + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "visual-diff-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("deux captures identiques donnent un diff de 0% et pas de régression", async () => {
  await withTempDir(async (dir) => {
    const pathA = path.join(dir, "a.png");
    const pathB = path.join(dir, "b.png");
    const diffPath = path.join(dir, "diff.png");
    const png = makePng({});
    await writeFile(pathA, png);
    await writeFile(pathB, png);

    const result = await compareScreenshots(pathA, pathB, diffPath);

    assert.equal(result.comparable, true);
    assert.equal(result.diffPercent, 0);
    assert.equal(result.isRegression, false);
  });
});

test("un gros changement de pixels dépasse le seuil et compte comme régression", async () => {
  await withTempDir(async (dir) => {
    const pathA = path.join(dir, "a.png");
    const pathB = path.join(dir, "b.png");
    const diffPath = path.join(dir, "diff.png");
    await writeFile(pathA, makePng({}));
    // La moitié de l'image change de couleur : largement au-dessus du seuil de 0.5%.
    await writeFile(
      pathB,
      makePng({ patch: { x: 0, y: 0, w: 20, h: 10, color: [250, 250, 250] } })
    );

    const result = await compareScreenshots(pathA, pathB, diffPath);

    assert.equal(result.comparable, true);
    assert.ok(result.diffPercent > 0.5, `diffPercent attendu > 0.5, obtenu ${result.diffPercent}`);
    assert.equal(result.isRegression, true);
  });
});

test("des dimensions différentes sont signalées comme non comparables, sans planter", async () => {
  await withTempDir(async (dir) => {
    const pathA = path.join(dir, "a.png");
    const pathB = path.join(dir, "b.png");
    const diffPath = path.join(dir, "diff.png");
    await writeFile(pathA, makePng({ width: 20, height: 20 }));
    await writeFile(pathB, makePng({ width: 30, height: 20 }));

    const result = await compareScreenshots(pathA, pathB, diffPath);

    assert.equal(result.comparable, false);
    assert.match(result.reason, /Dimensions différentes/);
    assert.equal(result.diffPercent, null);
  });
});

test("compareRuns signale un avertissement quand les deux runs n'ont pas le même nombre d'étapes", async () => {
  await withTempDir(async (dir) => {
    const pathA = path.join(dir, "a.png");
    const pathB = path.join(dir, "b.png");
    await writeFile(pathA, makePng({}));
    await writeFile(pathB, makePng({}));

    const runA = {
      runResult: {
        runId: 1,
        results: [
          { description: "étape 1", screenshot: pathA },
          { description: "étape 2", screenshot: pathA },
        ],
      },
    };
    const runB = {
      runResult: {
        runId: 2,
        results: [{ description: "étape 1", screenshot: pathB }],
      },
    };

    const report = await compareRuns(runA, runB, dir);

    assert.equal(report.scenarioLengthMismatch, true);
    assert.equal(report.stepCount, 1);
    assert.ok(report.warnings.some((w) => /pas le même nombre d'étapes/.test(w)));
  });
});

test("compareRuns signale un avertissement quand les descriptions diffèrent à une même étape", async () => {
  await withTempDir(async (dir) => {
    const pathA = path.join(dir, "a.png");
    const pathB = path.join(dir, "b.png");
    await writeFile(pathA, makePng({}));
    await writeFile(pathB, makePng({}));

    const runA = {
      runResult: {
        runId: 1,
        results: [{ description: "Ouvrir la page de connexion", screenshot: pathA }],
      },
    };
    const runB = {
      runResult: {
        runId: 2,
        results: [{ description: "Vérifier le bouton Retour", screenshot: pathB }],
      },
    };

    const report = await compareRuns(runA, runB, dir);

    assert.equal(report.scenarioLengthMismatch, false);
    assert.ok(report.warnings.some((w) => /descriptions diffèrent/.test(w)));
  });
});