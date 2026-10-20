/** « 1er », « 2e », « 3e »... pour dire à quel essai une étape a réussi. */
export function ordinalFr(n) {
  return n === 1 ? "1er" : `${n}e`;
}
