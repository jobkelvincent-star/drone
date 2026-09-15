// =========================================================================
// SERVER.JS — Serveur réseau : matchmaking + synchronisation des parties
// Lancement : node server.js   (nécessite : npm install ws)
//
// Ce fichier est générique : il ne connaît aucune règle de mode de jeu
// précise. Toute la logique (capture de zone, match à mort, futurs modes)
// vit dans modes/*.js. server.js appelle toujours les mêmes points d'entrée
// génériques : partie.regles.creerEtatPartie(), .tick(), .surKill(),
// .surRamasserBoule() (si le mode la définit), .verifierVainqueurMatch(),
// .prefixesSpawnPourRound(), .formatEquitable().
// =========================================================================

import { WebSocketServer } from 'ws';
import { randomBytes } from 'crypto';
import { obtenirMode, listeModesPourMenu, MODE_PAR_DEFAUT } from './modes/index.js';
import { obtenirMapAleatoire } from './maps/index.js';

const PORT = process.env.PORT || 8080; // Render/Railway imposent leur propre port via cette variable d'environnement
const wss = new WebSocketServer({ port: PORT });
console.log(`Serveur démarré sur le port ${PORT}`);

// =========================================================================
// ANTI-TRICHE — Le serveur était déjà l'arbitre des PV totaux, mais faisait
// encore confiance aux valeurs de "degats" et "position" envoyées telles
// quelles par le client. Ci-dessous : des garde-fous qui n'existaient pas.
// =========================================================================

// Plafond de dégâts par personnage = le plus gros coup unique qu'il puisse
// réellement infliger (lu directement dans chaque d1-d8.html), + 25% de
// marge (portée à 25% après retours de tests, contre 10% initialement, pour
// éviter que des dégâts légitimes ne se fassent écrêter par erreur).
// Toute valeur au-delà est un signe de triche : on l'écrête au plafond.
const PLAFOND_DEGATS_PAR_PERSONNAGE = {
  d1: 563,   // Guêpe    — Double Laser (450 par tir)
  d2: 1000,  // Bastion  — Onde de Choc (800)
  d3: 750,   // Bactérie — Orbe d'Énergie (600)
  d4: 2000,  // Phalange — Missile Chercheur (1600, le plus gros coup ; pompe = 220/plomb)
  d5: 500,   // Pyromane — Napalm impact (400 ; les ticks de brûlure sont plus petits)
  d6: 1000,  // Scorpion — Harpon Électrique (800 ; lames = 400)
  d7: 2750,  // Faucon   — Frappe Orbitale (2200 ; tir de précision = 1400)
  d8: 938    // Nexus    — Disque Rebondissant premier impact (750 ; IEM = 500)
};
const PLAFOND_DEGATS_DEFAUT = 2750; // si un personnage inconnu arrive un jour, on prend le plus haut plafond existant

// Anti-flood : au-delà de ce nombre de messages "degats" par seconde et par
// attaquant, les messages en trop sont ignorés (volontairement large pour ne
// jamais couper les dégâts sur la durée du Pyromane/Bactérie, qui envoient
// plusieurs petits ticks par seconde).
const MAX_DEGATS_PAR_SECONDE = 15;
const compteurDegats = new Map(); // pseudo -> { fenetreDebut, nombre }

function degatsAutorises(pseudo) {
  const maintenant = Date.now();
  let compteur = compteurDegats.get(pseudo);
  if (!compteur || maintenant - compteur.fenetreDebut > 1000) {
    compteur = { fenetreDebut: maintenant, nombre: 0 };
    compteurDegats.set(pseudo, compteur);
  }
  compteur.nombre += 1;
  return compteur.nombre <= MAX_DEGATS_PAR_SECONDE;
}

// Vitesse plausible la plus élevée possible tous drones/bonus confondus
// (volontairement large pour ne jamais gêner un déplacement légitime, y
// compris pendant une esquive/dash) : sert uniquement à repérer un
// téléport évident, pas à valider la physique précise de chaque drone.
const VITESSE_MAX_PLAUSIBLE = 35; // unités / seconde
const dernierePosition = new Map(); // pseudo -> { x, z, t }

// Renvoie la position à utiliser (celle reçue si plausible, sinon la dernière
// position connue rapprochée au maximum autorisé dans la même direction).
function positionValidee(pseudo, x, z) {
  const maintenant = Date.now();
  const precedente = dernierePosition.get(pseudo);
  if (!precedente) {
    dernierePosition.set(pseudo, { x, z, t: maintenant });
    return { x, z };
  }

  const dt = Math.max(0.001, (maintenant - precedente.t) / 1000);
  const dx = x - precedente.x;
  const dz = z - precedente.z;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const distanceMax = VITESSE_MAX_PLAUSIBLE * dt;

  let resultat;
  if (distance <= distanceMax) {
    resultat = { x, z };
  } else {
    // Rapproche la position vers celle demandée, mais sans dépasser la distance plausible
    const ratio = distanceMax / distance;
    resultat = { x: precedente.x + dx * ratio, z: precedente.z + dz * ratio };
  }

  dernierePosition.set(pseudo, { x: resultat.x, z: resultat.z, t: maintenant });
  return resultat;
}

// Plafond de soin par personnage = le plus gros soin unique qu'il puisse
// réellement infliger à un allié (même logique que les dégâts : on réutilise
// directement PLAFOND_DEGATS_PAR_PERSONNAGE, car pour l'instant le seul soin
// réseau existant — l'Orbe d'Énergie de la Bactérie — partage la même valeur
// de base que ses dégâts). À ajuster si un futur drone a un soin plus fort
// que ses dégâts.
function plafondSoin(personnage) {
  return PLAFOND_DEGATS_PAR_PERSONNAGE[personnage] || PLAFOND_DEGATS_DEFAUT;
}

const MAX_SOINS_PAR_SECONDE = 10;
const compteurSoins = new Map(); // pseudo -> { fenetreDebut, nombre }

function soinAutorise(pseudo) {
  const maintenant = Date.now();
  let compteur = compteurSoins.get(pseudo);
  if (!compteur || maintenant - compteur.fenetreDebut > 1000) {
    compteur = { fenetreDebut: maintenant, nombre: 0 };
    compteurSoins.set(pseudo, compteur);
  }
  compteur.nombre += 1;
  return compteur.nombre <= MAX_SOINS_PAR_SECONDE;
}

// Plafond de durée d'étourdissement/silence = le plus long connu (Harpon
// Électrique du Scorpion, 3s complet) + une petite marge, comme pour les
// dégâts. Empêche un client triché d'envoyer une durée énorme pour bloquer
// un adversaire indéfiniment.
const PLAFOND_ETOURDISSEMENT_SEC = 3.5;

const MAX_ETOURDISSEMENTS_PAR_SECONDE = 5;
const compteurEtourdissements = new Map(); // pseudo -> { fenetreDebut, nombre }

function etourdissementAutorise(pseudo) {
  const maintenant = Date.now();
  let compteur = compteurEtourdissements.get(pseudo);
  if (!compteur || maintenant - compteur.fenetreDebut > 1000) {
    compteur = { fenetreDebut: maintenant, nombre: 0 };
    compteurEtourdissements.set(pseudo, compteur);
  }
  compteur.nombre += 1;
  return compteur.nombre <= MAX_ETOURDISSEMENTS_PAR_SECONDE;
}

// --- Vie max plafonnée (message "declarerVie") ---
// Un client triché pourrait déclarer une vie max énorme pour devenir invincible : on plafonne
// à la vie max réelle de chaque personnage (lue dans d1-d8.html) + 10% de marge (bonus de vie
// du pilote "tanki" = 1,5% max en pratique, comme pour les dégâts).
const PLAFOND_VIE_PAR_PERSONNAGE = {
  d1: 2640,  // Guêpe    2400
  d2: 7700,  // Bastion  7000
  d3: 3960,  // Bactérie 3600
  d4: 5280,  // Phalange 4800
  d5: 4400,  // Pyromane 4000
  d6: 3300,  // Scorpion 3000
  d7: 2640,  // Faucon   2400
  d8: 4180   // Nexus    3800
};
const PLAFOND_VIE_DEFAUT = 7700; // si un personnage inconnu arrive un jour, plafond le plus haut existant

// --- Plafond de DPS/HPS réels (fenêtre glissante de 1s) ---
// Plutôt que de recoder la cadence exacte de chaque drone côté serveur (rafales, DoT, ultimes...),
// on plafonne le total de dégâts/soin qu'un personnage peut légitimement infliger sur n'importe
// quelle fenêtre d'1 seconde consécutive, calculé à partir de son attaque de base + le pire cas
// de chevauchement avec son ultime (+ 10% de marge). Un client qui spamme des dégâts au plafond
// unitaire (sans respecter les cooldowns) se fait donc écrêter ici, même si chaque coup pris
// isolément semblait valide.
// Même logique que ci-dessus mais sur le DPS (dégâts par seconde), avec la même marge de 25%.
const PLAFOND_DPS_PAR_PERSONNAGE = {
  d1: 1900,  // Guêpe    — 900/1,2s normal, 900/0,6s pendant Surcharge (cadence doublée)
  d2: 510,   // Bastion  — 800/2,0s, pas d'ultime dégâts
  d3: 510,   // Bactérie — 600/1,5s, pas d'ultime dégâts réseau (soin ulti = self, pas encore réseau)
  d4: 3020,  // Phalange — 1100/1,4s + pire cas : missile 1600 qui tombe la même seconde
  d5: 1840,  // Pyromane — impact+DoT qui se chevauchent + pluie de cendres (1500/2,3s) pendant l'ulti
  d6: 2390,  // Scorpion — 1200/1,1s + pire cas : Harpon 800 qui tombe la même seconde
  d7: 3555,  // Faucon   — 1400/2,3s + pire cas : Frappe Orbitale 2200 qui tombe la même seconde
  d8: 1225   // Nexus    — 750/1,6s (1er impact) + pire cas : IEM 500 qui tombe la même seconde
};
const PLAFOND_DPS_DEFAUT = 3555;

// Seule la Bactérie (d3) a un soin réseau à ce jour (l'Orbe d'Énergie sert aussi de dégâts) ;
// tout autre personnage qui enverrait un message "soigner" est donc entièrement suspect.
const PLAFOND_HPS_PAR_PERSONNAGE = { d3: 440 };
const PLAFOND_HPS_DEFAUT = 0;

// Fenêtre glissante générique : mémorise (horodatage, montant) par pseudo, et écrête tout
// nouveau montant qui ferait dépasser le plafond cumulé sur la dernière seconde.
const fenetresDegats = new Map(); // pseudo -> [{ t, montant }, ...]
const fenetresSoins = new Map();

function ecreterSurFenetre(map, pseudo, montant, plafondParSeconde) {
  const maintenant = Date.now();
  let entrees = map.get(pseudo);
  if (!entrees) { entrees = []; map.set(pseudo, entrees); }
  // Purge tout ce qui a plus d'1 seconde
  while (entrees.length && maintenant - entrees[0].t > 1000) entrees.shift();
  const cumulRecent = entrees.reduce((s, e) => s + e.montant, 0);
  const montantAutorise = Math.max(0, Math.min(montant, plafondParSeconde - cumulRecent));
  if (montantAutorise > 0) entrees.push({ t: maintenant, montant: montantAutorise });
  return montantAutorise;
}


// Chaque entrée : { ws, pseudo, personnage, mode, arriveeFile }
// --- File d'attente de matchmaking ---
let fileAttente = [];
const TEMPS_MAX_ATTENTE = 25000; // 25 sec avant d'abandonner (laisse le temps au palier 1v1 à 20s)

// --- Parties en cours ---
// Chaque partie : { id, modeId, regles, etatMode, joueursA: [], joueursB: [], numeroRound, historiqueRounds: [], ... }
const parties = new Map();
let compteurPartieId = 1;

function envoyer(ws, type, donnees = {}) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...donnees }));
  }
}

function diffuserAPartie(partie, type, donnees = {}) {
  [...partie.joueursA, ...partie.joueursB].forEach((j) => envoyer(j.ws, type, donnees));
}

function trouverJoueur(partie, pseudo) {
  return [...partie.joueursA, ...partie.joueursB].find((j) => j.pseudo === pseudo);
}

// --- Unicité des pseudos ---
// Le serveur identifie encore les joueurs par pseudo (positions, PV, etc.), donc deux
// pseudos identiques en même temps casseraient trouverJoueur(). On garantit l'unicité
// dès l'entrée en file plutôt que de tout réindexer par un id interne.
function pseudosUtilises() {
  const utilises = new Set(fileAttente.map((j) => j.pseudo));
  parties.forEach((partie) => {
    [...partie.joueursA, ...partie.joueursB].forEach((j) => utilises.add(j.pseudo));
  });
  return utilises;
}

function pseudoUnique(pseudoDemande) {
  const utilises = pseudosUtilises();
  if (!utilises.has(pseudoDemande)) return pseudoDemande;
  let n = 2;
  while (utilises.has(`${pseudoDemande}#${n}`)) n++;
  return `${pseudoDemande}#${n}`;
}

let compteurBot = 1;
const PERSONNAGES_BOTS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8'];

// Un "bot" est un faux joueur : même forme d'objet qu'un vrai (pseudo, personnage, ws...),
// sauf que son ws est un bouchon qui ne sera jamais OPEN -> envoyer() lui écrit dans le vide
// sans planter. Sa position/ses tirs sont simulés par simulerBots() (cf. plus bas) et diffusés
// aux vrais joueurs exactement comme ceux d'un humain (mêmes messages réseau).
function creerBot() {
  const personnage = PERSONNAGES_BOTS[Math.floor(Math.random() * PERSONNAGES_BOTS.length)];
  return {
    ws: { readyState: -1 }, // jamais WebSocket.OPEN (1) : envoyer() ignore silencieusement
    pseudo: pseudoUnique(`Bot${compteurBot++}`),
    personnage,
    bot: true,
    mode: null,
    jeton: null
  };
}

const VIE_BASE_PAR_PERSONNAGE = { d1: 2400, d2: 7000, d3: 3600, d4: 4800, d5: 4000, d6: 3000, d7: 2400, d8: 3800 };

const spawnsConnus = {}; // nomMap -> { "1_1": {x,z}, ... } — signalés par les clients (cf. plus bas)

function initialiserBot(partie, bot, xDepart) {
  partie.pvMax[bot.pseudo] = VIE_BASE_PAR_PERSONNAGE[bot.personnage] || 3000;
  partie.pv[bot.pseudo] = partie.pvMax[bot.pseudo];
  const nomSpawn = partie.spawnDe[bot.pseudo];
  const connu = spawnsConnus[partie.nomMap] && spawnsConnus[partie.nomMap][nomSpawn];
  partie.positions[bot.pseudo] = connu ? { x: connu.x, z: connu.z } : { x: xDepart, z: 0 };
}

function equipeDe(partie, joueur) {
  return partie.joueursA.includes(joueur) ? 'A' : 'B';
}

// --- Matchmaking ---
// Les joueurs ne sont regroupés qu'avec d'autres joueurs ayant demandé le MÊME mode.
// On cherche d'abord un 3v3 ; s'il n'y a pas assez de monde, on patiente avant d'accepter un
// format plus petit (2v2 puis 1v1), pour laisser une chance à un match complet de se former.
const DELAI_AVANT_2V2 = 10000; // 10s d'attente (depuis l'arrivée du plus ancien) avant d'accepter un 2v2
const DELAI_AVANT_1V1 = 20000; // 20s d'attente avant d'accepter un 1v1

function tenterMatchmaking() {
  const maintenant = Date.now();
  const modesEnAttente = [...new Set(fileAttente.map((j) => j.mode))];

  modesEnAttente.forEach((modeId) => {
    const sousFile = fileAttente.filter((j) => j.mode === modeId);
    if (sousFile.length < 2) return;

    const plusAncien = Math.min(...sousFile.map((j) => j.arriveeFile));
    const tempsAttente = maintenant - plusAncien;

    let taille = null;
    if (sousFile.length >= 6) taille = 3;
    else if (sousFile.length >= 4 && tempsAttente >= DELAI_AVANT_2V2) taille = 2;
    else if (sousFile.length >= 2 && tempsAttente >= DELAI_AVANT_1V1) taille = 1;

    if (taille) {
      const joueursA = sousFile.slice(0, taille);
      const joueursB = sousFile.slice(taille, taille * 2);
      const retires = new Set([...joueursA, ...joueursB]);
      fileAttente = fileAttente.filter((j) => !retires.has(j));
      console.log(`[matchmaking] Match ${taille}v${taille} (mode: ${modeId}) créé : ${joueursA.map(j => j.pseudo)} vs ${joueursB.map(j => j.pseudo)}`);
      creerPartie(joueursA, joueursB, modeId);
    }
  });

  // Remplissage par bot : un joueur seul (ou plusieurs, sans assez d'adversaires réels) qui a
  // coché "remplir par des bots" et attend depuis un moment part en 1v1 contre un bot plutôt
  // que d'attendre indéfiniment un vrai adversaire.
  const DELAI_AVANT_BOT = 6000; // 6s d'attente avant de proposer un bot
  fileAttente
    .filter((j) => j.avecBots && maintenant - j.arriveeFile >= DELAI_AVANT_BOT)
    .forEach((j) => {
      if (!fileAttente.includes(j)) return; // déjà retiré par un match créé plus haut dans cette même passe
      fileAttente = fileAttente.filter((autre) => autre !== j);
      console.log(`[matchmaking] ${j.pseudo} n'a pas trouvé d'adversaire réel à temps -> match contre un bot (mode: ${j.mode})`);
      creerPartie([j], [creerBot()], j.mode);
    });
}

// Tient les joueurs encore en file informés : combien sont en attente dans leur mode, depuis
// combien de temps, et dans combien de temps le prochain format plus petit sera accepté.
function diffuserEtatFile() {
  const maintenant = Date.now();
  const modesEnAttente = [...new Set(fileAttente.map((j) => j.mode))];

  modesEnAttente.forEach((modeId) => {
    const sousFile = fileAttente.filter((j) => j.mode === modeId);
    const plusAncien = Math.min(...sousFile.map((j) => j.arriveeFile));
    const tempsAttente = maintenant - plusAncien;

    let prochainPalierSec = null;
    if (sousFile.length >= 4 && tempsAttente < DELAI_AVANT_2V2) {
      prochainPalierSec = Math.ceil((DELAI_AVANT_2V2 - tempsAttente) / 1000);
    } else if (sousFile.length < 4 && sousFile.length >= 2 && tempsAttente < DELAI_AVANT_1V1) {
      prochainPalierSec = Math.ceil((DELAI_AVANT_1V1 - tempsAttente) / 1000);
    }

    sousFile.forEach((j) => {
      envoyer(j.ws, 'fileAttente', {
        enAttente: sousFile.length,
        tempsAttenteSec: Math.floor((maintenant - j.arriveeFile) / 1000),
        prochainPalierSec
      });
    });
  });
}

// Renvoie au menu les joueurs qui attendent depuis trop longtemps sans format équitable
function verifierTimeouts() {
  const maintenant = Date.now();
  fileAttente = fileAttente.filter((j) => {
    if (maintenant - j.arriveeFile > TEMPS_MAX_ATTENTE) {
      envoyer(j.ws, 'retourMenu', { raison: 'Pas assez de joueurs pour un format équitable' });
      return false;
    }
    return true;
  });
}
setInterval(() => {
  verifierTimeouts();
  tenterMatchmaking();
  diffuserEtatFile();
}, 1000);

function creerPartie(joueursA, joueursB, modeId) {
  const id = compteurPartieId++;
  const regles = obtenirMode(modeId);
  const partie = {
    id,
    modeId,
    regles,                          // toute la logique du mode, appelée via partie.regles.xxx
    etatMode: regles.creerEtatPartie(), // état propre au mode (ex: contrôle de zone, boules...)
    joueursA,
    joueursB,
    numeroRound: 1,
    historiqueRounds: [], // 'A' ou 'B' par round joué
    scoreA: 0,
    scoreB: 0,
    tempsRoundEcoule: 0,
    positions: {}, // pseudo -> { x, z }
    pv: {},              // pseudo -> vie actuelle (le serveur est l'arbitre des PV)
    pvMax: {},           // pseudo -> vie max déclarée par son client (dépend du build)
    dernierAttaquant: {}, // pseudo victime -> pseudo du dernier joueur qui l'a touché
    protegeJusqua: {},    // pseudo -> timestamp jusqu'auquel les dégâts sont ignorés (bouclier de réapparition)
    spawnDe: {},          // pseudo -> nom du marqueur de spawn de CE round (pour la réapparition)
    enPhaseAttente: true,
    nomMap: obtenirMapAleatoire().cle // la même map pour tout le match
  };
  parties.set(id, partie);

  joueursA.forEach((j) => (j.partieId = id));
  joueursB.forEach((j) => (j.partieId = id));

  demarrerRound(partie);
}

// --- Déroulement d'un round ---
function demarrerRound(partie) {
  partie.scoreA = 0;
  partie.scoreB = 0;
  partie.etatMode = partie.regles.creerEtatPartie(); // état du mode remis à zéro pour le nouveau round
  partie.tempsRoundEcoule = 0;
  partie.enPhaseAttente = true;

  const prefixes = partie.regles.prefixesSpawnPourRound(partie.numeroRound);
  console.log(`[partie ${partie.id}] Round ${partie.numeroRound} — envoi de debutRound (mode: ${partie.modeId}, map: ${partie.nomMap})`);

  const infosCommunes = {
    partieId: partie.id,
    modeId: partie.modeId,
    numeroRound: partie.numeroRound,
    nomMap: partie.nomMap,
    tempsAttente: partie.regles.REGLES.demarrage.tempsAttenteAvantDecompte,
    dureeDecompte: partie.regles.REGLES.demarrage.dureeDecompte,
    joueurs: [
      ...partie.joueursA.map((j) => ({ pseudo: j.pseudo, equipe: 'A', personnage: j.personnage })),
      ...partie.joueursB.map((j) => ({ pseudo: j.pseudo, equipe: 'B', personnage: j.personnage }))
    ]
  };

  partie.joueursA.forEach((j, index) => {
    const nomSpawn = `${prefixes.equipeA}_${index + 1}`;
    partie.spawnDe[j.pseudo] = nomSpawn;
    envoyer(j.ws, 'debutRound', { ...infosCommunes, equipe: 'A', nomSpawn });
    if (j.bot) initialiserBot(partie, j, -15 - index * 6);
  });
  partie.joueursB.forEach((j, index) => {
    const nomSpawn = `${prefixes.equipeB}_${index + 1}`;
    partie.spawnDe[j.pseudo] = nomSpawn;
    envoyer(j.ws, 'debutRound', { ...infosCommunes, equipe: 'B', nomSpawn });
    if (j.bot) initialiserBot(partie, j, 15 + index * 6);
  });

  // Attente sur la map, puis décompte, puis début effectif (durées définies par le mode)
  setTimeout(() => {
    console.log(`[partie ${partie.id}] Envoi du décompte`);
    diffuserAPartie(partie, 'decompte', { duree: partie.regles.REGLES.demarrage.dureeDecompte });
    setTimeout(() => {
      partie.enPhaseAttente = false;
      console.log(`[partie ${partie.id}] Top départ !`);
      diffuserAPartie(partie, 'topDepart', { dureeDeblocage: partie.regles.REGLES.demarrage.dureeDeblocage });
    }, partie.regles.REGLES.demarrage.dureeDecompte * 1000);
  }, partie.regles.REGLES.demarrage.tempsAttenteAvantDecompte * 1000);
}

// Boucle serveur générique à 10 Hz : chaque mode fait son propre calcul dans tick()
// et dit lui-même si quelqu'un a gagné le round (server.js ne connaît pas le détail).
setInterval(() => {
  const delta = 0.1;
  parties.forEach((partie) => {
    if (partie.enPhaseAttente) return;

    partie.tempsRoundEcoule += delta;

    const resultat = partie.regles.tick(partie, delta);
    if (resultat && resultat.diffusion) {
      diffuserAPartie(partie, 'etatPartie', resultat.diffusion);
    }
    if (resultat && resultat.vainqueurRound && resultat.vainqueurRound !== 'egalite') {
      terminerRound(partie, resultat.vainqueurRound);
    }

    [...partie.joueursA, ...partie.joueursB].forEach((bot) => {
      if (bot.bot && partie.pv[bot.pseudo] > 0) simulerBot(partie, bot, delta);
    });
  });
}, 100);

// --- IA très simple d'un bot : fonce sur l'adversaire vivant le plus proche et tire à portée.
// Niveau "accessible" volontaire : pas d'esquive, pas de visée fine, pas de compétences spéciales.
const BOT_VITESSE = 6;      // unités/seconde
const BOT_PORTEE = 20;
const BOT_CADENCE = 1;      // secondes entre deux tirs (était 1.5 : les bots tiraient trop peu)
// Dégâts par tir de bot, proportionnels à l'arme réelle de chaque personnage (environ 1/10e du
// plus gros coup unique listé dans PLAFOND_DEGATS_PAR_PERSONNAGE plus bas) : volontairement plus
// modeste qu'un vrai joueur, mais cohérent avec la puissance relative de chaque drone.
const BOT_DEGATS_PAR_PERSONNAGE = {
  d1: 45,   // Guêpe    — ~1/10 de 450
  d2: 80,   // Bastion  — ~1/10 de 800
  d3: 60,   // Bactérie — ~1/10 de 600
  d4: 160,  // Phalange — ~1/10 de 1600
  d5: 40,   // Pyromane — ~1/10 de 400
  d6: 80,   // Scorpion — ~1/10 de 800
  d7: 220,  // Faucon   — ~1/10 de 2200
  d8: 75    // Nexus    — ~1/10 de 750
};
const BOT_DEGATS_DEFAUT = 60;

function simulerBot(partie, bot, delta) {
  bot.iaCooldown = (bot.iaCooldown || 0) - delta;
  const maPos = partie.positions[bot.pseudo];
  if (!maPos) return;

  const monEquipe = equipeDe(partie, bot);
  const adversaires = (monEquipe === 'A' ? partie.joueursB : partie.joueursA)
    .filter((j) => partie.pv[j.pseudo] > 0 && partie.positions[j.pseudo]);

  if (!adversaires.length) return; // personne à combattre pour l'instant (attente/respawn)

  let cible = adversaires[0];
  let meilleureDist = Infinity;
  adversaires.forEach((j) => {
    const d = Math.hypot(partie.positions[j.pseudo].x - maPos.x, partie.positions[j.pseudo].z - maPos.z);
    if (d < meilleureDist) { meilleureDist = d; cible = j; }
  });

  if (meilleureDist > BOT_PORTEE) {
    // Se rapproche en ligne droite de la cible
    const cibPos = partie.positions[cible.pseudo];
    const dx = cibPos.x - maPos.x;
    const dz = cibPos.z - maPos.z;
    const norme = Math.hypot(dx, dz) || 1;
    maPos.x += (dx / norme) * BOT_VITESSE * delta;
    maPos.z += (dz / norme) * BOT_VITESSE * delta;
    diffuserAPartie(partie, 'positionJoueur', { pseudo: bot.pseudo, x: maPos.x, z: maPos.z, yaw: Math.atan2(dx, dz) });
  } else if (bot.iaCooldown <= 0) {
    bot.iaCooldown = BOT_CADENCE;
    const cibPos = partie.positions[cible.pseudo];
    const dx = cibPos.x - maPos.x;
    const dz = cibPos.z - maPos.z;
    const norme = Math.hypot(dx, dz) || 1;
    diffuserAPartie(partie, 'tir', {
      pseudo: bot.pseudo,
      origin: { x: maPos.x, y: 1, z: maPos.z },
      direction: { x: dx / norme, y: 0, z: dz / norme },
      ultimate: false
    });

    const sousBouclier = partie.protegeJusqua[cible.pseudo] && Date.now() < partie.protegeJusqua[cible.pseudo];
    if (!sousBouclier) {
      const degatsBot = BOT_DEGATS_PAR_PERSONNAGE[bot.personnage] || BOT_DEGATS_DEFAUT;
      partie.pv[cible.pseudo] = Math.max(0, partie.pv[cible.pseudo] - degatsBot);
      partie.dernierAttaquant[cible.pseudo] = bot.pseudo;
      diffuserAPartie(partie, 'degats', { pseudo: cible.pseudo, pv: partie.pv[cible.pseudo], pvMax: partie.pvMax[cible.pseudo] });
      if (partie.pv[cible.pseudo] <= 0) gererMort(partie, cible);
    }
  }
}

// --- Appelé quand les PV d'un joueur tombent à 0 (voir le message 'degats' plus bas) ---
function gererMort(partie, victime) {
  const pseudoTueur = partie.dernierAttaquant[victime.pseudo];
  const tueur = pseudoTueur ? trouverJoueur(partie, pseudoTueur) : null;

  let resultat = {};
  if (tueur && typeof partie.regles.surKill === 'function') {
    const infosVictime = { pseudo: victime.pseudo, equipe: equipeDe(partie, victime) };
    const infosTueur = { pseudo: tueur.pseudo, equipe: equipeDe(partie, tueur) };
    const positionVictime = partie.positions[victime.pseudo] || { x: 0, z: 0 };
    resultat = partie.regles.surKill(partie, infosVictime, infosTueur, positionVictime) || {};
  }

  diffuserAPartie(partie, 'kill', {
    pseudoVictime: victime.pseudo,
    pseudoTueur: tueur ? tueur.pseudo : null,
    ...resultat
  });

  // Réapparition après le délai propre au mode, au même point de spawn qu'au début du round
  const delaiRespawn = (partie.regles.REGLES.mort && partie.regles.REGLES.mort.tempsRespawn) || 5;
  const DUREE_BOUCLIER_RESPAWN = 2; // secondes d'invulnérabilité après réapparition
  setTimeout(() => {
    if (!parties.has(partie.id)) return; // la partie (ou le round) est peut-être déjà terminée
    partie.pv[victime.pseudo] = partie.pvMax[victime.pseudo];
    partie.protegeJusqua[victime.pseudo] = Date.now() + DUREE_BOUCLIER_RESPAWN * 1000;
    envoyer(victime.ws, 'respawn', { nomSpawn: partie.spawnDe[victime.pseudo], dureeBouclier: DUREE_BOUCLIER_RESPAWN });
    diffuserAPartie(partie, 'degats', { pseudo: victime.pseudo, pv: partie.pv[victime.pseudo], pvMax: partie.pvMax[victime.pseudo] });
  }, delaiRespawn * 1000);
}

function terminerRound(partie, vainqueur) {
  partie.historiqueRounds.push(vainqueur);
  const vainqueurMatch = partie.regles.verifierVainqueurMatch(partie.historiqueRounds);

  diffuserAPartie(partie, 'finRound', { vainqueur, numeroRound: partie.numeroRound });

  if (vainqueurMatch) {
    diffuserAPartie(partie, 'finMatch', { vainqueur: vainqueurMatch });
    parties.delete(partie.id);
  } else {
    partie.numeroRound += 1;
    setTimeout(() => demarrerRound(partie), 3000); // petite pause avant le round suivant
  }
}

// --- Connexions clients ---
wss.on('connection', (ws) => {
  let joueurCourant = null;

  // Dès la connexion, on donne au client la liste des modes disponibles côté serveur —
  // c'est cette liste que le futur bouton "Mode de jeu" du menu pourra afficher.
  envoyer(ws, 'listeModes', { modes: listeModesPourMenu() });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    if (msg.type === 'rejoindreFile') {
      const pseudoDemande = String(msg.pseudo || '').trim() || `Joueur${Math.floor(Math.random() * 1000)}`;
      const pseudoFinal = pseudoUnique(pseudoDemande);

      joueurCourant = {
        ws,
        pseudo: pseudoFinal,
        personnage: msg.personnage,
        mode: msg.mode || MODE_PAR_DEFAUT, // tant que le menu n'envoie pas encore de mode
        avecBots: !!msg.avecBots,
        arriveeFile: Date.now(),
        jeton: randomBytes(16).toString('hex') // preuve d'identité pour la reconnexion (page menu -> page de jeu)
      };
      fileAttente.push(joueurCourant);

      envoyer(ws, 'jetonSession', { jeton: joueurCourant.jeton });

      if (pseudoFinal !== pseudoDemande) {
        console.log(`[matchmaking] Pseudo "${pseudoDemande}" déjà utilisé, attribué "${pseudoFinal}" à la place`);
        envoyer(ws, 'pseudoAttribue', { pseudo: pseudoFinal });
      }

      console.log(`[matchmaking] ${pseudoFinal} a rejoint la file (mode: ${joueurCourant.mode}, ${fileAttente.length} en attente au total)`);
      envoyer(ws, 'fileAttente', { position: fileAttente.length });
      tenterMatchmaking();
    }

    // La page de jeu ouvre une NOUVELLE connexion WebSocket, différente de celle du menu —
    // il faut réassocier cette connexion au bon joueur de la partie.
    if (msg.type === 'rejoindrePartie') {
      const partie = parties.get(msg.partieId);
      if (!partie) {
        console.warn(`[reco] Partie ${msg.partieId} introuvable pour ${msg.pseudo}`);
        return;
      }
      const joueur = trouverJoueur(partie, msg.pseudo);
      if (joueur && joueur.jeton && joueur.jeton === msg.jeton) {
        joueur.ws = ws;
        joueurCourant = joueur;
        console.log(`[reco] ${msg.pseudo} reconnecté à la partie ${msg.partieId}`);
      } else if (joueur) {
        console.warn(`[anti-triche] Tentative de reconnexion refusée pour "${msg.pseudo}" (jeton invalide ou manquant) — usurpation possible`);
      }
    }

    if (msg.type === 'position' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie) {
        // Écrête tout déplacement irréaliste (téléportation) avant de le mémoriser/diffuser.
        const { x, z } = positionValidee(joueurCourant.pseudo, msg.x, msg.z);
        const yaw = Number(msg.yaw) || 0; // cosmétique uniquement, pas besoin d'écrêtage
        partie.positions[joueurCourant.pseudo] = { x, z };
        [...partie.joueursA, ...partie.joueursB].forEach((j) => {
          if (j.pseudo !== joueurCourant.pseudo) {
            envoyer(j.ws, 'positionJoueur', { pseudo: joueurCourant.pseudo, x, z, yaw });
          }
        });
      }
    }

    // Un client déclare ses PV max (dépend de son build) dès qu'il rejoint la partie —
    // Un client signale où se trouvent vraiment les points de spawn de la map (coordonnées 3D
    // que le serveur n'a pas) — purement pour placer les bots correctement, sans enjeu de
    // triche : la seule conséquence possible d'un signalement farfelu est un bot mal placé.
    if (msg.type === 'signalerSpawns' && msg.nomMap && msg.spawns) {
      spawnsConnus[msg.nomMap] = { ...(spawnsConnus[msg.nomMap] || {}), ...msg.spawns };
    }

    // le serveur devient alors l'arbitre de sa vie pour tout le round. Plafonné à la vie
    // max réelle du personnage (+10%) pour empêcher un client triché de se rendre invincible.
    if (msg.type === 'declarerVie' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie) {
        const plafondVie = PLAFOND_VIE_PAR_PERSONNAGE[joueurCourant.personnage] || PLAFOND_VIE_DEFAUT;
        const vieValidee = Math.max(1, Math.min(Number(msg.vieMax) || 1, plafondVie));
        if (vieValidee !== msg.vieMax) {
          console.warn(`[anti-triche] ${joueurCourant.pseudo} (${joueurCourant.personnage}) a déclaré ${msg.vieMax} PV max, écrêtés à ${vieValidee}`);
        }
        partie.pvMax[joueurCourant.pseudo] = vieValidee;
        partie.pv[joueurCourant.pseudo] = vieValidee;
      }
    }

    // Un client signale avoir touché quelqu'un. Le serveur reste seul maître des PV réels :
    // il applique les dégâts, diffuse le nouveau total à tout le monde, et détecte lui-même
    // la mort (plus besoin qu'un client "annonce" un kill, ce qui évite les kills en double
    // ou manqués si deux joueurs touchent la même cible au même moment). Le montant est
    // d'abord plafonné au plus gros coup unique possible, PUIS écrêté sur la fenêtre glissante
    // de DPS de la seconde écoulée — ce deuxième filtre bloque le spam qui ignorerait les
    // cooldowns (le client pourrait annoncer un coup plausible individuellement, mais trop
    // souvent pour être légitime).
    if (msg.type === 'degats' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie && degatsAutorises(joueurCourant.pseudo)) {
        const cible = trouverJoueur(partie, msg.pseudoCible);
        const plafondCoup = PLAFOND_DEGATS_PAR_PERSONNAGE[joueurCourant.personnage] || PLAFOND_DEGATS_DEFAUT;
        const plafondDps = PLAFOND_DPS_PAR_PERSONNAGE[joueurCourant.personnage] || PLAFOND_DPS_DEFAUT;
        const degatsCoup = Math.max(0, Math.min(Number(msg.degats) || 0, plafondCoup));
        const degatsValides = ecreterSurFenetre(fenetresDegats, joueurCourant.pseudo, degatsCoup, plafondDps);
        if (degatsValides !== msg.degats) {
          console.warn(`[anti-triche] ${joueurCourant.pseudo} (${joueurCourant.personnage}) a annoncé ${msg.degats} dégâts, écrêtés à ${degatsValides}`);
        }
        if (cible && partie.pv[cible.pseudo] > 0) {
          const sousBouclier = partie.protegeJusqua[cible.pseudo] && Date.now() < partie.protegeJusqua[cible.pseudo];
          if (sousBouclier) return; // bouclier de réapparition actif : dégâts ignorés

          partie.pv[cible.pseudo] = Math.max(0, partie.pv[cible.pseudo] - degatsValides);
          partie.dernierAttaquant[cible.pseudo] = joueurCourant.pseudo;

          diffuserAPartie(partie, 'degats', {
            pseudo: cible.pseudo,
            pv: partie.pv[cible.pseudo],
            pvMax: partie.pvMax[cible.pseudo]
          });

          if (partie.pv[cible.pseudo] <= 0) {
            gererMort(partie, cible);
          }
        }
      }
    }

    // Un client signale avoir soigné un allié (ex : Orbe d'Énergie de la Bactérie).
    // Le serveur reste seul maître des PV réels : il applique le soin (plafonné au coup puis à
    // la fenêtre de HPS, sans dépasser pvMax) et diffuse le nouveau total avec le même message
    // 'degats' que les dégâts classiques — les clients savent déjà l'appliquer, aucun
    // changement requis là-bas.
    if (msg.type === 'soigner' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie && soinAutorise(joueurCourant.pseudo)) {
        const cible = trouverJoueur(partie, msg.pseudoCible);
        const plafondCoup = plafondSoin(joueurCourant.personnage);
        const plafondHps = PLAFOND_HPS_PAR_PERSONNAGE[joueurCourant.personnage] ?? PLAFOND_HPS_DEFAUT;
        const soinCoup = Math.max(0, Math.min(Number(msg.soin) || 0, plafondCoup));
        const soinValide = ecreterSurFenetre(fenetresSoins, joueurCourant.pseudo, soinCoup, plafondHps);
        if (soinValide !== msg.soin) {
          console.warn(`[anti-triche] ${joueurCourant.pseudo} (${joueurCourant.personnage}) a annoncé ${msg.soin} de soin, écrêté à ${soinValide}`);
        }
        if (cible && partie.pv[cible.pseudo] > 0) {
          const pvMaxCible = partie.pvMax[cible.pseudo] || 0;
          partie.pv[cible.pseudo] = Math.min(pvMaxCible, partie.pv[cible.pseudo] + soinValide);

          diffuserAPartie(partie, 'degats', {
            pseudo: cible.pseudo,
            pv: partie.pv[cible.pseudo],
            pvMax: pvMaxCible
          });
        }
      }
    }

    // Un client signale avoir étourdi/silencé un adversaire (Harpon du Scorpion, IEM du
    // Nexus...). Durée plafonnée pour éviter un blocage indéfini, et envoyée UNIQUEMENT à la
    // victime : le client ('etourdi') l'applique à lui-même sans vérifier le pseudo, donc un
    // envoi diffusé à tout le monde étourdirait tout le monde, y compris l'attaquant.
    if (msg.type === 'etourdirJoueur' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie && etourdissementAutorise(joueurCourant.pseudo)) {
        const cible = trouverJoueur(partie, msg.pseudoCible);
        const dureeValidee = Math.max(0, Math.min(Number(msg.dureeSec) || 0, PLAFOND_ETOURDISSEMENT_SEC));
        if (dureeValidee !== msg.dureeSec) {
          console.warn(`[anti-triche] ${joueurCourant.pseudo} (${joueurCourant.personnage}) a annoncé ${msg.dureeSec}s d'étourdissement, écrêté à ${dureeValidee}s`);
        }
        if (cible && partie.pv[cible.pseudo] > 0) {
          envoyer(cible.ws, 'etourdi', { dureeSec: dureeValidee, complet: !!msg.complet });
        }
      }
    }

    // Relais purement visuel (cône + flash du tir) : les dégâts, eux, arrivent séparément
    // via 'degats' et restent validés par le serveur (cf. anti-triche plus haut).
    if (msg.type === 'tir' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie) {
        [...partie.joueursA, ...partie.joueursB].forEach((j) => {
          if (j.pseudo !== joueurCourant.pseudo) {
            envoyer(j.ws, 'tir', { pseudo: joueurCourant.pseudo, origin: msg.origin, direction: msg.direction, ultimate: !!msg.ultimate });
          }
        });
      }
    }

    // Un joueur (n'importe quelle équipe) signale avoir ramassé une boule d'énergie
    // (mode "match à mort" pour l'instant). vieActuelle/vieMax viennent du client, qui est
    // seul à connaître la vraie vie du drone équipé.
    if (msg.type === 'ramasserBoule' && joueurCourant) {
      const partie = parties.get(joueurCourant.partieId);
      if (partie && typeof partie.regles.surRamasserBoule === 'function') {
        const infosRamasseur = { pseudo: joueurCourant.pseudo, equipe: equipeDe(partie, joueurCourant) };
        const resultat = partie.regles.surRamasserBoule(partie, msg.idBoule, infosRamasseur, msg.vieActuelle, msg.vieMax);
        if (resultat) {
          diffuserAPartie(partie, 'boulesRamassee', { idBoule: msg.idBoule, pseudo: joueurCourant.pseudo, ...resultat });
        }
      }
    }
  });

  ws.on('close', () => {
    fileAttente = fileAttente.filter((j) => j.ws !== ws);
    // Note : la gestion d'un joueur qui quitte en pleine partie (forfait) est à définir ensemble
  });
});
