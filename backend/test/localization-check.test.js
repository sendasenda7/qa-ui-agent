import { test } from "node:test";
import assert from "node:assert/strict";
import { isArabicToggleLabel, findArabicToggle, compareLocalization, shouldIgnoreUntranslated } from "../src/localization-check.js";

test("reconnaît les libellés courants du bouton arabe", () => {
  for (const label of ["AR", "ar", "(AR)", "Passer en AR", "العربية", "عربي", "Arabe", "Arabic", "Switch to Arabic", "العربية (AR)"]) {
    assert.equal(isArabicToggleLabel(label, {}), true, label);
  }
});

test("ne confond pas avec des mots qui contiennent simplement « ar »", () => {
  for (const label of ["Parler", "Carte", "Archive", "Partager", "Rechercher", "", null]) {
    assert.equal(isArabicToggleLabel(label, {}), false, String(label));
  }
});

test("AR_TOGGLE_KEYWORDS permet d'ajouter un libellé sans toucher au code", () => {
  assert.equal(isArabicToggleLabel("Tounsi", {}), false);
  assert.equal(isArabicToggleLabel("Tounsi", { AR_TOGGLE_KEYWORDS: "tounsi, darija" }), true);
});

test("détecte aussi le bouton via son attribut lang / hreflang", () => {
  const found = findArabicToggle([{ accessibleName: "Langue", lang: "ar-TN", selector: "#l" }], {});
  assert.equal(found.selector, "#l");
});

test("ignore e-mails, URLs et textes listés dans I18N_IGNORE_TEXTS", () => {
  assert.equal(shouldIgnoreUntranslated("contact@helpify.tn", {}), true);
  assert.equal(shouldIgnoreUntranslated("https://helpify.tn", {}), true);
  assert.equal(shouldIgnoreUntranslated("Helpify", {}), false);
  assert.equal(shouldIgnoreUntranslated("Helpify", { I18N_IGNORE_TEXTS: "helpify, Espoir" }), true);
});

test("le bouton de langue lui-même n'est jamais signalé comme non traduit", () => {
  const el = (selector, accessibleName) => ({ selector, accessibleName });
  const report = compareLocalization(
    { url: "u", dir: "ltr", lang: "fr", toggleSelector: "#lang", elements: [el("#lang", "AR"), el("#b", "Envoyer")] },
    { dir: "rtl", lang: "ar", elements: [el("#lang", "AR"), el("#b", "إرسال")] }
  );
  assert.equal(report.findingsCount, 0);
});
