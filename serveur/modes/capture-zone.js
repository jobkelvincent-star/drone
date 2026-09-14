// =========================================================================
// MODES/CAPTURE-ZONE.JS — Mode de jeu 1 : Capture de zone
//
// Toute la logique propre à CE mode vit dans ce fichier. server.js reste
// générique : il appelle seulement INFO, REGLES, creerEtatPartie(), tick(),
// surKill(), verifierVainqueurMatch() et les fonctions partagées ci-dessous
// — jamais le détail (zone, contrôle, etc.).
// =========================================================================
import {
  nomsSpawn,
  prefixesSpawnPourRound,
  formatEquitable,
  verifierVainqueurRoundParScore,
  verifierVainqueurMatchGenerique
} from './commun.js';

export { nomsSpawn, prefixesSpawnPourRound, formatEquitable };

export const INFO = { id: 'capture_zone', nom: 'Capture de zone' };

export const REGLES = {
  // --- Zone de capture ---
  zone: {
    rayon: 12, // mètres

    // Temps (en sec) pour une capture complète (0 → 100) selon le nombre de joueurs dans le rayon
    tempsCapture: { 1: 10, 2: 6.3, 3: 5 },
    // Temps (en sec) pour une neutralisation complète (100 → 0)
    tempsNeutralisation: { 1: 6.5, 2: 4.1, 3: 3.25 }
  },

  // --- Points ---
  points: {
    captureComplete: 15,      // une seule fois, au moment où le contrôle atteint 100 ou -100
    tenueParSeconde: 1,       // tant que la zone est pleinement contrôlée
    killGeneral: 3,           // kill hors du rayon de la zone
    killDefensif: 5,          // kill dans le rayon, l'équipe du tueur contrôle déjà la zone
    killOffensif: 6           // kill dans le rayon, l'équipe du tueur ne contrôle pas la zone
  },

  // --- Fin de manche / match ---
  match: {
    pointsPourGagner: 120,
    dureeMaxRound: 300, // 5 min, en secondes — au-delà, le score le plus haut gagne
    manchesPourGagnerMatch: 2 // meilleur des 3
  },

  // --- Mort / réapparition ---
  mort: {
    tempsRespawn: 5 // secondes
  },

  // --- Contrôle (CC) : diminishing returns par joueur ---
  controleDeGroupe: {
    fenetreSec: 5.5,
    multiplicateurs: [1, 0.5, 0.25, 0], // 1er, 2e, 3e, 4e+ (0 = immunité totale)
    dureeImmunite: 1.25 // ~1 à 1,5 sec
  },

  // --- Séquence de démarrage sur la map ---
  demarrage: {
    tempsAttenteAvantDecompte: 10, // sec, dès l'arrivée sur la map
    dureeDecompte: 5, // sec, avant le début effectif de la partie
    dureeDeblocage: 3 // sec après le top départ, pendant lesquelles les commandes du drone restent gelées
  }
};

// Vitesse de capture/neutralisation en points/sec, pour un nombre de joueurs donné
function vitesseCapture(nbJoueurs) {
  if (nbJoueurs >= 3) return 100 / REGLES.zone.tempsCapture[3];
  if (nbJoueurs === 2) return 100 / REGLES.zone.tempsCapture[2];
  return 100 / REGLES.zone.tempsCapture[1];
}
function vitesseNeutralisation(nbJoueurs) {
  if (nbJoueurs >= 3) return 100 / REGLES.zone.tempsNeutralisation[3];
  if (nbJoueurs === 2) return 100 / REGLES.zone.tempsNeutralisation[2];
  return 100 / REGLES.zone.tempsNeutralisation[1];
}

function estDansLaZone(position) {
  if (!position) return false;
  return Math.sqrt(position.x * position.x + position.z * position.z) <= REGLES.zone.rayon;
}

// --- État propre à ce mode, ajouté sur partie.etatMode à la création de la partie ---
export function creerEtatPartie() {
  return { controle: 0 }; // -100 (équipe B) ... 0 (neutre) ... 100 (équipe A)
}

// --- Appelé par server.js à chaque tick (10 Hz) ---
// Retourne { diffusion, vainqueurRound } — server.js diffuse "diffusion" en 'etatPartie'
// et déclenche terminerRound() si vainqueurRound n'est ni null ni 'egalite'.
export function tick(partie, delta) {
  const etat = partie.etatMode;

  const countA = partie.joueursA.filter((j) => estDansLaZone(partie.positions[j.pseudo])).length;
  const countB = partie.joueursB.filter((j) => estDansLaZone(partie.positions[j.pseudo])).length;

  if (countA > 0 && countB > 0) {
    // contesté : rien ne bouge
  } else if (countA > 0) {
    etat.controle += (etat.controle < 0 ? vitesseNeutralisation(countA) : vitesseCapture(countA)) * delta;
  } else if (countB > 0) {
    etat.controle -= (etat.controle > 0 ? vitesseNeutralisation(countB) : vitesseCapture(countB)) * delta;
  }
  etat.controle = Math.max(-100, Math.min(100, etat.controle));

  if (etat.controle >= 100) partie.scoreA += REGLES.points.tenueParSeconde * delta;
  if (etat.controle <= -100) partie.scoreB += REGLES.points.tenueParSeconde * delta;

  const vainqueurRound = verifierVainqueurRoundParScore(
    partie.scoreA, partie.scoreB, partie.tempsRoundEcoule,
    REGLES.match.pointsPourGagner, REGLES.match.dureeMaxRound
  );

  return {
    diffusion: {
      controle: etat.controle,
      scoreA: Math.floor(partie.scoreA),
      scoreB: Math.floor(partie.scoreB),
      tempsRestant: Math.max(0, REGLES.match.dureeMaxRound - partie.tempsRoundEcoule)
    },
    vainqueurRound
  };
}

// --- Appelé par server.js quand un client signale un kill ---
// victime/tueur : { pseudo, equipe }, positionVictime : { x, z }
// Retourne les infos à diffuser en plus de pseudoVictime/pseudoTueur (voir server.js)
export function surKill(partie, victime, tueur, positionVictime) {
  const etat = partie.etatMode;
  const dansLaZone = estDansLaZone(positionVictime);

  let points;
  if (!dansLaZone) {
    points = REGLES.points.killGeneral;
  } else {
    const equipeControle = etat.controle >= 100 ? 'A' : etat.controle <= -100 ? 'B' : null;
    points = (equipeControle === tueur.equipe) ? REGLES.points.killDefensif : REGLES.points.killOffensif;
  }

  const cleScore = tueur.equipe === 'A' ? 'scoreA' : 'scoreB';
  partie[cleScore] += points;

  return { points };
}

export function verifierVainqueurMatch(historiqueRounds) {
  return verifierVainqueurMatchGenerique(historiqueRounds, REGLES.match.manchesPourGagnerMatch);
}
