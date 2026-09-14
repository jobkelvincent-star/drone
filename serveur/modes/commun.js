// =========================================================================
// MODES/COMMUN.JS — Logique partagée entre tous les modes de jeu
// (spawns par équipe, format de matchmaking équitable, victoire par score)
// =========================================================================

// --- Noms des points de spawn ---
// Équipe A : "1_1", "1_2", "1_3"  |  Équipe B : "2_1", "2_2", "2_3"
export function nomsSpawn(equipe) {
  const prefixe = equipe === 'A' ? '1' : '2';
  return [1, 2, 3].map((n) => `${prefixe}_${n}`);
}

// Retourne les préfixes de spawn (équipeA, équipeB) pour un numéro de round donné (1, 2, 3...)
// Round 1 : A → "1_x", B → "2_x". Round 2 : inversé. etc.
export function prefixesSpawnPourRound(numeroRound) {
  const inverse = numeroRound % 2 === 0;
  return {
    equipeA: inverse ? '2' : '1',
    equipeB: inverse ? '1' : '2'
  };
}

// Un format est équitable si les deux équipes ont le même nombre de joueurs (1v1, 2v2 ou 3v3)
export function formatEquitable(nbJoueursA, nbJoueursB) {
  return nbJoueursA === nbJoueursB && nbJoueursA >= 1 && nbJoueursA <= 3;
}

// --- Victoire de round par score + limite de temps (utilisé par plusieurs modes) ---
export function verifierVainqueurRoundParScore(scoreA, scoreB, tempsEcoule, pointsPourGagner, dureeMaxRound) {
  if (scoreA >= pointsPourGagner) return 'A';
  if (scoreB >= pointsPourGagner) return 'B';

  if (tempsEcoule >= dureeMaxRound) {
    if (scoreA > scoreB) return 'A';
    if (scoreB > scoreA) return 'B';
    return 'egalite';
  }

  return null; // round toujours en cours
}

// --- Victoire de match sur l'historique des rounds (best of N, N = manchesPourGagnerMatch) ---
// Pour un mode à un seul round (pas de manches), passer manchesPourGagnerMatch: 1.
export function verifierVainqueurMatchGenerique(historiqueRounds, manchesPourGagnerMatch) {
  const victoiresA = historiqueRounds.filter((v) => v === 'A').length;
  const victoiresB = historiqueRounds.filter((v) => v === 'B').length;

  if (victoiresA >= manchesPourGagnerMatch) return 'A';
  if (victoiresB >= manchesPourGagnerMatch) return 'B';
  return null;
}
