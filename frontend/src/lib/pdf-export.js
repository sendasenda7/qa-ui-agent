import { jsPDF } from "jspdf";
import { screenshotUrl } from "./api.js";

const MARGIN = 15;
const PAGE_WIDTH = 210; // A4 en mm
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const STATUS_LABELS = {
  passed: "Réussi",
  failed: "Échoué",
  error: "Erreur",
  running: "En cours",
};

/** Convertit une image servie par le backend en data URL, pour l'intégrer au PDF (jsPDF ne sait pas fetcher une URL lui-même). */
async function fetchImageAsDataUrl(relativePath) {
  const response = await fetch(screenshotUrl(relativePath));
  if (!response.ok) throw new Error(`Impossible de charger la capture (${response.status})`);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Génère et télécharge un PDF résumant un run : ticket, score de confiance,
 * avertissements réels, liste des étapes avec statut, et la dernière capture
 * d'écran comme aperçu visuel de l'état final de la page.
 */
export async function exportRunReportToPdf({ scenario, runResult, ticketUrl }) {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = MARGIN;

  function ensureSpace(neededMm) {
    if (y + neededMm > 297 - MARGIN) {
      doc.addPage();
      y = MARGIN;
    }
  }

  // En-tête
  doc.setFontSize(16);
  doc.setFont(undefined, "bold");
  doc.text("QA-UI Agent — Rapport d'exécution", MARGIN, y);
  y += 8;

  doc.setFontSize(10);
  doc.setFont(undefined, "normal");
  doc.text(`Run #${runResult.runId}`, MARGIN, y);
  y += 5;
  doc.text(`URL : ${runResult.url}`, MARGIN, y);
  y += 5;
  doc.text(
    `Démarré le ${new Date(runResult.startedAt).toLocaleString("fr-FR")} — Statut : ${
      STATUS_LABELS[runResult.status] ?? runResult.status
    }`,
    MARGIN,
    y
  );
  y += 5;
  doc.text(`Étapes : ${runResult.stepsPassed}/${runResult.stepsTotal} réussies`, MARGIN, y);
  y += 8;

  // Résumé du ticket + confiance
  doc.setFont(undefined, "bold");
  doc.text("Résumé du ticket", MARGIN, y);
  y += 5;
  doc.setFont(undefined, "normal");
  const summaryLines = doc.splitTextToSize(scenario.ticketSummary || "—", CONTENT_WIDTH);
  doc.text(summaryLines, MARGIN, y);
  y += summaryLines.length * 5 + 2;

  if (ticketUrl) {
    doc.setTextColor(40, 90, 200);
    doc.textWithLink("Voir le ticket →", MARGIN, y, { url: ticketUrl });
    doc.setTextColor(0, 0, 0);
    y += 6;
  }

  if (typeof scenario.confidence === "number") {
    doc.text(`Score de confiance du plan généré : ${scenario.confidence}%`, MARGIN, y);
    y += 6;
  }

  // Avertissements
  if (scenario.warnings?.length > 0) {
    ensureSpace(6 + scenario.warnings.length * 5);
    doc.setFont(undefined, "bold");
    doc.text("Avertissements", MARGIN, y);
    y += 5;
    doc.setFont(undefined, "normal");
    for (const w of scenario.warnings) {
      const lines = doc.splitTextToSize(`• ${w}`, CONTENT_WIDTH);
      ensureSpace(lines.length * 5);
      doc.text(lines, MARGIN, y);
      y += lines.length * 5;
    }
    y += 3;
  }

  // Étapes d'exécution
  ensureSpace(10);
  doc.setFont(undefined, "bold");
  doc.text("Étapes d'exécution", MARGIN, y);
  y += 6;
  doc.setFont(undefined, "normal");

  for (const step of runResult.results) {
    const lines = doc.splitTextToSize(
      `${step.index + 1}. [${STATUS_LABELS[step.status] ?? step.status}] ${step.description}`,
      CONTENT_WIDTH
    );
    ensureSpace(lines.length * 5 + (step.error ? 5 : 0));
    doc.text(lines, MARGIN, y);
    y += lines.length * 5;
    if (step.error) {
      const errorLines = doc.splitTextToSize(`   ↳ ${step.error}`, CONTENT_WIDTH);
      doc.setTextColor(180, 40, 40);
      doc.text(errorLines, MARGIN, y);
      doc.setTextColor(0, 0, 0);
      y += errorLines.length * 5;
    }
  }

  // Dernière capture d'écran (aperçu visuel de l'état final)
  const lastStepWithScreenshot = [...runResult.results].reverse().find((s) => s.screenshot);
  if (lastStepWithScreenshot) {
    try {
      const dataUrl = await fetchImageAsDataUrl(lastStepWithScreenshot.screenshot);
      const img = await loadImageSize(dataUrl);
      const imgWidthMm = CONTENT_WIDTH;
      const imgHeightMm = (img.height / img.width) * imgWidthMm;

      doc.addPage();
      y = MARGIN;
      doc.setFont(undefined, "bold");
      doc.text("Aperçu de l'état final de la page", MARGIN, y);
      y += 7;
      doc.addImage(dataUrl, "PNG", MARGIN, y, imgWidthMm, Math.min(imgHeightMm, 260));
    } catch (err) {
      // Un PDF sans capture reste utile — on ne bloque pas l'export pour ça.
      console.error("Capture non intégrée au PDF :", err.message);
    }
  }

  doc.save(`rapport-run-${runResult.runId}.pdf`);
}

function loadImageSize(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}