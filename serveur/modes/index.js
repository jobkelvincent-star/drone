// =========================================================================
// MODES/INDEX.JS — Registre des modes de jeu disponibles
//
// Pour ajouter un 2e mode :
//   1) Créer modes/<nom-du-mode>.js avec la même forme que capture-zone.js :
//        - export const INFO = { id: '...', nom: '...' };
//        - export function verifierVainqueurMatch(historiqueRounds) { ... }
//        - export function verifierVainqueurRound(...) { ... }
//        - + toutes les fonctions propres à sa logique
//      (INFO et les 2 fonctions de victoire sont ce que server.js appelle
//      toujours de la même façon, quel que soit le mode.)
//   2) L'importer et l'ajouter dans MODES ci-dessous.
// server.js n'a plus besoin d'être modifié pour ça.
// =========================================================================
import * as captureZone from './capture-zone.js';
import * as matchAMort from './match-a-mort.js';

const MODES = {
  [captureZone.INFO.id]: captureZone,
  [matchAMort.INFO.id]: matchAMort
};

// Mode utilisé par défaut si un client rejoint la file sans préciser de mode
// (ex: pendant qu'on branche le futur bouton "Mode de jeu" du menu).
export const MODE_PAR_DEFAUT = captureZone.INFO.id;

export function obtenirMode(id) {
  return MODES[id] || MODES[MODE_PAR_DEFAUT];
}

// Utilisé par le menu (plus tard) pour afficher les modes disponibles dans le bouton.
export function listeModesPourMenu() {
  return Object.values(MODES).map((m) => m.INFO);
}
