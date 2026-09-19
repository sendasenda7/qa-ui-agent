import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { readFile, mkdir, writeFile } from "fs/promises";

// Au-delà de ce pourcentage de pixels différents, on considère que c'est une
// vraie régression visuelle et pas juste du bruit de rendu (antialiasing, etc.).
const REGRESSION_THRESHOLD_PERCENT = 0.5;

async function loadPng(path) {
  const buffer = await readFile(path);
  return PNG.sync.read(buffer);
}

/**
 * Compare deux screenshots pixel par pixel. Si les dimensions diffèrent,
 * on ne peut pas comparer directement (ça arrive si la page a changé de mise
 * en page) — on le signale plutôt que de planter ou de mentir sur un résultat.
 */
async function compareScreenshots(pathA, pathB, diffOutputPath) {
  const imgA = await loadPng(pathA);
  const imgB = await loadPng(pathB);

  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return {
      comparable: false,
      reason: `Dimensions différentes : ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
      diffPercent: null,
      diffImagePath: null,
    };
  }

  const { width, height } = imgA;
  const diff = new PNG({ width, height });

  const diffPixelCount = pixelmatch(imgA.data, imgB.data, diff.data, width, height, {
    threshold: 0.1,
  });

  const totalPixels = width * height;
  const diffPercent = (diffPixelCount / totalPixels) * 100;

  await writeFile(diffOutputPath, PNG.sync.write(diff));

  return {
    comparable: true,
    reason: null,
    diffPixelCount,
    totalPixels,
    diffPercent: Number(diffPercent.toFixed(3)),
    diffImagePath: diffOutputPath,
    isRegression: diffPercent > REGRESSION_THRESHOLD_PERCENT,
  };
}

/**
 * Compare deux runs sauvegardés (voir test-run.js) étape par étape, en supposant
 * qu'ils exécutent le même scénario (même nombre d'étapes, dans le même ordre).
 */
export async function compareRuns(runA, runB, outputDir = "diff-screenshots") {
  await mkdir(outputDir, { recursive: true });

  const stepCount = Math.min(runA.runResult.results.length, runB.runResult.results.length);
  const stepDiffs = [];

  for (let i = 0; i < stepCount; i++) {
    const stepA = runA.runResult.results[i];
    const stepB = runB.runResult.results[i];

    if (!stepA.screenshot || !stepB.screenshot) {
      stepDiffs.push({
        index: i,
        description: stepB.description,
        comparable: false,
        reason: "Screenshot manquant pour au moins un des deux runs (étape probablement échouée).",
      });
      continue;
    }

    const diffOutputPath = `${outputDir}/step${i}-${runA.runResult.runId}-vs-${runB.runResult.runId}.png`;
    const result = await compareScreenshots(stepA.screenshot, stepB.screenshot, diffOutputPath);

    stepDiffs.push({
      index: i,
      description: stepB.description,
      ...result,
    });
  }

  const regressions = stepDiffs.filter((s) => s.isRegression);

  return {
    runIdA: runA.runResult.runId,
    runIdB: runB.runResult.runId,
    stepCount,
    regressionCount: regressions.length,
    hasRegressions: regressions.length > 0,
    steps: stepDiffs,
  };
}
