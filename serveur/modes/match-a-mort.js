// =========================================================================
// MODES/MATCH-A-MORT.JS — Mode de jeu 2 : Match à mort par équipe
//
// 3v3, première équipe à 150 points gagne. Un kill = 5 points, et fait
// tomber une boule d'énergie sur le corps de la victime : quiconque la
// ramasse dans les 5 sec gagne 5 points de plus + un soin de 2% de sa vie
// actuelle (rien si déjà à vie max). Durée max de la partie : 10 minutes
// (le score le plus haut gagne au temps limite). Pas de manches : un seul
// round décide du match (voir REGLES.match.manchesPourGagnerMatch = 1).
// =========================================================================
import {
  nomsSpawn,
  prefixesSpawnPourRound,
  formatEquitable,
  verifierVainqueurRoundParScore,
  verifierVainqueurMatchGenerique
} from './commun.js';

export { nomsSpawn, prefixesSpawnPourRound, formatEquitable };

export const INFO = { id: 'match_a_mort', nom: 'Match à mort par équipe' };

export const REGLES = {
  points: {
    parKill: 5,
    parBoule: 5     // points gagnés en ramassant la boule d'énergie d'un kill
  },

  boule: {
    dureeSec: 5,       // temps pendant lequel la boule reste ramassable avant de disparaître
    bonusViePct: 2      // soin = 2% de la vie ACTUELLE du ramasseur (0 si déjà à vie max)
  },

  match: {
    pointsPourGagner: 150,
    dureeMaxRound: 600,        // 10 minutes
    manchesPourGagnerMatch: 1  // un seul round, pas de "meilleur des 3" pour ce mode
  },

  // Même délai que le mode "capture de zone" par défaut — à ajuster si besoin.
  mort: {
    tempsRespawn: 5
  },

  // --- Séquence de démarrage sur la map (même logique que le mode Capture de zone) ---
  demarrage: {
    tempsAttenteAvantDecompte: 10, // sec, dès l'arrivée sur la map
    dureeDecompte: 5, // sec, avant le début effectif de la partie
    dureeDeblocage: 3 // sec après le top départ, pendant lesquelles les commandes du drone restent gelées
  }
};

let compteurBoule = 1;

// --- État propre à ce mode, ajouté sur partie.etatMode à la création de la partie ---
export function creerEtatPartie() {
  return { boules: [] }; // { id, x, z, expireA } — boules d'énergie posées et pas encore ramassées
}

// --- Appelé par server.js à chaque tick (10 Hz) ---
export function tick(partie, delta) {
  const etat = partie.etatMode;
  const maintenant = Date.now();
  etat.boules = etat.boules.filter((b) => b.expireA > maintenant); // fait disparaître les boules expirées

  const vainqueurRound = verifierVainqueurRoundParScore(
    partie.scoreA, partie.scoreB, partie.tempsRoundEcoule,
    REGLES.match.pointsPourGagner, REGLES.match.dureeMaxRound
  );

  return {
    diffusion: {
      scoreA: Math.floor(partie.scoreA),
      scoreB: Math.floor(partie.scoreB),
      boules: etat.boules,
      tempsRestant: Math.max(0, REGLES.match.dureeMaxRound - partie.tempsRoundEcoule)
    },
    vainqueurRound
  };
}

// --- Appelé par server.js quand un client signale un kill ---
// victime/tueur : { pseudo, equipe }, positionVictime : { x, z }
export function surKill(partie, victime, tueur, positionVictime) {
  const cleScore = tueur.equipe === 'A' ? 'scoreA' : 'scoreB';
  partie[cleScore] += REGLES.points.parKill;

  const boule = {
    id: compteurBoule++,
    x: positionVictime.x,
    z: positionVictime.z,
    expireA: Date.now() + REGLES.boule.dureeSec * 1000
  };
  partie.etatMode.boules.push(boule);

  return { points: REGLES.points.parKill, boule };
}

// --- Appelé par server.js quand un client signale avoir ramassé une boule ---
// ramasseur : { pseudo, equipe }. vieActuelle/vieMax : nombres envoyés par le client
// (c'est le client qui connaît la vie réelle du drone, le serveur ne fait que le calcul du bonus).
// Retourne null si la boule n'existe plus (déjà ramassée ou expirée) — server.js ne diffuse rien
// dans ce cas.
export function surRamasserBoule(partie, idBoule, ramasseur, vieActuelle, vieMax) {
  const etat = partie.etatMode;
  const index = etat.boules.findIndex((b) => b.id === idBoule);
  if (index === -1) return null;

  etat.boules.splice(index, 1);

  const cleScore = ramasseur.equipe === 'A' ? 'scoreA' : 'scoreB';
  partie[cleScore] += REGLES.points.parBoule;

  let soin = 0;
  if (typeof vieActuelle === 'number' && typeof vieMax === 'number' && vieActuelle < vieMax) {
    soin = Math.min(vieMax - vieActuelle, vieActuelle * REGLES.boule.bonusViePct / 100);
  }

  return { points: REGLES.points.parBoule, soin };
}

export function verifierVainqueurMatch(historiqueRounds) {
  return verifierVainqueurMatchGenerique(historiqueRounds, REGLES.match.manchesPourGagnerMatch);
}
