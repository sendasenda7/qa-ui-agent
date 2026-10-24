/**
 * À mettre en `onError` d'une <img> : cache l'image si le fichier n'existe plus (captures supprimées par le
 * nettoyage automatique du backend) au lieu d'afficher l'icône d'image cassée.
 */
export function hideBrokenImage(event) {
  event.currentTarget.style.display = "none";
}
