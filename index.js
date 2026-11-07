/**
 * Serveur Node.js Unifié - Mineflayer & Bridge Roblox (Version Finale Fusionnée & Corrigée)
 *
 * PATCH LAG (cette révision) : startLiveSync() renvoyait TOUS les blocs
 * visibles (jusqu'à MAX_BLOCKS_PER_PAYLOAD) en entier à CHAQUE tick (500ms),
 * même quand rien n'avait changé depuis le tick précédent -- gonflant le
 * JSON envoyé 2x/seconde et forçant le script Lua à reboucler sur des
 * milliers de blocs déjà connus à chaque poll. Un chunk n'est désormais
 * (re)envoyé que s'il vient d'être (re)scanné ce tick, ou fait partie d'un
 * resync en attente après un (re)démarrage du script Lua (voir
 * chunksTouchedThisTick / pendingResyncChunkKeys dans startLiveSync()).
 *
 * PATCH "JE VOIS PAS LE BLOC GRASS" : scanChunkSurface() cherchait le
 * "premier bloc non-air" en descendant et l'envoyait tel quel comme surface
 * de la colonne. Or une touffe d'herbe haute, une fleur, une fougère, une
 * pousse... sont des blocs NON-AIR mais NON-SOLIDES (on marche au travers)
 * posés SUR le vrai grass_block. Le scan s'arrêtait donc sur ces décorations
 * avant d'atteindre le sol réel, et renvoyait leur nom au lieu de
 * "grass_block" -- or seuls les noms contenant "grass"/"dirt"/"stone" avaient
 * un rendu dédié côté Lua (voir createOrUpdateBlock) à l'époque de ce patch,
 * donc la plupart de ces décorations (fougère, pavot, pissenlit, buisson
 * mort...) tombaient dans le rendu de secours "couleur aléatoire". Fix : le
 * scan ignore désormais aussi tout bloc dont block.boundingBox === 'empty'
 * (API mineflayer), sauf l'eau/la lave qu'on veut garder comme "surface"
 * visible plutôt que de traverser jusqu'au fond. Voir le commentaire dans
 * scanChunkSurface().
 * NOTE (à jour) : "leaves", "log"/"wood" et "sand" ont depuis chacun leur
 * propre gabarit dédié côté Lua eux aussi (voir customLeavesBlockTemplate /
 * customWoodBlockTemplate / customSandBlockTemplate). AUCUNE whitelist n'est
 * nécessaire ici : scanChunkSurface() n'a jamais filtré par nom de bloc --
 * elle envoie déjà le nom de N'IMPORTE QUEL bloc solide trouvé (hors
 * bedrock/air/boundingBox 'empty'), c'est createOrUpdateBlock côté Lua qui
 * choisit ensuite le bon gabarit (ou le fallback) selon ce nom. Ces types de
 * blocs remontaient donc déjà à Roblox avant même l'ajout de leurs gabarits
 * dédiés -- seul leur RENDU (côté Lua) a changé, pas la remontée des données.
 *
 * PATCH "MINAGE MCPLAYER" (cette révision) : ajout du suivi isDigging pour
 * les vrais joueurs Minecraft (voir mcPlayerDiggingState / l'écouteur
 * 'block_break_animation' plus bas) -- roblox_client.lua savait déjà lire
 * mcPlayerInfo.isDigging (applyDigState), il ne manquait que cet envoi côté
 * serveur.
 *
 * PATCH "OBJETS STUDIO" (cette révision) : le script Lua permet de poser des
 * objets créés dans Roblox Studio (ServerStorage/Objets). Ce serveur les
 * mémorise désormais dans objects/placed_objects.json (persistance entre
 * redémarrages du jeu Roblox ET de ce serveur), les renvoie à Roblox au
 * (re)démarrage du script Lua (commande "sync_objects"), et expose une API
 * REST /api/objects (GET/POST/DELETE) pour poser/retirer des objets depuis
 * l'extérieur. Clé optionnelle : variable d'environnement OBJECTS_API_KEY
 * (en-tête "x-api-key"). Voir la section "2.1 OBJETS ROBLOX STUDIO".
 *
 * PATCH "MÉTÉO" (cette révision) : ajout de worldData.weather (isRaining,
 * rainLevel, thunderLevel, isThundering, biome, isSnowyBiome), calculé à
 * chaque tick de startLiveSync() à partir de l'état météo réel de mainBot
 * (mainBot.isRaining/rainState/thunderState, fournis automatiquement par
 * mineflayer) et du biome à sa position (getBiomeNameAt). Permet à
 * roblox_client.lua de reproduire le même ciel que Minecraft : nuages,
 * pluie ou neige selon le biome, et orage -- même principe que le champ
 * "time" déjà envoyé pour le cycle jour/nuit.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

// =====================================================================
// APPAREILS DES JOUEURS ROBLOX (fusion de device-handler.js)
// Le serveur Roblox envoie "Roblox-Device" (PC / Mobile / Tablet / Console /
// Gamepad / VR / Generic) a la connexion de chaque joueur puis a chaque changement.
// =====================================================================
const VALID_DEVICES = new Set(['PC', 'Mobile', 'Tablet', 'Console', 'Gamepad', 'VR', 'Generic']);

// Reglages par appareil (a ajuster). Les mobiles/tablettes/consoles/VR sont plus
// limites en performances : on peut y reduire la charge envoyee par le bridge.
const DEVICE_SETTINGS = {
  PC:      { chunkRadius: 3, pollMs: 100 },
  Tablet:  { chunkRadius: 3, pollMs: 150 },
  Gamepad: { chunkRadius: 3, pollMs: 100 },
  Console: { chunkRadius: 2, pollMs: 150 },
  Mobile:  { chunkRadius: 2, pollMs: 200 },
  VR:      { chunkRadius: 2, pollMs: 150 },
  Generic: { chunkRadius: 2, pollMs: 150 }, // appareil non reconnu : reglages prudents
};

const playerDevices = new Map(); // nomJoueur -> appareil

function handleRobloxDevice(data) {
  if (!data || typeof data.player !== 'string') return false;
  const device = VALID_DEVICES.has(data.device) ? data.device : 'PC';
  const previous = playerDevices.get(data.player);
  playerDevices.set(data.player, device);
  if (previous !== device) {
    console.log(`[Device] ${data.player}: ${previous ?? '-'} -> ${device}`);
  }
  return true;
}

function handleRobloxLeave(data) {
  if (data && typeof data.player === 'string') playerDevices.delete(data.player);
}

const getDevice = (name) => playerDevices.get(name) ?? 'PC';
const getSettings = (name) => DEVICE_SETTINGS[getDevice(name)];
const listDevices = () => Object.fromEntries(playerDevices);

// Le client Lua envoie deja un "radius" adapte a l'appareil (getDeviceChunkRadius, memes
// valeurs que DEVICE_SETTINGS : PC/Tablet/Gamepad = 3, Console/Mobile/VR = 2) et filtre
// l'affichage avec ce meme rayon par joueur. Ici on plafonne AUSSI cote Node.js (securite
// supplementaire, aucun anneau vide car Lua et Node.js sont alignes). Si vous modifiez
// DEVICE_SETTINGS, modifiez aussi la table "radii" de getDeviceChunkRadius() cote Lua.
const DEVICE_RADIUS_LIMIT_ENABLED = true;

const app = express();
app.use(express.json());

// ---------------------------------------------------------
// 1. CONFIGURATION & DOSSIERS
// ---------------------------------------------------------
const PORT = process.env.PORT || 10051;
const HOST = '0.0.0.0';

// ============================================================
// CONFIGURATION MULTI-SERVEUR
// Ajoute / retire des entrees dans SERVERS[] pour gerer
// plusieurs serveurs Minecraft en meme temps.
// Si un serveur s'arrete, le fallback passe automatiquement
// au prochain serveur online (ordre croissant d'index).
// ============================================================
const SERVERS = [
    {
        id: 'serveur_1',
        name: 'Serveur Survie',           // Affiche cote Roblox
        host: 'RFDFFFFFFFFFFFF-XDMU.aternos.me',
        port: 40415,
        version: '1.20.1',
        auth: 'offline',
        botName: 'GrokBot',
        maxPlayers: null,                // null = lu automatiquement (bot.game.maxPlayers) ; mets un nombre pour forcer la limite
        forceOffline: false,             // true = serveur mis HORS LIGNE volontairement : le bot ne s'y connecte pas, le serveur suivant affiche son monde
        enabled: true,
    },
    {
        id: 'serveur_2',
        name: 'Serveur Creatif',          // Affiche cote Roblox
        host: 'rubysmp.swiftservers.org', // RubySMP (SwiftServers) ; ancienne IP FalixNodes : 144.76.76.231:28593 (1.12.2)
        port: 25565,
        version: 'auto',                 // version inconnue : detectee automatiquement a la connexion (ou mets '1.21.1', '1.20.4'...)
        auth: 'offline',
        botName: 'GrokBot2',
        maxPlayers: null,
        forceOffline: false,
        enabled: true,                   // serveur de TROP-PLEIN : GrokBot2 rejoint ce serveur
    },
    // --- Emplacements de trop-plein supplementaires (desactives tant que host/port ne sont pas remplis) ---
    // L'ordre = priorite : serveur_1 plein -> serveur_2 -> serveur_3 -> serveur_4 -> serveur_5.
    {
        id: 'serveur_3',
        name: 'Serveur 3',
        host: 'CHANGE_MOI_3.aternos.me',   // <-- vrai host
        port: 25565,                       // <-- vrai port
        version: '1.20.4',
        auth: 'offline',
        botName: 'GrokBot3',
        maxPlayers: null,
        forceOffline: false,
        enabled: false,                    // passe a true une fois configure
    },
    {
        id: 'serveur_4',
        name: 'Serveur 4',
        host: 'CHANGE_MOI_4.aternos.me',
        port: 25565,
        version: '1.20.4',
        auth: 'offline',
        botName: 'GrokBot4',
        maxPlayers: null,
        forceOffline: false,
        enabled: false,
    },
    {
        id: 'serveur_5',
        name: 'Serveur 5',
        host: 'CHANGE_MOI_5.aternos.me',
        port: 25565,
        version: '1.20.4',
        auth: 'offline',
        botName: 'GrokBot5',
        maxPlayers: null,
        forceOffline: false,
        enabled: false,
    },
    // Maximum : 10 serveurs (MAX_SERVERS). Copie un bloc ci-dessus pour en ajouter d'autres.
];

// ---------------------------------------------------------
// LISTE DE SERVEURS DANS UN FICHIER : servers.json
// Au 1er lancement, servers.json est cree a partir de la liste ci-dessus ; ensuite c'est LUI
// qui fait foi (ajoute autant de serveurs que tu veux dedans, l'ordre = priorite de bascule :
// le 1er est le serveur principal, les suivants servent de trop-plein dans l'ordre).
// Si le fichier est illisible, la liste du code est utilisee.
// ---------------------------------------------------------
const SERVERS_FILE = path.join(__dirname, 'servers.json');

// Erreurs volontairement ignorees (bot deja deconnecte, etc.) : visibles avec DEBUG_BRIDGE=1.
function ignoreErr(e) {
    if (process.env.DEBUG_BRIDGE) console.warn('[ignore]', e && e.message ? e.message : e);
}

const MAX_SERVERS = 10;
// Copie de la liste du code (avant chargement de servers.json), pour detecter les ecarts.
// 'auto' = laisser mineflayer detecter la version du serveur (option version: false).
function mcVersionOption(v) { return (!v || String(v).toLowerCase() === 'auto') ? false : v; }
const CODE_SERVERS_DEFAULT = SERVERS.map(x => ({ id: x.id, host: x.host, port: x.port, version: x.version }));

function sanitizeServerConfig(raw, idx, usedIds) {
    if (!raw || typeof raw !== 'object') return null;
    const host = typeof raw.host === 'string' ? raw.host.trim() : '';
    if (!host || host.length > 253 || /[\s\/]/.test(host)) return null;
    let id = (typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) ? raw.id : ('serveur_' + (idx + 1));
    if (usedIds.has(id)) return null; // id deja pris
    const port = Number(raw.port);
    const botName = (typeof raw.botName === 'string' && /^[A-Za-z0-9_]{3,16}$/.test(raw.botName)) ? raw.botName : ('GrokBot' + (idx === 0 ? '' : idx + 1));
    const cfg = {
        id,
        name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name.trim().slice(0, 40) : ('Serveur ' + (idx + 1)),
        host,
        port: (Number.isInteger(port) && port > 0 && port < 65536) ? port : 25565,
        version: (typeof raw.version === 'string' && raw.version.trim()) ? raw.version.trim() : '1.20.1',
        auth: raw.auth === 'microsoft' ? 'microsoft' : 'offline',
        botName,
        maxPlayers: (Number.isInteger(raw.maxPlayers) && raw.maxPlayers > 0) ? raw.maxPlayers : null,
        forceOffline: raw.forceOffline === true,
        enabled: raw.enabled !== false,
    };
    usedIds.add(id);
    return cfg;
}

// Hotes FACTICES (jamais de vrai serveur) : le bot ne s'y connecte pas. Avant, ils "se connectaient" quand meme
// (jokers DNS Aternos) et affichaient "GrokBot2 connecte !" pour un serveur qui n'existe pas.
function isPlaceholderHost(h) {
    const x = String(h || '').toLowerCase();
    return /change_?moi/.test(x) || x === 'rfdffffffffffffff.aternos.me' || x === 'rfdfffffffffffff.aternos.me';
}
// servers.json garde les anciennes valeurs meme quand tu modifies la liste du code (il est prioritaire). Pour ces
// serveurs, si servers.json contient encore une ANCIENNE adresse connue, on la remplace par celle du code.
const STALE_SERVER_HOSTS = {
    serveur_2: ['rfdfffffffffffff.aternos.me', 'rfdffffffffffffff.aternos.me', '144.76.76.231'],
};

function saveServersFile() {
    try {
        const tmp = SERVERS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(SERVERS, null, 2));
        fs.renameSync(tmp, SERVERS_FILE);
    } catch (err) {
        console.error('[Serveurs] Erreur de sauvegarde de servers.json :', err.message);
    }
}

(function loadServersFile() {
    if (!fs.existsSync(SERVERS_FILE)) {
        saveServersFile();
        console.log('[Serveurs] servers.json cree a partir de la liste du code : modifie-le pour ajouter des serveurs.');
        return;
    }
    try {
        const list = JSON.parse(fs.readFileSync(SERVERS_FILE, 'utf8'));
        if (!Array.isArray(list)) throw new Error('un tableau JSON est attendu');
        const used = new Set();
        const cleaned = [];
        list.slice(0, MAX_SERVERS).forEach((raw, i) => {
            const cfg = sanitizeServerConfig(raw, i, used);
            if (cfg) cleaned.push(cfg); else console.warn('[Serveurs] Entree #' + (i + 1) + ' de servers.json ignoree (host manquant/invalide ou id en double).');
        });
        if (cleaned.length === 0) throw new Error('aucun serveur valide');
        SERVERS.length = 0;
        cleaned.forEach(c => SERVERS.push(c));
        console.log('[Serveurs] ' + SERVERS.length + ' serveur(s) charge(s) depuis servers.json.');
        // Migration : ancienne adresse connue dans servers.json -> adresse actuelle du code (une seule fois).
        let migrated = false;
        for (const codeCfg of CODE_SERVERS_DEFAULT) {
            const f = SERVERS.find(x => x.id === codeCfg.id);
            const stale = STALE_SERVER_HOSTS[codeCfg.id];
            if (f && stale && stale.includes(String(f.host).toLowerCase()) && f.host.toLowerCase() !== String(codeCfg.host).toLowerCase()) {
                console.log('[Serveurs] servers.json perime pour "' + codeCfg.id + '" (' + f.host + ':' + f.port + ') -> mis a jour : ' + codeCfg.host + ':' + codeCfg.port + ' (version ' + codeCfg.version + ').');
                f.host = codeCfg.host; f.port = codeCfg.port; f.version = codeCfg.version;
                migrated = true;
            }
        }
        if (migrated) saveServersFile();
        for (const codeCfg of CODE_SERVERS_DEFAULT) {
            const f = SERVERS.find(x => x.id === codeCfg.id);
            if (f && (f.host !== codeCfg.host || f.port !== codeCfg.port || f.version !== codeCfg.version)) {
                console.warn('[Serveurs] ATTENTION : servers.json (' + f.host + ':' + f.port + ' v' + f.version + ') differe du code pour "' + codeCfg.id + '" (' + codeCfg.host + ':' + codeCfg.port + ' v' + codeCfg.version + '). servers.json est prioritaire : modifie-le ou supprime-le.');
            }
        }
    } catch (err) {
        console.error('[Serveurs] servers.json illisible (' + err.message + ') : liste du code utilisee.');
    }
})();

// Compat legacy : activeServerId designe le serveur dont le monde
// est envoye a Roblox ; mis a jour automatiquement par selectActiveServer().
let activeServerId = (SERVERS.find(s => s.enabled) || SERVERS[0]).id;
function getActiveServer() { return SERVERS.find(s => s.id === activeServerId) || SERVERS[0]; }
// Getters MC_HOST / MC_PORT / MC_VERSION lus dynamiquement sur le serveur actif
Object.defineProperty(global, 'MC_HOST',    { get: () => getActiveServer().host,    configurable: true });
Object.defineProperty(global, 'MC_PORT',    { get: () => getActiveServer().port,    configurable: true });
Object.defineProperty(global, 'MC_VERSION', { get: () => getActiveServer().version, configurable: true });

// =====================================================================
// TROP-PLEIN AUTOMATIQUE (OVERFLOW)
// Quand le serveur actif est PLEIN (kick "server is full", ou joueurs en
// ligne >= places max) ou HORS LIGNE, le pont bascule tout seul sur le
// serveur suivant de SERVERS[] (serveur_2...). Les bots miroirs Rbx_ sont
// reconnectes sur le nouveau serveur et le monde affiche dans Roblox est
// remplace. Quand le serveur prioritaire a de nouveau de la place, retour
// automatique (OVERFLOW_AUTO_RETURN).
// =====================================================================
const OVERFLOW_ENABLED = true;
const OVERFLOW_CHECK_MS = 5000;           // frequence de verification des places libres
const OVERFLOW_RESERVED_SLOTS = 0;        // places a garder libres : serveur "plein" quand places libres <= cette valeur
const OVERFLOW_FULL_COOLDOWN_MS = 60000;  // un serveur marque plein le reste au moins ce temps
const OVERFLOW_AUTO_RETURN = true;        // revenir sur le serveur prioritaire quand il a de la place
const OVERFLOW_RETURN_DELAY_MS = 60000;   // ...apres avoir ete libre pendant ce temps (evite les allers-retours)

// ZONE AUTORISEE DE CASSE/POSE (memes coordonnees Minecraft x/y/z que la
// zone definie cote roblox_client.lua, voir ALLOWED_BUILD_ZONE_* la-bas).
// Garde-fou de SECURITE COTE SERVEUR, sur le meme principe que le refus de
// casser la bedrock plus bas : le client Roblox filtre deja les clics hors
// zone, mais un client trafique/bypasse pourrait envoyer une action
// "break"/"place" hors zone directement au serveur. Garde ces 6 valeurs
// synchronisees avec celles du script Lua.
const ALLOWED_BUILD_ZONE_MIN_X = -100;
const ALLOWED_BUILD_ZONE_MAX_X = 100;
const ALLOWED_BUILD_ZONE_MIN_Y = 0;
const ALLOWED_BUILD_ZONE_MAX_Y = 256;
const ALLOWED_BUILD_ZONE_MIN_Z = -100;
const ALLOWED_BUILD_ZONE_MAX_Z = 100;

// true = casse/pose AUTORISEES PARTOUT dans le monde (zone ci-dessus ignoree).
// Passe a false pour restreindre de nouveau a la zone. La protection de la
// bedrock (voir "Roblox-Action" / break) reste active dans tous les cas.
const ALLOW_BUILD_EVERYWHERE = true;

function isWithinAllowedBuildZone(x, y, z) {
    if (ALLOW_BUILD_EVERYWHERE) return true;
    return x >= ALLOWED_BUILD_ZONE_MIN_X && x <= ALLOWED_BUILD_ZONE_MAX_X
        && y >= ALLOWED_BUILD_ZONE_MIN_Y && y <= ALLOWED_BUILD_ZONE_MAX_Y
        && z >= ALLOWED_BUILD_ZONE_MIN_Z && z <= ALLOWED_BUILD_ZONE_MAX_Z;
}

const PLAYERS_DIR = path.join(__dirname, 'players');
const GAMES_DIR = path.join(__dirname, 'games');

if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });
if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

// ---------------------------------------------------------
// 2. ÉTATS GLOBAUX & VARIABLES
// ---------------------------------------------------------
let pendingCommands = [];
let liveSyncTimer = null;
let grokAntiAfkTimer = null;
// Incremente a chaque tick de startLiveSync() (voir plus bas) : permet au
// script Lua de detecter si le "sync_mineflayer_world" qu'il vient de
// recevoir est un instantane DEJA traite (le client interroge /api/poll
// toutes les 0.3s, plus vite que ce compteur n'avance a 500ms) et donc de ne
// PAS re-decoder/re-traiter en boucle le meme paquet de blocs plusieurs fois
// par seconde pour rien.
let worldSyncTick = 0;
const globalBlockSize = 16;
const plateauEnabled = true;
const plateauSize = 542;

// =====================================================================
// MOBS MINECRAFT (ajout)
// Les entites vivantes (zombies, vaches, creepers...) proches de GrokBot sont
// envoyees a Roblox dans sync_mineflayer_world.mobs, et affichees cote Lua
// (voir section 8 de roblox_client.lua). Rayon et nombre sont limites pour
// garder un payload leger (la sync part toutes les 300 ms).
// =====================================================================
const MOB_SYNC_ENABLED = true;
const MOB_SYNC_RADIUS = 48;   // blocs autour de GrokBot
const MOB_SYNC_MAX = 60;      // nombre max de mobs envoyes par sync (les plus proches d'abord)
const MOB_ENTITY_TYPES = new Set(['mob', 'hostile', 'animal', 'ambient', 'passive', 'water_creature']);
const HOSTILE_MOB_NAMES = new Set([
    'zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'creeper',
    'spider', 'cave_spider', 'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager',
    'vindicator', 'evoker', 'ravager', 'vex', 'blaze', 'ghast', 'piglin_brute', 'hoglin', 'zoglin',
    'guardian', 'elder_guardian', 'shulker', 'silverfish', 'endermite', 'warden', 'ender_dragon', 'wither'
]);

function buildMobsList(bot, centerPos) {
    if (!MOB_SYNC_ENABLED || !bot || !bot.entities || !centerPos) return [];
    const found = [];
    for (const id in bot.entities) {
        const e = bot.entities[id];
        if (!e || e === bot.entity || !e.position || !MOB_ENTITY_TYPES.has(e.type)) continue;
        const dist = e.position.distanceTo(centerPos);
        if (dist > MOB_SYNC_RADIUS) continue;
        const name = e.name || 'unknown';
        found.push({
            dist,
            mob: {
                id: e.id,
                name,
                x: Math.round(e.position.x * 100) / 100,
                y: Math.round(e.position.y * 100) / 100,
                z: Math.round(e.position.z * 100) / 100,
                yaw: Math.round((e.yaw || 0) * 100) / 100,
                w: e.width || 0.6,
                h: e.height || 1.8,
                hostile: e.type === 'hostile' || HOSTILE_MOB_NAMES.has(name)
            }
        });
    }
    found.sort((a, b) => a.dist - b.dist);
    return found.slice(0, MOB_SYNC_MAX).map(o => o.mob);
}

const CHUNK_SIZE = 16;
// Rayon de rendu (en chunks) utilise pour le centre GrokBot dans startLiveSync().
// DOIT rester aligne avec CHUNK_RENDER_RADIUS dans roblox_client.lua.
// Etait a 6 (13x13 = jusqu'a 169 chunks scannes ET envoyes en continu autour
// de GrokBot, meme quand aucun joueur n'etait a proximite) alors que le
// client, lui, ne rendait deja plus que 3 (7x7 = 49 chunks, voir le
// commentaire "ATTENTION LAG" sur CHUNK_RENDER_RADIUS cote Lua). Le serveur
// scannait et transmettait donc environ 3.4x plus de terrain que ce qui
// s'affichait reellement : scan CPU inutile + payload JSON gonfle + parsing
// cote Roblox pour des chunks jamais affiches. C'etait la cause principale
// du lag de blocs, en plus de l'absence de filtrage cote client (voir
// isChunkInBlockRange dans roblox_client.lua).
const chunkRenderDistance = 3; // aligne avec CHUNK_RENDER_RADIUS (roblox_client.lua). 4 (9x9) provoque encore trop de lag CPU/JSON : 3 (7x7) est le meilleur compromis. Remonter a 4 seulement si le terrain est trop "vide" autour des joueurs.
const grokViewEnabled = true;

// --- Anti-AFK : petit saut aleatoire de GrokBot ---
// Certains serveurs (dont Aternos) kick ou marquent un joueur "AFK" apres un
// long moment sans aucune input. GrokBot passe le plus clair de son temps a
// scanner le terrain / rester immobile pendant startLiveSync(), donc sans ca
// il finit par etre percu comme inactif. On simule une touche "espace"
// bien reelle (setControlState) a intervalle aleatoire, comme le fait deja
// le saut manuel declenche par Roblox-Action.
const GROKBOT_ANTI_AFK_ENABLED = true;
const GROKBOT_ANTI_AFK_MIN_INTERVAL_MS = 20000; // 20s
const GROKBOT_ANTI_AFK_MAX_INTERVAL_MS = 45000; // 45s
const GROKBOT_ANTI_AFK_JUMP_HOLD_MS = 350;      // duree de la touche saut maintenue (identique au saut manuel)

// =====================================================================
// ANTI-KICK (ajout)
// 1) Presence active : petites actions aleatoires (regard, coup de bras,
//    sneak, saut optionnel) sur TOUS les bots (GrokBot + bots miroirs),
//    pour eviter les kicks/marquages "AFK" et "idle".
// 2) Reconnexion intelligente : la raison du kick est analysee ; delai
//    adapte (throttle, double connexion, serveur plein, ban...) + backoff
//    exponentiel remis a zero seulement apres une connexion stable (STABLE_CONNECTION_MS).
// =====================================================================
// Interrupteur de l'anti-kick (presence active + pas anti-AFK). Actif par defaut ; coupe avec ANTI_KICK=0 ou a chaud via
// POST /api/anti-kick { "enabled": false } ; etat visible avec GET /api/anti-kick.
let antiKickEnabled = process.env.ANTI_KICK !== '0';
const antiKickActiveBots = new Set(); // etiquettes des bots qui ont l'anti-kick attache (pour le statut)
// Confirmation visible des le demarrage : l'anti-kick est ACTIF sauf si la variable d'environnement ANTI_KICK=0 le coupe.
console.log(antiKickEnabled
    ? '[AntiKick] ACTIF au demarrage (presence active + pas anti-AFK sur GrokBot). Coupure possible : ANTI_KICK=0 ou POST /api/anti-kick.'
    : '⚠️ [AntiKick] DESACTIVE au demarrage car ANTI_KICK=0 est defini dans l\'environnement. Retire cette variable ou fais POST /api/anti-kick {"enabled": true}.');
const ANTI_KICK_MIN_INTERVAL_MS = 15000; // 15s
const ANTI_KICK_MAX_INTERVAL_MS = 40000; // 40s
// ANTI-AFK PAR DEPLACEMENT : beaucoup de plugins AFK (Essentials...) ne comptent ni le regard ni le coup de bras,
// seulement un VRAI changement de position. Le bot fait donc un petit pas (~1 bloc) puis revient, toutes les 25-45 s.
// Seulement pour GrokBot / GrokBot2 (les bots miroirs Rbx_ suivent le joueur Roblox et ne doivent pas bouger seuls).
// Desactivable : ANTI_AFK_WALK=0.
const ANTI_AFK_WALK_ENABLED = process.env.ANTI_AFK_WALK !== '0';
const ANTI_AFK_WALK_MIN_INTERVAL_MS = 25000;
const ANTI_AFK_WALK_MAX_INTERVAL_MS = 45000;
// Distance de l'aller-retour (en blocs) : ANTI_AFK_WALK_BLOCKS=1..6 (defaut 3). Plus c'est grand, plus le mouvement est net pour les plugins AFK.
const ANTI_AFK_WALK_BLOCKS = Math.max(1, Math.min(6, parseInt(process.env.ANTI_AFK_WALK_BLOCKS, 10) || 3));
// Premier pas rapide apres la connexion (avant : 25-45 s, trop tard si le serveur coupe le bot avant).
const ANTI_AFK_WALK_FIRST_MIN_MS = 10000;
const ANTI_AFK_WALK_FIRST_MAX_MS = 18000;
const RECONNECT_BASE_DELAY_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 60000;
// Une connexion n'est consideree comme reussie (backoff remis a zero) que si elle a dure au moins ce temps.
// Avant : remise a zero des le spawn => un serveur qui expulse juste apres l'apparition etait reconnecte toutes les 5 s.
const STABLE_CONNECTION_MS = 60000;
// ANTI-SPAM "GrokBot2 left the game" : chaque deconnexion du bot est annoncee a tout le serveur ("left the game" puis "joined the game"
// a la reconnexion). Quand la connexion est coupee AVANT STABLE_CONNECTION_MS apres l'apparition (session courte), la reconnexion est
// repoussee de plus en plus : 60 s, 2 min, 4 min, 8 min, puis 10 min maximum. Une session stable (>= 60 s) remet le compteur a zero.
// Le message "<bot> connecte !" dans le chat n'est aussi envoye qu'apres une session stable. Desactivable : RECONNECT_SPAM_GUARD=0.
const RECONNECT_SPAM_GUARD = process.env.RECONNECT_SPAM_GUARD !== '0';
const SHORT_SESSION_BASE_DELAY_MS = 60000;
const SHORT_SESSION_MAX_DELAY_MS = 600000;
function shortSessionDelayMs(count) {
    if (!count || count < 1) return 0;
    return Math.min(SHORT_SESSION_BASE_DELAY_MS * Math.pow(2, count - 1), SHORT_SESSION_MAX_DELAY_MS);
}
// DISTANCE DE VUE PROGRESSIVE : demander 24-32 chunks des la connexion fait envoyer des milliers de chunks d'un coup ;
// beaucoup de serveurs / proxies / anti-bots coupent alors le socket quelques secondes apres l'apparition (ECONNRESET
// sans aucun message). Le bot demande donc peu au depart puis monte par paliers une fois la connexion installee.
const BOT_INITIAL_VIEW_DISTANCE = Math.max(2, Math.min(32, parseInt(process.env.BOT_INITIAL_VIEW_DISTANCE, 10) || 6));
const BOT_VIEW_RAMP_START_MS = 20000; // attente avant le premier palier
const BOT_VIEW_RAMP_STEP_MS = 15000;  // attente entre deux paliers
const playerBotKickDelay = new Map(); // robloxUsername -> delai minimum impose par la derniere raison de kick

// Extrait un texte lisible d'une raison de kick (string, JSON chat, objet).
function kickReasonToText(reason) {
    if (reason == null) return '';
    let r = reason;
    if (typeof r === 'string') {
        try { r = JSON.parse(r); } catch (e) { return r; }
    }
    const parts = [];
    (function walk(n) {
        if (n == null) return;
        if (typeof n === 'string') { parts.push(n); return; }
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n === 'object') {
            if (typeof n.text === 'string') parts.push(n.text);
            if (typeof n.translate === 'string') parts.push(n.translate);
            if (n.value !== undefined) walk(n.value);
            if (n.with) walk(n.with);
            if (n.extra) walk(n.extra);
        }
    })(r);
    return parts.join(' ').trim() || JSON.stringify(r);
}

// Kick typique d'un serveur en mode ONLINE (premium) quand le bot se connecte en auth 'offline'.
function isOnlineModeKickText(text) {
    return /unverified|invalid session|failed to verify|authentication|not authenticated|online.?mode|premium|session\b.*(expired|invalid)|multiplayer\.disconnect\.(unverified|authservers)/i.test(text || '');
}

// Delai minimum avant reconnexion selon la raison du kick.
function kickReconnectDelayMs(text) {
    const t = (text || '').toLowerCase();
    if (/throttl|too fast|wait before reconnect/.test(t)) return 15000;
    if (/already (logged|connected|online)|duplicate|same username|logged in from another/.test(t)) return 30000;
    if (isOnlineModeKickText(t)) return RECONNECT_MAX_DELAY_MS; // compte premium requis : reconnecter en boucle ne sert a rien
    if (/\bbanned\b|\bban\b|\bbanni/.test(t)) return RECONNECT_MAX_DELAY_MS * 2;
    if (/whitelist|white-listed|liste blanche/.test(t)) return RECONNECT_MAX_DELAY_MS;
    // Version incompatible ("Outdated server! I'm still on 1.12.2", "Outdated client") : reconnecter ne change rien.
    if (/outdated|incompatible|unsupported|use (minecraft|version)|please (use|update)|multiplayer\.disconnect\.(outdated|incompatible)/.test(t)) return RECONNECT_MAX_DELAY_MS;
    // Paquet de mouvement invalide (NaN) : bug cote client, pas une sanction -> simple backoff normal.
    if (/invalid[ _]move[ _]player|invalid_player_movement/.test(t)) return 0;
    // Spam / vol / triche / paquets invalides : le serveur s'est fache, on laisse un peu de temps.
    if (/spam|flood|flying|\bfly\b|hack|cheat|illegal|invalid (move|packet|player)|moved too (quickly|wrongly)|kicked for/.test(t)) return 30000;
    if (/time(d)? ?out|keep ?alive|lost connection|internal exception/.test(t)) return 10000;
    if (/server_full|\bfull\b|maximum|max players/.test(t)) return 20000;
    if (/\bafk\b|\bidle\b|inactiv/.test(t)) return 8000;
    return 0;
}

function reconnectBackoffMs(attempt) {
    return Math.min(RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)), RECONNECT_MAX_DELAY_MS);
}

// Attache la presence active a un bot ; s'arrete tout seul sur 'end'.
// opts.jump : autorise un saut (GrokBot a deja son propre saut anti-AFK ;
// les bots miroirs ne sautent pas pour ne pas se desynchroniser du joueur).
// Aller-retour de ANTI_AFK_WALK_BLOCKS blocs (deplacement net nul). Les 4 directions cardinales sont essayees dans un ordre
// aleatoire : on prend la premiere dont TOUT le trajet est sur (air libre aux pieds et a la tete, sol solide non dangereux,
// 1 bloc de marge). Retourne false si aucune ne convient, si le bot n'est pas apparu, dort, est monte ou occupe
// (pathfinder / minage / deja en train de marcher) : on reessaiera au prochain passage.
function antiAfkWalkStep(bot) {
    if (!bot || !bot.entity) return false;
    if (bot.targetDigBlock || bot.isSleeping || bot.vehicle) return false;
    if (bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving()) return false;
    const cs = bot.controlState || {};
    if (cs.forward || cs.back || cs.left || cs.right) return false; // deja en mouvement (action Roblox, saut manuel...)
    const p = bot.entity.position;
    const n = ANTI_AFK_WALK_BLOCKS;
    const free = (b) => b && b.boundingBox === 'empty' && !isLiquidBlockName(b.name);
    const DANGEROUS = /cactus|magma|campfire|fire|lava|water|pressure_plate|trap|berry|web|sand$/i;
    const dirs = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    for (const d of dirs) {
        const yaw = d * (Math.PI / 2);
        const dx = Math.round(-Math.sin(yaw)), dz = Math.round(-Math.cos(yaw)); // direction avant de mineflayer (entiers : pas d'erreur d'arrondi sur floor)
        let ok = true;
        for (let i = 1; i <= n + 1 && ok; i++) {
            const at = (dy) => bot.blockAt(p.offset(dx * i, dy, dz * i));
            const feet = at(0), head = at(1), floor = at(-1);
            if (!free(feet) || !free(head)) ok = false;
            else if (!floor || floor.boundingBox !== 'block' || DANGEROUS.test(floor.name || '')) ok = false;
        }
        if (!ok) continue;
        const outMs = Math.round(n * 240); // ~4,3 blocs/s a pied
        Promise.resolve(bot.look(yaw, 0, true)).catch(() => {}).then(() => {
            try {
                bot.setControlState('forward', true);
                setTimeout(() => {
                    try { bot.setControlState('forward', false); bot.setControlState('back', true); } catch (e) { ignoreErr(e); }
                }, outMs);
                setTimeout(() => { try { bot.setControlState('back', false); } catch (e) { ignoreErr(e); } }, outMs * 2 + 40);
            } catch (e) { ignoreErr(e); }
        });
        return true;
    }
    return false;
}

function attachAntiKick(bot, label, opts = {}) {
    if (!bot) return;
    antiKickActiveBots.add(label);
    console.log('[AntiKick] ' + (antiKickEnabled ? 'ACTIF' : 'attache mais DESACTIVE (ANTI_KICK=0)') + ' : ' + label + (opts.walk && ANTI_AFK_WALK_ENABLED ? ' (+ pas anti-AFK)' : ''));
    const allowJump = !!opts.jump;
    let timer = null;
    let stopped = false;

    let walkTimer = null;
    const stop = () => {
        stopped = true;
        antiKickActiveBots.delete(label);
        if (timer) { clearTimeout(timer); timer = null; }
        if (walkTimer) { clearTimeout(walkTimer); walkTimer = null; }
    };
    bot.once('end', stop);

    // Pas anti-AFK (deplacement reel), sur sa propre minuterie.
    if (opts.walk && ANTI_AFK_WALK_ENABLED) {
        const nextWalk = () => ANTI_AFK_WALK_MIN_INTERVAL_MS + Math.random() * (ANTI_AFK_WALK_MAX_INTERVAL_MS - ANTI_AFK_WALK_MIN_INTERVAL_MS);
        let firstWalkLogged = false;
        const walkTick = () => {
            if (stopped) return;
            let done = false;
            try {
                done = antiKickEnabled ? antiAfkWalkStep(bot) : true;
                if (done && antiKickEnabled && !firstWalkLogged) { firstWalkLogged = true; console.log('[AntiAFK][' + label + '] premier pas anti-AFK effectue (' + ANTI_AFK_WALK_BLOCKS + ' blocs aller-retour).'); }
            } catch (e) { console.log('⚠️ [AntiAFK][' + label + '] ' + e.message); }
            walkTimer = setTimeout(walkTick, done ? nextWalk() : 5000); // pas non fait : on retente vite
        };
        walkTimer = setTimeout(walkTick, ANTI_AFK_WALK_FIRST_MIN_MS + Math.random() * (ANTI_AFK_WALK_FIRST_MAX_MS - ANTI_AFK_WALK_FIRST_MIN_MS));
    }

    const tick = () => {
        if (stopped) return;
        try {
            const moving = bot.pathfinder && typeof bot.pathfinder.isMoving === 'function' && bot.pathfinder.isMoving();
            if (antiKickEnabled && bot.entity && !moving) {
                const roll = Math.random();
                if (roll < 0.45) {
                    // regard aleatoire (yaw complet, pitch modere)
                    const yaw = Math.random() * Math.PI * 2;
                    const pitch = (Math.random() - 0.5) * 0.8;
                    Promise.resolve(bot.look(yaw, pitch, false)).catch(() => {});
                } else if (roll < 0.75) {
                    bot.swingArm('right');
                } else if (roll < 0.9 || !allowJump) {
                    bot.setControlState('sneak', true);
                    setTimeout(() => { try { bot.setControlState('sneak', false); } catch (e) { ignoreErr(e); } }, 400 + Math.random() * 400);
                } else {
                    bot.setControlState('jump', true);
                    setTimeout(() => { try { bot.setControlState('jump', false); } catch (e) { ignoreErr(e); } }, GROKBOT_ANTI_AFK_JUMP_HOLD_MS);
                }
            }
        } catch (e) {
            console.log('⚠️ [AntiKick][' + label + '] ' + e.message);
        }
        timer = setTimeout(tick, ANTI_KICK_MIN_INTERVAL_MS + Math.random() * (ANTI_KICK_MAX_INTERVAL_MS - ANTI_KICK_MIN_INTERVAL_MS));
    };
    timer = setTimeout(tick, ANTI_KICK_MIN_INTERVAL_MS + Math.random() * (ANTI_KICK_MAX_INTERVAL_MS - ANTI_KICK_MIN_INTERVAL_MS));
}


// GARDE-FOU "Invalid move player packet received" : le serveur Minecraft expulse tout client dont un paquet de
// position / regard contient NaN ou une valeur infinie (multiplayer.disconnect.invalid_player_movement). Ca arrive
// quand l'etat interne du bot est corrompu (ex. mineflayer trop ancien pour la version du serveur apres un paquet de
// teleportation, regard calcule avec NaN...). On filtre donc les paquets sortants : un paquet invalide n'est JAMAIS
// envoye, et l'etat du bot est remis au dernier etat valide connu. Les appels look()/lookAt() avec NaN sont ignores.
function guardInvalidMovePackets(bot, label) {
    const client = bot && bot._client;
    if (!client || client.__moveGuard || typeof client.write !== 'function') return;
    client.__moveGuard = true;
    const origWrite = client.write;
    const GUARDED = new Set(['position', 'position_look', 'look', 'vehicle_move']);
    const NUM_FIELDS = ['x', 'y', 'z', 'feetY', 'stance', 'yaw', 'pitch'];
    let good = null;          // dernier etat valide de l'entite (radians)
    let blocked = 0, lastLog = 0;
    const entityOk = (e) => e && e.position && Number.isFinite(e.position.x) && Number.isFinite(e.position.y)
        && Number.isFinite(e.position.z) && Number.isFinite(e.yaw) && Number.isFinite(e.pitch);

    client.write = function (name, params) {
        if (params && GUARDED.has(name)) {
            let bad = false;
            for (const f of NUM_FIELDS) {
                if (typeof params[f] === 'number' && !Number.isFinite(params[f])) { bad = true; break; }
            }
            if (bad) {
                blocked++;
                const now = Date.now();
                if (now - lastLog > 5000) {
                    lastLog = now;
                    console.log('⚠️ [GardeMouvement][' + label + '] paquet "' + name + '" invalide BLOQUE ('
                        + NUM_FIELDS.filter(f => f in params).map(f => f + '=' + params[f]).join(' ')
                        + ') : etat du bot restaure. Total bloques : ' + blocked + '. Si ca se repete, mets mineflayer a jour (npm update mineflayer minecraft-protocol).');
                }
                try {
                    const e = bot.entity;
                    if (e) {
                        if (good) { e.position.set(good.x, good.y, good.z); e.yaw = good.yaw; e.pitch = good.pitch; }
                        else {
                            if (!Number.isFinite(e.yaw)) e.yaw = 0;
                            if (!Number.isFinite(e.pitch)) e.pitch = 0;
                        }
                        if (e.velocity) e.velocity.set(0, 0, 0);
                    }
                } catch (err) { ignoreErr(err); }
                return; // paquet non envoye
            }
            const e = bot.entity;
            if (entityOk(e)) good = { x: e.position.x, y: e.position.y, z: e.position.z, yaw: e.yaw, pitch: e.pitch };
        }
        return origWrite.apply(this, arguments);
    };

    if (typeof bot.look === 'function') {
        const origLook = bot.look;
        bot.look = function (yaw, pitch) {
            if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return Promise.resolve();
            return origLook.apply(this, arguments);
        };
    }
    if (typeof bot.lookAt === 'function') {
        const origLookAt = bot.lookAt;
        bot.lookAt = function (point) {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) return Promise.resolve();
            return origLookAt.apply(this, arguments);
        };
    }
}

// --- Scan de terrain reel sur toute la zone de rendu (chunks visibles) ---
// Un scan volumetrique complet (toutes les couches Y) sur 6 chunks de rayon
// (13x13 = jusqu'a 169 chunks, ~43000 colonnes) figerait le bot MC s'il etait
// fait d'un coup. On scanne donc la SURFACE de chaque colonne (comme une
// heightmap : premier bloc solide rencontre), et on etale le travail sur
// plusieurs ticks (chargement progressif, comme Minecraft charge ses chunks).
const SURFACE_SCAN_UP = 8;          // studs au-dessus de GrokBot ou l'on commence a chercher (marge pour les reliefs proches)
const SURFACE_SCAN_DOWN = 24;       // studs en-dessous de GrokBot ou l'on s'arrete de chercher (capte les vallees)
// Etait a 2 : avec un rayon 2 (5x5 = 25 chunks) + plusieurs centres (GrokBot,
// joueurs Roblox, MCPlayers), la file grossissait plus vite qu'elle ne se
// vidait → terrain vide pendant de longues secondes autour d'un joueur qui
// venait d'arriver / de changer de zone. 4 reste leger (scan surface only)
// et divise par ~2 le temps de premier remplissage.
const MAX_CHUNK_SCANS_PER_TICK = 12; // nombre de chunks scannes par tick (rayon 3 => file plus petite ; 12 reste leger et remplit vite)
const MAX_CACHED_CHUNKS = 900;      // limite memoire : au-dela, les chunks les plus eloignes de TOUS les centres actifs (GrokBot + joueurs) sont evinces. Relevee de 400 a 900 car plusieurs joueurs eloignes peuvent desormais chacun avoir leur propre rayon de chunks actif en meme temps.
// =====================================================================
// RENDU LOINTAIN 512x512 (LOD) -- AJOUT
// Le terrain detaille (blocs 1 par 1) reste limite a chunkRenderDistance
// (7x7 chunks) : en afficher 512x512 blocs (32x32 = 1024 chunks, ~260 000
// colonnes) en vrais blocs est impossible cote Roblox. A la place, chaque
// chunk de la zone 512x512 autour de CHAQUE centre actif (GrokBot, joueurs
// Roblox, MCPlayers) est resume par UNE entree {chunkX, chunkZ, y, name}
// (hauteur moyenne de 4 colonnes echantillonnees + bloc de surface le plus
// frequent). roblox_client.lua en fait une seule dalle coloree par chunk
// (FarRender), masquee des que le chunk detaille correspondant est charge.
// Limite : seuls les chunks CHARGES par le bot Mineflayer sont lisibles
// (viewDistance du serveur MC) ; les autres sont retentes toutes les
// FAR_RETRY_MS, sans bloquer le scan des chunks proches.
// =====================================================================
const FAR_RENDER_ENABLED = true;
// DISTANCE DE RENDU LOINTAINE (rayon en chunks autour de chaque centre). Reglable SANS toucher au code :
//   FAR_RENDER_RADIUS_CHUNKS=32 node index.js   (defaut 32 = 1040 blocs de cote = MAXIMUM ~1,04 km ; borne [4, 32])
// 10,56 km (660 chunks de rayon, ~1,7 million de chunks) est IMPOSSIBLE : le bot ne recoit que les chunks que le
// serveur Minecraft envoie (view-distance de server.properties, 32 maximum) et Roblox ne supporterait pas autant de Parts.
// IMPORTANT : mets aussi `view-distance` du serveur MC (server.properties) a la meme valeur, sinon les chunks
// au-dela de sa limite ne sont jamais recus (ils sont retentes sans fin toutes les FAR_RETRY_MS).
const FAR_RENDER_MAX_RADIUS_CHUNKS = 32;
const FAR_RENDER_RADIUS_CHUNKS = Math.max(4, Math.min(FAR_RENDER_MAX_RADIUS_CHUNKS,
    parseInt(process.env.FAR_RENDER_RADIUS_CHUNKS, 10) || 32));                // 32 (MAXIMUM) => 65x65 chunks autour de chaque centre
const FAR_RENDER_AREA_BLOCKS = (FAR_RENDER_RADIUS_CHUNKS * 2 + 1) * CHUNK_SIZE; // cote de la zone lointaine (en blocs)
console.log('[Rendu lointain] rayon ' + FAR_RENDER_RADIUS_CHUNKS + ' chunks = ' + FAR_RENDER_AREA_BLOCKS + ' blocs de cote (~' + (FAR_RENDER_AREA_BLOCKS / 1000).toFixed(2) + ' km). Pense a regler view-distance du serveur MC a ' + FAR_RENDER_RADIUS_CHUNKS + ' ou plus.');
const FAR_SCANS_PER_TICK = 14;          // chunks lointains resumes par tick (4 colonnes chacun : tres leger)
const FAR_SAMPLE_OFFSETS = [4, 12];     // 2x2 colonnes echantillonnees par chunk
const FAR_SCAN_UP = 64;                 // fenetre verticale de recherche de surface autour de l'altitude de reference
const FAR_SCAN_DOWN = 64;
const FAR_RETRY_MS = 10000;             // delai avant de retenter un chunk non charge cote bot
const FAR_MAX_ENTRIES_PER_PAYLOAD = 400;
const FAR_REDUNDANT_TICKS = 3;          // un chunk modifie est renvoye pendant N ticks : un sync_mineflayer_world non lu est ecrase par le suivant (voir queueCommand)
const MAX_CACHED_FAR_CHUNKS = Math.max(2600, Math.ceil(Math.pow(FAR_RENDER_RADIUS_CHUNKS * 2 + 1, 2) * 1.5)); // au moins 1,5 zone
const farChunkCache = new Map();        // "cx_cz" -> { chunkX, chunkZ, y, name } | { empty: true }
const farScanQueue = [];
const farScanQueued = new Set();
const farScanY = new Map();             // "cx_cz" -> altitude de reference
const farRetryAt = new Map();           // "cx_cz" -> timestamp avant lequel on ne retente pas
const farDirtyUntil = new Map();        // "cx_cz" -> dernier tick (farTick) ou l'entree est encore renvoyee
const pendingFarResyncKeys = new Set(); // chunks a (re)envoyer (demarrage Lua, nouvellement visibles, depassement de payload)
let previousFarVisibleKeys = new Set();
let farTick = 0;
const MAX_BLOCKS_PER_PAYLOAD = 4000; // limite de securite JSON (rayon 3 : ~3500 blocs surface max ; 4000 laisse de la marge sans saturer le poll)

// --- Skins des MCPlayer ---
// Chaque entree de mcPlayersList envoyee a Roblox porte maintenant un champ
// "skin" (voir plus bas, mcPlayersList.push). Cote Lua (roblox_client.lua),
// la table MC_PLAYER_SKIN_IDS fait correspondre cette cle a un asset id
// Roblox precis a charger via InsertService:LoadAsset. Un joueur absent de
// MC_PLAYER_SKIN_BY_NAME recoit DEFAULT_MC_PLAYER_SKIN ("default").
// Pour donner un skin different a un joueur MC en particulier, ajoute une
// ligne ici (cle = pseudo Minecraft en minuscules, valeur = cle presente
// dans MC_PLAYER_SKIN_IDS cote Lua).
const DEFAULT_MC_PLAYER_SKIN = 'default';
const MC_PLAYER_SKIN_BY_NAME = {
    // 'nomdujoueurminecraft': 'steve',
};

function getSkinForMcPlayer(playerName) {
    const forced = MC_PLAYER_SKIN_BY_NAME[(playerName || '').toLowerCase()];
    return forced || DEFAULT_MC_PLAYER_SKIN;
}

// --- Météo & biome (NOUVEAU) : nuages/pluie/orage/neige envoyés à Roblox ---
// Biomes "enneigés" (noms 1.18+ ET quelques anciens noms au cas où le
// serveur Aternos tournerait sur une version qui les utilise encore) : sert
// à distinguer "il pleut" (vraie pluie) de "il neige" (même pluie MC, mais
// dans un biome froid -> Minecraft affiche de la neige, pas de la pluie).
const SNOWY_BIOME_NAMES = new Set([
    'snowy_plains', 'snowy_tundra', 'ice_spikes', 'snowy_taiga',
    'snowy_taiga_hills', 'snowy_taiga_mountains', 'snowy_mountains',
    'snowy_beach', 'snowy_slopes', 'frozen_peaks', 'jagged_peaks',
    'grove', 'frozen_river', 'frozen_ocean', 'deep_frozen_ocean',
    'ice_plains', 'ice_plains_spikes', 'ice_mountains', 'cold_taiga',
    'cold_taiga_hills', 'cold_taiga_mountains', 'cold_ocean',
    'deep_cold_ocean'
]);

function isSnowyBiomeName(biomeName) {
    return !!biomeName && SNOWY_BIOME_NAMES.has(biomeName);
}

// Lit le nom du biome réel à une position donnée (via l'API mineflayer/
// prismarine-block : block.biome est résolu paresseusement et peut être
// absent selon la version/l'état du chunk, d'où les multiples filets de
// sécurité). Retourne null si indéterminable plutôt que de planter le tick
// de synchro en cours (voir appel dans startLiveSync).
function getBiomeNameAt(botInstance, position) {
    if (!botInstance || !position) return null;
    try {
        const block = botInstance.blockAt(position);
        if (!block) return null;
        if (block.biome && block.biome.name) return block.biome.name;
        const biomeId = (typeof block.biome === 'number') ? block.biome
            : (typeof block.biomeId === 'number') ? block.biomeId
            : null;
        if (biomeId !== null) {
            const mcData = require('minecraft-data')(botInstance.version);
            const biomeData = mcData && mcData.biomes ? mcData.biomes[biomeId] : null;
            if (biomeData && biomeData.name) return biomeData.name;
        }
    } catch (err) {
        return null;
    }
    return null;
}

// --- Correspondance Outil Roblox -> Item Minecraft (NOUVEAU) ---
// Quand un joueur Roblox clique/active un Tool dans son inventaire,
// bindCharacterActions (roblox_client.lua) envoie deja action="attack" avec
// un champ tool = NomDuTool. Ce champ etait recu ici (voir le destructuring
// du payload plus bas) mais jamais exploite : le bot miroir Rbx_XXX frappait
// donc toujours a mains nues, quel que soit l'objet visuellement equipe cote
// Roblox. Cle = nom EXACT de l'Instance Tool cote Roblox, valeur = nom
// d'item Minecraft (celui utilise par mineflayer/minecraft-data, ex.
// 'diamond_sword', 'wooden_axe', 'wooden_pickaxe'...). Un Tool absent de
// cette table, ou un item absent de l'inventaire MC du bot, n'empeche pas
// l'attaque : le bot frappe simplement avec ce qu'il tient deja en main.
const ROBLOX_TOOL_TO_MC_ITEM = {
    // 'Epee': 'diamond_sword',
    // 'Hache': 'wooden_axe',
    // 'Pioche': 'wooden_pickaxe',
};

function getMcItemForRobloxTool(toolName) {
    if (!toolName) return null;
    return ROBLOX_TOOL_TO_MC_ITEM[toolName] || null;
}

// Equipe (si possible) l'item MC correspondant au Tool Roblox actif, puis
// frappe dans tous les cas (l'attaque ne doit jamais rester bloquee par un
// echec d'equip : item manquant en inventaire, erreur reseau MC, etc.).
// Si targetPlayerName est fourni (joueur Roblox qui a clique sur un
// MCPlayer, voir attachMcPlayerAttackHandler cote roblox_client.lua), on
// cherche la VRAIE entite du joueur Minecraft correspondant et on demande a
// mineflayer de la viser + de la frapper (playerBot.attack), au lieu d'un
// simple swingArm dans le vide qui ne faisait aucun degat reel avant ce
// patch.
function equipToolThenAttack(playerBot, toolName, playerLabel, targetPlayerName) {
    const mcItemName = getMcItemForRobloxTool(toolName);

    const doSwingOrAttack = () => {
        let targetEntity = null;
        if (targetPlayerName && mainBot && mainBot.players && mainBot.players[targetPlayerName]) {
            targetEntity = mainBot.players[targetPlayerName].entity || null;
        }

        if (targetEntity) {
            try {
                // Se tourner vers la cible avant de frapper : plus fiable pour
                // que mineflayer/le serveur MC valide le coup comme "a portee
                // et dans le bon axe" plutot qu'un swing generique.
                playerBot.lookAt(targetEntity.position.offset(0, targetEntity.height ? targetEntity.height * 0.5 : 1, 0), true)
                    .catch(() => {})
                    .finally(() => {
                        try {
                            playerBot.attack(targetEntity);
                        } catch (err) {
                            console.log(`[Bridge] Echec attack() sur ${targetPlayerName} pour ${playerLabel} :`, err.message);
                            playerBot.swingArm('mainhand');
                        }
                    });
            } catch (err) {
                console.log(`[Bridge] Erreur attaque ciblee de ${playerLabel} sur ${targetPlayerName} :`, err.message);
                playerBot.swingArm('mainhand');
            }
        } else {
            // Pas de cible (clic dans le vide, ou joueur MC deja deconnecte /
            // hors de la tab-list au moment ou l'action arrive) : on garde
            // l'ancien comportement, un simple coup dans le vide.
            playerBot.swingArm('mainhand');
        }
    };

    if (!mcItemName) {
        doSwingOrAttack();
        return;
    }
    try {
        const invItem = playerBot.inventory.items().find(i => i.name === mcItemName);
        if (!invItem) {
            // Le bot n'a pas cet objet dans son inventaire MC actuel : on ne
            // bloque pas l'action, on frappe avec ce qui est deja en main.
            doSwingOrAttack();
            return;
        }
        playerBot.equip(invItem, 'hand')
            .catch(err => {
                console.log(`[Bridge] Impossible d'equiper ${mcItemName} pour ${playerLabel} (tool Roblox: ${toolName}) :`, err.message);
            })
            .finally(() => {
                doSwingOrAttack();
            });
    } catch (err) {
        console.log(`[Bridge] Erreur equip/attack pour ${playerLabel} :`, err.message);
        doSwingOrAttack();
    }
}

const activeBots = new Map();
// Anti-spam du chat Roblox -> Minecraft (Minecraft expulse pour spam) : dernier message par joueur Roblox.
const playerChatLastAt = new Map();
const PLAYER_CHAT_MIN_INTERVAL_MS = 1000;
const PLAYER_CHAT_MAX_LENGTH = 200;
// FIX COLLISION Rbx_XXX : deux pseudos Roblox distincts peuvent donner le
// meme resultat une fois nettoyes (caracteres non alphanumeriques retires)
// ET tronques a 12 caracteres (ex: "Herodyc_2025!!" et "Herodyc_2025???"
// donneraient tous les deux "Rbx_Herodyc_2025" -> tronque en "Rbx_Herodyc_2"
// pour les deux). Sans verification, le second bot se connecterait sous le
// MEME pseudo Minecraft que le premier (deconnexion/reconnexion en boucle
// des deux cotes, LiveBot du mauvais joueur affiche, etc). On retient donc
// les pseudos MC actuellement utilises par un bot miroir, et on desambiguise
// via un suffixe numerique en cas de collision (voir buildUniqueMcUsername).
const activeMcUsernames = new Set();
// [robloxUsername] = mcUsername effectivement attribue, pour le liberer de
// activeMcUsernames a la deconnexion meme si le calcul de cleanName changerait.
const playerBotMcUsernames = new Map();
let mainBot = null;

// ============================================================
// ETAT MULTI-SERVEUR
// Un ServerState par entree SERVERS[], indexe par server.id.
// ============================================================
const serverStates = new Map(); // id -> { config, bot, liveSyncTimer, antiAfkTimer,
                                //          worldSyncTick, worldData, pendingCmds }

function createServerState(srv) {
        serverStates.set(srv.id, {
            config: srv,
            bot: null,
            liveSyncTimer: null,
            antiAfkTimer: null,
            worldSyncTick: 0,
            worldData: {
                command: 'sync_mineflayer_world',
                syncTick: 0,
                serverName: srv.name,
                serverId: srv.id,
                serverOnline: false,
                botName: srv.botName,
                x: 0, y: 64, z: 0,
                blockSize: globalBlockSize,
                plateauEnabled, plateauSize,
                zones: [], blocks: [], bots: [],
                minecraftPlayers: [], chats: []
            },
            pendingCmds: [],
            forcedOffline: !!srv.forceOffline, // mis hors ligne a la main (config ou API)
            full: false,        // overflow : serveur plein
            fullReason: '',
            fullSince: 0,
            okSince: 0,         // overflow : depuis quand il est en ligne ET non plein
            reconnectAttempts: 0,
            kickDelayMs: 0,
        });
}

function initServerStates() {
    for (const srv of SERVERS) {
        if (srv.enabled) createServerState(srv);
    }
}

// Ajoute un serveur a chaud (et le memorise dans servers.json). Retourne { server } ou { error }.
function addServerRuntime(raw) {
    if (SERVERS.length >= MAX_SERVERS) return { error: 'Limite atteinte (' + MAX_SERVERS + ' serveurs)' };
    const used = new Set(SERVERS.map(x => x.id));
    const cfg = sanitizeServerConfig(raw, SERVERS.length, used);
    if (!cfg) return { error: 'Serveur invalide (host requis, id unique)' };
    SERVERS.push(cfg);
    saveServersFile();
    if (cfg.enabled) {
        createServerState(cfg);
        if (!cfg.forceOffline) connectServer(cfg.id);
    }
    console.log('[Serveurs] Serveur ajoute : [' + cfg.id + '] ' + cfg.name + ' -> ' + cfg.host + ':' + cfg.port);
    return { server: cfg };
}

// Retire un serveur a chaud : on le deconnecte (le suivant prend la main si c'etait l'actif).
function removeServerRuntime(id) {
    const idx = SERVERS.findIndex(x => x.id === id);
    if (idx === -1) return { error: 'Serveur inconnu' };
    if (SERVERS.length <= 1) return { error: 'Impossible de retirer le dernier serveur' };
    if (serverStates.has(id)) setServerForcedOffline(id, true); // deconnecte le bot et relance la selection
    setTimeout(() => {
        serverStates.delete(id);
        const i = SERVERS.findIndex(x => x.id === id);
        if (i !== -1) SERVERS.splice(i, 1);
        saveServersFile();
        if (activeServerId === id) {
            const next = SERVERS.find(x => serverStates.has(x.id));
            if (next) activeServerId = next.id;
            selectActiveServer('removed');
            mainBot = (serverStates.get(activeServerId) || {}).bot || null;
        }
        console.log('[Serveurs] Serveur retire : ' + id);
    }, 1000);
    return { removed: id };
}

// ---------------------------------------------------------
// TROP-PLEIN : detection "serveur plein" + choix du serveur actif
// ---------------------------------------------------------
function isServerFullKickText(text) {
    return /server_full|server is full|\bfull\b|max(imum)? players/i.test(text || '');
}

function isStateAlive(st) { return !!(st && st.bot && st.bot.entity); }

// Places du serveur : { max, online, free } ou null si inconnu.
function getServerCapacity(st) {
    if (!isStateAlive(st)) return null;
    const bot = st.bot;
    let max = Number.isFinite(st.config.maxPlayers) ? st.config.maxPlayers : null;
    if (!max && bot.game && Number.isFinite(bot.game.maxPlayers) && bot.game.maxPlayers > 0) max = bot.game.maxPlayers;
    if (!max) return null;
    const online = bot.players ? Object.keys(bot.players).length : 0; // inclut GrokBot et les bots miroirs
    return { max, online, free: max - online };
}

function markServerFull(serverId, reason) {
    if (!OVERFLOW_ENABLED) return;
    const st = serverStates.get(serverId);
    if (!st) return;
    if (!st.full) console.log('[Overflow] ' + st.config.name + ' est PLEIN (' + reason + ').');
    st.full = true;
    st.fullReason = reason;
    st.fullSince = Date.now();
    st.okSince = 0;
}

// Met a jour st.full / st.okSince a partir du nombre de joueurs reel.
function refreshServerFullState(st) {
    if (!isStateAlive(st)) { st.okSince = 0; return; }
    const now = Date.now();
    const cap = getServerCapacity(st);
    if (cap && cap.free <= OVERFLOW_RESERVED_SLOTS) {
        markServerFull(st.config.id, cap.online + '/' + cap.max + ' joueurs');
        st.fullSince = now;
    } else if (st.full && (now - st.fullSince) >= OVERFLOW_FULL_COOLDOWN_MS) {
        st.full = false;
        st.fullReason = '';
        console.log('[Overflow] ' + st.config.name + ' a de nouveau de la place.');
    }
    if (!st.full) { if (!st.okSince) st.okSince = now; } else { st.okSince = 0; }
}

// Le serveur prioritaire peut-il reprendre TOUS les bots miroirs sans etre plein ?
function isReadyToTakeBack(st) {
    if (!st.okSince || (Date.now() - st.okSince) < OVERFLOW_RETURN_DELAY_MS) return false;
    const cap = getServerCapacity(st);
    if (!cap) return true;
    return cap.free >= gameState.activePlayers.size + OVERFLOW_RESERVED_SLOTS + 1;
}

// Choisit le serveur actif : premier serveur (ordre de SERVERS[]) en ligne et non plein.
function selectActiveServer(why) {
    const ordered = SERVERS.map(s => serverStates.get(s.id)).filter(Boolean);
    const usable = st => isStateAlive(st) && !(OVERFLOW_ENABLED && st.full);
    const current = serverStates.get(activeServerId);
    let target = null;

    if (!usable(current)) {
        // Actif plein ou hors ligne : premier serveur libre ; sinon on reste sur l'actif
        // s'il est encore en ligne (plein), sinon n'importe quel serveur en ligne.
        target = ordered.find(usable) || (isStateAlive(current) ? null : ordered.find(isStateAlive)) || null;
    } else if (OVERFLOW_ENABLED && OVERFLOW_AUTO_RETURN) {
        const curIdx = ordered.indexOf(current);
        target = ordered.find((st, i) => i < curIdx && usable(st) && isReadyToTakeBack(st)) || null;
    }
    if (target && target.config.id !== activeServerId) switchActiveServer(target.config.id, why || 'auto');
}

// Le monde change : tout ce qui vient du terrain de l'ancien serveur est invalide.
function resetWorldCaches() {
    chunkTerrainCache.clear();
    chunkScanQueue.length = 0;
    chunkScanQueued.clear();
    chunkScanRetryAt.clear();
    chunkScanY.clear();
    pendingResyncChunkKeys.clear();
    previousVisibleChunkKeys = new Set();
    farChunkCache.clear();
    farScanQueue.length = 0;
    farScanQueued.clear();
    farScanY.clear();
    farRetryAt.clear();
    farDirtyUntil.clear();
    pendingFarResyncKeys.clear();
    previousFarVisibleKeys = new Set();
    playerPlacedBlocks.clear();
    for (const t of mcPlayerDiggingTimeout.values()) clearTimeout(t);
    for (const t of mcPlayerDeadTimeout.values()) clearTimeout(t);
    mcPlayerDiggingTimeout.clear();
    mcPlayerDeadTimeout.clear();
    mcPlayerPrevPos.clear();
    mcPlayerAttackingState.clear();
    mcPlayerDiggingState.clear();
    mcPlayerDeadState.clear();
    lastMcPlayerDebugState = '';
}

const KEEP_ON_SWITCH_COMMANDS = new Set(['spawn_object', 'remove_object', 'clear_objects', 'sync_objects', 'admin_action']);

function switchActiveServer(newId, why) {
    if (newId === activeServerId) return;
    const from = serverStates.get(activeServerId);
    const to = serverStates.get(newId);
    if (!to) return;

    let cause;
    if (from && from.full) cause = from.config.name + ' est plein';
    else if (from && !isStateAlive(from)) cause = from.config.name + ' est hors ligne';
    else cause = 'retour sur le serveur prioritaire';
    const message = cause + ' : bascule sur ' + to.config.name;
    console.log('[Overflow] ' + message + ' (' + (why || 'auto') + ')');

    // Commandes en attente de l'ancien serveur : on ne garde que les non-monde (objets, admin).
    const keep = from ? from.pendingCmds.filter(c => KEEP_ON_SWITCH_COMMANDS.has(c.command)) : [];
    if (from) from.pendingCmds.length = 0;

    activeServerId = newId;
    mainBot = to.bot;
    worldData = to.worldData;
    resetWorldCaches();
    scheduleGrokAntiAfkJump(); // le saut anti-AFK cible mainBot

    to.pendingCmds.length = 0;
    for (const c of keep) to.pendingCmds.push(c);
    to.pendingCmds.push({
        command: 'server_switch',
        fromId: from ? from.config.id : null,
        toId: to.config.id,
        toName: to.config.name,
        message
    });

    // Bots miroirs : on les deconnecte, leur handler 'end' les reconnecte (2 s) sur le NOUVEAU serveur actif.
    for (const [robloxUsername, b] of Array.from(activeBots.entries())) {
        playerBotReconnectAttempts.delete(robloxUsername);
        playerBotKickDelay.delete(robloxUsername);
        try { b.quit(); } catch (e) { ignoreErr(e); }
    }
}

// Met un serveur hors ligne (ou le remet en ligne) a la main. Hors ligne : GrokBot est
// deconnecte, plus aucune reconnexion, et le serveur suivant prend la main et affiche son monde.
function setServerForcedOffline(serverId, offline) {
    const st = serverStates.get(serverId);
    if (!st) return false;
    st.forcedOffline = !!offline;
    if (offline) {
        console.log('[Overflow] ' + st.config.name + ' mis HORS LIGNE manuellement.');
        if (st.liveSyncTimer) { clearInterval(st.liveSyncTimer); st.liveSyncTimer = null; }
        st.worldData.serverOnline = false;
        if (st.bot) { try { st.bot.quit(); } catch (e) { ignoreErr(e); } }
        // Si le bot n'emet pas 'end' tout de suite, on force la reevaluation du serveur actif.
        setTimeout(() => { selectActiveServer('forced-offline'); mainBot = (serverStates.get(activeServerId) || {}).bot || null; }, 500);
    } else {
        console.log('[Overflow] ' + st.config.name + ' remis EN LIGNE.');
        st.full = false;
        st.reconnectAttempts = 0;
        st.shortSessions = 0;
        connectServer(serverId);
    }
    return true;
}

function overflowMonitorTick() {
    if (!OVERFLOW_ENABLED) return;
    for (const st of serverStates.values()) refreshServerFullState(st);
    selectActiveServer('monitor');
}

// Agregation des files : seul le serveur actif parle a Roblox. Les files des serveurs en
// veille sont videes (leur monde ne doit jamais etre dessine).
function getAggregatedPendingCommands() {
    const all = [];
    const activeState = serverStates.get(activeServerId);
    if (activeState) {
        const idx = activeState.pendingCmds.findIndex(c => c.command === 'sync_mineflayer_world');
        if (idx !== -1) all.push(activeState.pendingCmds.splice(idx, 1)[0]);
        while (activeState.pendingCmds.length > 0) all.push(activeState.pendingCmds.shift());
    }
    for (const [id, state] of serverStates) {
        if (id !== activeServerId) state.pendingCmds.length = 0;
    }
    return all;
}
const mcPlayerPrevPos = new Map();
const mcPlayerAttackingState = new Map();

// --- FIX "TIMED OUT" / KEEP-ALIVE (bots miroirs Rbx_) ---
// Avant ce patch, "Roblox-Move" appelait playerBot.pathfinder.setGoal() a
// CHAQUE paquet recu du client Lua (plusieurs fois par seconde, sans aucun
// throttle), ce qui redeclenchait un recalcul A* complet a chaque fois.
// Sature l'event loop Node.js partagee par TOUS les bots -> le paquet
// keep-alive Minecraft d'un bot (mainBot ou un autre bot miroir) peut alors
// arriver trop tard, d'ou l'erreur "Error: client timed out after 60000
// milliseconds" (minecraft-protocol). Fix : throttle temps + distance avant
// de recalculer un nouveau but, comme deja fait pour GrokBot/marqueur Rbx_.
const PLAYER_BOT_GOAL_MIN_INTERVAL_MS = 250; // pas plus d'un recalcul A* toutes les 250ms par joueur
const GOAL_RECALC_MIN_DISTANCE = 0.15;       // ignore les micro-mouvements (jitter reseau/physique Roblox a l'arret)
const playerBotLastGoalTime = new Map();     // robloxUsername -> timestamp du dernier setGoal
const playerBotLastGoalPos = new Map();      // robloxUsername -> {x,y,z} de la derniere cible posee

// Cote reconnexion : un timeout keep-alive finit par emettre 'end' sur le
// bot miroir concerne. Avant ce patch, 'end' se contentait de le retirer
// d'activeBots SANS jamais le reconnecter : le joueur Roblox restait donc
// sans bot miroir jusqu'a un rejoin complet. Fix : reconnexion automatique
// avec backoff exponentiel tant que le joueur est toujours present cote
// Roblox (gameState.activePlayers), pour ne pas reconnecter un joueur qui a
// simplement quitte (voir removePlayerBot).
const PLAYER_BOT_RECONNECT_BASE_DELAY_MS = 2000;
const PLAYER_BOT_RECONNECT_MAX_DELAY_MS = 30000;
const playerBotReconnectAttempts = new Map(); // robloxUsername -> nombre de tentatives consecutives
const playerBotConnectedAt = new Map();        // robloxUsername -> instant du dernier spawn (pour juger si la connexion etait stable)

// --- FIX DECALAGE (LAG) ENTRE LE VRAI JOUEUR ROBLOX ET SON BOT MIROIR ---
// Le bot miroir ne recalcule sa cible que toutes les PLAYER_BOT_GOAL_MIN_INTERVAL_MS
// (throttle ci-dessus), en plus du delai reseau (Roblox -> HTTP -> ce serveur)
// et du temps de trajet A* -> le bot vise en permanence une position DEJA
// perimee, ce qui se voit comme un "train de retard" quand le joueur bouge
// vite. Fix : on estime la vitesse du joueur a partir de sa derniere position
// BRUTE (playerLastRawPos, mise a jour a CHAQUE Roblox-Move, jamais throttlee)
// et on avance la cible du bot d'autant, plafonne a MAX_LEAD_SPEED_BLOCKS_PER_SEC
// pour ne jamais projeter une cible deraisonnablement loin (ex: pic de
// latence, teleportation Roblox) qui relancerait une recherche A* couteuse et
// risquerait de reproduire le timeout keep-alive corrige plus haut.
const GOAL_LEAD_TIME_SEC = PLAYER_BOT_GOAL_MIN_INTERVAL_MS / 1000; // avance la cible du temps qui separe deux recalculs
const MAX_LEAD_SPEED_BLOCKS_PER_SEC = 12; // ~vitesse de sprint Minecraft ; au-dela, on plafonne plutot que d'extrapoler une position aberrante
const playerLastRawPos = new Map(); // robloxUsername -> { x, y, z, time } : derniere position BRUTE recue, non throttlee

// --- FIX DECALAGE : GARDE ANTI-DESORDRE SUR LES PAQUETS Roblox-Move ---
// roblox_client.lua envoie chaque Roblox-Move en "fire-and-forget" (task.spawn,
// sans attendre la reponse du precedent) toutes les ~0.1s. Si le reseau vers ce
// serveur est lent/instable (cas courant pour un hebergement maison, voir
// endpointUrl cote Lua), deux requetes peuvent etre EN VOL simultanement et
// arriver ICI dans le DESORDRE par rapport a leur ordre d'envoi. Avant ce fix,
// playerLastRawPos.set() (juste en dessous) ecrasait alors la derniere position
// BRUTE avec une valeur en fait plus ANCIENNE des qu'un paquet en retard
// arrivait apres un plus recent -> le calcul de vitesse (vx/vy/vz) se faisait
// sur un delta INVERSE (ancienne position - nouvelle position), donnant une
// vitesse NEGATIVE fictive qui faisait viser leadX/Y/Z en arriere de la vraie
// position du joueur pendant un instant. Cote Roblox, ca se voit comme un
// "decalage"/rubber-band du bot miroir (et donc du MCPlayer correspondant chez
// tous les autres joueurs). Fix : chaque paquet porte maintenant un horodatage
// reel (sentAt = DateTime.now().UnixTimestampMillis, jamais remis a zero,
// contrairement a un simple compteur qui devrait etre re-synchronise a chaque
// redemarrage du script Lua) ; un paquet dont le sentAt est <= au dernier deja
// applique pour ce joueur est un paquet perime arrive en retard, et est ignore
// purement et simplement (voir le "case Roblox-Move" plus bas).
// FIX JOUEUR (joueur fantome) : joueurs qui viennent de partir -> timestamp du depart. Un paquet
// Roblox-Move encore "en vol" (envoi fire-and-forget) arrivait APRES Roblox-Leave et recreait
// robloxPlayersState : le joueur parti restait affiche cote Roblox. Ces paquets tardifs sont ignores.
const recentlyLeftPlayers = new Map();
const LEFT_PLAYER_IGNORE_MS = 10000;
const playerLastMoveSentAt = new Map(); // robloxUsername -> sentAt (ms) du dernier paquet Roblox-Move REELLEMENT applique
// Etat "en train de miner" des vrais joueurs Minecraft, pilote par le paquet
// 'block_break_animation' (voir mainBot._client.on plus bas). Meme principe
// que mcPlayerAttackingState, mais avec un filet de securite (timeout) en
// plus : contrairement au swing (un seul paquet 'animation'), le minage
// envoie un paquet en continu tant que ca dure, donc si jamais le paquet
// d'arret (destroyStage hors 0-9) n'arrive pas (deco, chunk plus suivi...),
// on ne veut pas rester bloque a isDigging=true indefiniment.
const mcPlayerDiggingState = new Map();
const mcPlayerDiggingTimeout = new Map();
// Etat "mort" (animation de mort) des vrais joueurs Minecraft, pilote par le
// paquet 'entity_status' avec entityStatus === 3 (voir mainBot._client.on
// plus bas, meme paquet que celui utilise par le client vanilla pour jouer
// l'animation de mort d'une Living Entity). Contrairement a isDigging, ce
// paquet n'a PAS de pendant "fin d'evenement" explicite (pas de paquet
// "resurrection") : on le laisse donc a true pendant DEATH_ANIM_DURATION_MS
// puis on le remet automatiquement a false, juste assez longtemps pour que
// roblox_client.lua puisse jouer une animation de mort ponctuelle.
const mcPlayerDeadState = new Map();
const mcPlayerDeadTimeout = new Map();
const DEATH_ANIM_DURATION_MS = 2000;
// FIX FUITE MEMOIRE (filet de securite) : mainBot.on('playerLeft') (voir
// createMainBot plus bas) purge deja mcPlayerPrevPos/mcPlayerAttackingState/
// mcPlayerDiggingState/mcPlayerDiggingTimeout des qu'un joueur MC quitte
// proprement la tab-list. Mais certains cas ne declenchent pas forcement cet
// evenement de facon fiable (crash/redemarrage du process MC, comportement
// specifique a certaines versions/forks serveur, deconnexion tres brutale) :
// sans purge de secours, une entree pourrait alors rester orpheline pour
// toujours dans ces 4 Maps. On rajoute donc une purge PERIODIQUE (meme
// principe que processedChats cote roblox_client.lua) basee sur l'age de la
// derniere position connue (mcPlayerPrevPos.time, mise a jour a CHAQUE tick
// de startLiveSync tant que le joueur est actif) : un joueur toujours
// present a forcement une entree "fraiche" (< 500ms de tick + marge), donc
// large marge de securite avant de purger.
const MC_PLAYER_STATE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes : tres large marge par rapport au rythme de tick (~500ms) de startLiveSync()
let robloxPlayersState = {};
let lastMcPlayerDebugState = ''; // evite de spammer la console : log seulement si la liste change

// Un vrai joueur Minecraft n'a une "entity" cote mineflayer QUE si GrokBot l'a
// deja "vu" (packet spawn_player, envoye par le serveur MC uniquement quand ce
// joueur entre dans la portee de vue de GrokBot). C'est la cause n°1 d'un
// MCPlayer absent cote Roblox : le joueur est bien dans mainBot.players
// (tab-list) mais son .entity est encore/toujours indefini. ENTITY_GRACE_MS
// evite qu'il disparaisse/reapparaisse en clignotant s'il repasse brievement
// hors de cette portee (on continue de l'afficher a sa derniere position
// connue pendant ce delai). Voir aussi l'option viewDistance sur createMainBot.
const ENTITY_GRACE_MS = 8000;

// Dernier centre de generation de chunks demande par chaque joueur Roblox
// (voir "Roblox-RequestChunks" plus bas), envoye par le script Lua des qu'un
// joueur change de chunk. Permet a startLiveSync() de scanner/generer le
// monde reel autour de CHAQUE joueur qui se deplace, pas seulement autour de
// GrokBot. player -> { chunkX, chunkZ, radius, x, y, z, lastUpdate }
const playerChunkRequests = new Map();

// Cache persistant du terrain scanne, par chunk ("cx_cz" -> blocs de surface).
// Rempli progressivement par scanChunkSurface() et tenu a jour en continu par
// l'ecouteur "blockUpdate" (voir plus bas), pour ne jamais rescanner un chunk
// deja connu sauf s'il a reellement change.
const chunkTerrainCache = new Map();
const chunkScanQueue = [];   // file d'attente des chunks a scanner ("cx_cz")
const chunkScanQueued = new Set(); // evite les doublons dans la file
// Chunk pas encore charge cote serveur MC : on reessaie plus tard (ms) au lieu de le mettre en cache vide.
const chunkScanRetryAt = new Map();
const CHUNK_SCAN_RETRY_MS = 1500;
// Blocs liquides (en 1.12 : 'flowing_water' / 'flowing_lava' en plus de 'water' / 'lava').
function isLiquidBlockName(n) {
    return n === 'water' || n === 'lava' || n === 'flowing_water' || n === 'flowing_lava';
}
// Tronc / feuilles d'arbre (oak_log, log, log2, birch_leaves, leaves2, oak_wood...). Avant : includes('wood')
// prenait aussi 'wooden_slab', 'wooden_door'... pour des arbres.
function isTreeBlockName(n) {
    return !!n && /(^|_)(log2?|leaves2?|wood)$/.test(n);
}
const chunkScanY = new Map(); // "cx_cz" -> altitude de reference pour le scan (GrokBot ou le joueur le plus recent a avoir rendu ce chunk visible) : evite de rater le terrain quand un joueur est a une hauteur tres differente de GrokBot

// Chunks DEJA en cache (chunkTerrainCache) mais qui doivent quand meme etre
// renvoyes au(x) prochain(s) tick(s) de startLiveSync(), meme si personne ne
// les a rescannes. Utilise pour un resync complet apres un (re)demarrage du
// script Lua (voir "Roblox-ServerStart" plus bas) : le script Lua redemarre
// avec un cache client VIDE, mais le cache Node.js, lui, peut deja contenir
// des chunks scannes AVANT ce (re)demarrage -- sans ce mecanisme, la logique
// "delta" ci-dessous (qui ne renvoie que les chunks fraichement scannes CE
// tick) ne les renverrait alors JAMAIS. Vide en temps normal (cout nul).
const pendingResyncChunkKeys = new Set();

// Chunks visibles (union des rayons de tous les centres) au tick PRECEDENT de
// startLiveSync(). Sert a detecter un chunk qui redevient visible apres etre
// sorti de portee de tous les centres actifs : cote Lua, en sortant de
// portee, son contour ET ses blocs sont detruits -- mais cote Node.js,
// chunkTerrainCache le garde en cache (jamais invalide, le terrain n'a pas
// reellement change). Sans ce suivi, un chunk deja en cache qui redevient
// visible n'est jamais rescanne (donc jamais dans chunksTouchedThisTick) et
// ne serait donc JAMAIS renvoye a Roblox : son contour reapparaitrait vide en
// permanence. Fix : tout chunk visible ce tick mais absent du tick precedent
// est force en resync complet via pendingResyncChunkKeys (meme mecanisme que
// "Roblox-ServerStart").
let previousVisibleChunkKeys = new Set();

const gameState = {
    gameName: "MonSuperJeuRoblox",
    totalBlocksSpawned: 0,
    activePlayers: new Set(),
    lastHeartbeat: Date.now(),
    isOnline: false
};

let chatMessages = [];

let worldData = {
    command: 'sync_mineflayer_world',
    syncTick: worldSyncTick,
    serverName: (SERVERS.find(s => s.enabled) || SERVERS[0]).name,
    serverId:   (SERVERS.find(s => s.enabled) || SERVERS[0]).id,
    serverOnline: false,
    botName: (SERVERS.find(s => s.enabled) || SERVERS[0]).botName,
    x: 0, y: 64, z: 0,
    blockSize: globalBlockSize,
    plateauEnabled: plateauEnabled,
    plateauSize: plateauSize,
    zones: [], blocks: [], bots: [],
    minecraftPlayers: [], chats: []
};

// ---------------------------------------------------------
// 3. FONCTIONS UTILITAIRES & PERSISTENCE
// ---------------------------------------------------------
function queueCommand(newCmd, serverId) {
    const sid = serverId || activeServerId;
    const state = serverStates.get(sid);
    const queue = (state ? state.pendingCmds : null) || pendingCommands;
    if (newCmd.command === 'sync_mineflayer_world') {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].command === 'sync_mineflayer_world') queue.splice(i, 1);
        }
    }
    // INVENTAIRE CONNECTE (ajout) : un seul inventory_sync en attente par joueur
    // (seul le plus recent compte), pour ne pas saturer la file.
    if (newCmd.command === 'inventory_sync') {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].command === 'inventory_sync' && queue[i].player === newCmd.player) queue.splice(i, 1);
        }
    }
    queue.push(newCmd);
    if (queue.length > 100) queue.shift();
}

// SECURITE (path traversal) : "username" (payload Roblox) et "gameName"
// (config interne, mais reutilise la meme fonction par coherence) servent a
// construire un CHEMIN DE FICHIER. Sans filtrage, une valeur du style
// "../../autre_dossier/x" permettrait d'ecrire un JSON en dehors de
// PLAYERS_DIR/GAMES_DIR. On ne garde que alphanumerique/-/_ et on retombe
// sur un nom neutre si le resultat est vide (nom entierement compose de
// caracteres interdits).
function sanitizeForFilename(rawName) {
    const cleaned = String(rawName || '').replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned.length > 0 ? cleaned : '_invalid_';
}

function savePlayer(username) {
    const safeUsername = sanitizeForFilename(username);
    const filePath = path.join(PLAYERS_DIR, `${safeUsername}.json`);
    let playerData = { 
        username, 
        firstLogin: new Date().toLocaleString(), 
        lastLogin: new Date().toLocaleString(), 
        totalJoins: 1 
    };

    if (fs.existsSync(filePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            playerData = { 
                ...existing, 
                lastLogin: new Date().toLocaleString(), 
                totalJoins: (existing.totalJoins || 0) + 1 
            };
        } catch (err) {
            console.error(`Erreur de lecture du fichier joueur ${username}:`, err.message);
        }
    }
    fs.writeFileSync(filePath, JSON.stringify(playerData, null, 2));
    return playerData;
}

function saveGameStatus(status) {
    gameState.isOnline = (status === "Online");
    const safeGameName = sanitizeForFilename(gameState.gameName);
    const filePath = path.join(GAMES_DIR, `${safeGameName}.json`);
    const gameData = {
        name: gameState.gameName,
        status: status,
        lastUpdate: new Date().toLocaleString(),
        totalBlocksSpawned: gameState.totalBlocksSpawned,
        playersOnline: gameState.activePlayers.size
    };
    fs.writeFileSync(filePath, JSON.stringify(gameData, null, 2));
}

// FIX FUITE MEMOIRE (filet de securite) : purge periodique de secours des 4
// Maps de suivi par-joueur-MC (voir MC_PLAYER_STATE_MAX_AGE_MS plus haut,
// pres de leur declaration, pour le detail complet). mainBot.on('playerLeft')
// est le nettoyage NORMAL (immediat, des qu'un joueur MC quitte proprement),
// cette purge n'est qu'un filet pour les cas ou cet evenement ne se
// declencherait pas de facon fiable -- sans ca, une entree orpheline
// resterait alors en Map pour toujours, meme classe de fuite que
// processedChats (deja purge periodiquement cote roblox_client.lua) avant
// son propre fix.
function purgeStaleMcPlayerState() {
    const now = Date.now();
    for (const [username, prev] of mcPlayerPrevPos) {
        if ((now - prev.time) > MC_PLAYER_STATE_MAX_AGE_MS) {
            mcPlayerPrevPos.delete(username);
            mcPlayerAttackingState.delete(username);
            mcPlayerDiggingState.delete(username);
            const existingTimeout = mcPlayerDiggingTimeout.get(username);
            if (existingTimeout) clearTimeout(existingTimeout);
            mcPlayerDiggingTimeout.delete(username);
            mcPlayerDeadState.delete(username);
            const existingDeathTimeout = mcPlayerDeadTimeout.get(username);
            if (existingDeathTimeout) clearTimeout(existingDeathTimeout);
            mcPlayerDeadTimeout.delete(username);
        }
    }
    // Filet supplementaire : une entree pourrait exister dans
    // mcPlayerAttackingState/mcPlayerDiggingState SANS jamais etre passee par
    // mcPlayerPrevPos (cas limite : un paquet 'animation'/'block_break_animation'
    // recu pour un joueur dont l'entite n'a encore jamais ete positionnee dans
    // startLiveSync). On les retire aussi s'ils ne correspondent a AUCUN
    // joueur actuellement dans la tab-list MC.
    const currentPlayers = (mainBot && mainBot.players) ? mainBot.players : {};
    for (const username of mcPlayerAttackingState.keys()) {
        if (!mcPlayerPrevPos.has(username) && !currentPlayers[username]) {
            mcPlayerAttackingState.delete(username);
        }
    }
    for (const username of mcPlayerDiggingState.keys()) {
        if (!mcPlayerPrevPos.has(username) && !currentPlayers[username]) {
            mcPlayerDiggingState.delete(username);
            const existingTimeout = mcPlayerDiggingTimeout.get(username);
            if (existingTimeout) clearTimeout(existingTimeout);
            mcPlayerDiggingTimeout.delete(username);
        }
    }
    for (const username of mcPlayerDeadState.keys()) {
        if (!mcPlayerPrevPos.has(username) && !currentPlayers[username]) {
            mcPlayerDeadState.delete(username);
            const existingDeathTimeout = mcPlayerDeadTimeout.get(username);
            if (existingDeathTimeout) clearTimeout(existingDeathTimeout);
            mcPlayerDeadTimeout.delete(username);
        }
    }
}
setInterval(purgeStaleMcPlayerState, 60000); // toutes les 60s, meme rythme que la purge processedChats cote Lua

// Scanne la surface (heightmap) d'un chunk 16x16 entier : pour chaque colonne
// (x,z) du chunk, on cherche le premier bloc solide en partant du haut de la
// fenetre verticale et on s'arrete la (comme F3+G en mode "surface only").
// Beaucoup moins couteux qu'un scan volumetrique complet (une lecture par
// colonne au lieu de dizaines), et suffisant pour afficher un vrai terrain
// (collines, sol, vallees) sur tout le rayon des chunks visibles.
// ---------------------------------------------------------
// BLOCS POSES PAR LES JOUEURS (ajout) : le scan de surface ci-dessous n'envoie que le
// PREMIER bloc solide de chaque colonne (en partant de aroundY + SURFACE_SCAN_UP).
// Consequence : quand on pose un bloc AU-DESSUS d'un autre, celui du dessous n'est plus
// "la surface" -> il n'est plus dans le payload et le client Lua le detruit (nettoyage des
// chunks du payload) apres la fenetre de protection de 5 s. De meme, un bloc pose plus haut
// que aroundY + SURFACE_SCAN_UP n'etait jamais renvoye.
// FIX : on memorise chaque bloc pose avec succes et on le re-injecte dans le scan de son
// chunk tant qu'il existe encore dans le monde Minecraft (verifie par blockAt).
// Memoire volatile : apres un redemarrage de ce serveur, seuls les blocs de surface
// reviennent (le monde Minecraft, lui, n'est pas affecte).
// ---------------------------------------------------------
const playerPlacedBlocks = new Map(); // "x_y_z" -> { x, y, z }

function trackPlacedBlock(x, y, z) {
    playerPlacedBlocks.set(`${x}_${y}_${z}`, { x, y, z });
}


// ---------------------------------------------------------------------------
// Compatibilite 1.12.x : avant la "flattening" (1.13) les blocs ont d'anciens noms + metadata
// (planks, log, grass...). On les convertit en noms modernes pour roblox_client.lua.
// Uniquement pour un bot en version <= 1.12 ('grass'/'snow' ont un autre sens en 1.20).
// ---------------------------------------------------------------------------
const LEGACY_COLORS = ['white','orange','magenta','light_blue','yellow','lime','pink','gray','light_gray','cyan','purple','blue','brown','green','red','black'];
const LEGACY_WOODS = ['oak','spruce','birch','jungle','acacia','dark_oak'];
function isLegacyBot(botInstance) {
    const v = botInstance && botInstance.version;
    const m = typeof v === 'string' && v.match(/^1\.(\d+)/);
    return !!m && parseInt(m[1], 10) <= 12;
}
function mcName(botInstance, block) {
    const n = block.name;
    if (!n || !isLegacyBot(botInstance)) return n;
    const md = block.metadata || 0;
    switch (n) {
        case 'grass': return 'grass_block';
        case 'tallgrass': return md === 2 ? 'fern' : 'short_grass';
        case 'double_plant': return md === 3 ? 'tall_grass' : (md === 2 ? 'large_fern' : n);
        case 'planks': return (LEGACY_WOODS[md & 7] || 'oak') + '_planks';
        case 'log': return (LEGACY_WOODS[md & 3] || 'oak') + '_log';
        case 'log2': return (LEGACY_WOODS[4 + (md & 1)] || 'acacia') + '_log';
        case 'leaves': return (LEGACY_WOODS[md & 3] || 'oak') + '_leaves';
        case 'leaves2': return (LEGACY_WOODS[4 + (md & 1)] || 'acacia') + '_leaves';
        case 'sapling': return (LEGACY_WOODS[md & 7] || 'oak') + '_sapling';
        case 'wool': return LEGACY_COLORS[md & 15] + '_wool';
        case 'stained_hardened_clay': return LEGACY_COLORS[md & 15] + '_terracotta';
        case 'stained_glass': return LEGACY_COLORS[md & 15] + '_stained_glass';
        case 'hardened_clay': return 'terracotta';
        case 'stonebrick': return 'stone_bricks';
        case 'brick_block': return 'bricks';
        case 'snow': return 'snow_block';
        case 'snow_layer': return 'snow';
        case 'flowing_water': return 'water';
        case 'flowing_lava': return 'lava';
        case 'reeds': return 'sugar_cane';
        case 'web': return 'cobweb';
        case 'deadbush': return 'dead_bush';
        case 'yellow_flower': return 'dandelion';
        case 'red_flower': return 'poppy';
        case 'lit_pumpkin': return 'jack_o_lantern';
        case 'stone': return ['stone','granite','polished_granite','diorite','polished_diorite','andesite','polished_andesite'][md] || 'stone';
        case 'dirt': return md === 1 ? 'coarse_dirt' : (md === 2 ? 'podzol' : 'dirt');
        case 'sand': return md === 1 ? 'red_sand' : 'sand';
        default: return n;
    }
}


// Sens inverse de mcName() : nom moderne (envoye par Roblox) -> { name, metadata } 1.12.x.
// Ex. 'birch_planks' -> { name: 'planks', metadata: 2 }. Inconnu / bot recent : inchange.
function toLegacyItem(botInstance, modern) {
    if (!modern || !isLegacyBot(botInstance)) return { name: modern, metadata: 0 };
    const woodIdx = w => LEGACY_WOODS.indexOf(w);
    let m;
    if ((m = modern.match(/^(.+)_planks$/)) && woodIdx(m[1]) >= 0) return { name: 'planks', metadata: woodIdx(m[1]) };
    if ((m = modern.match(/^(.+)_log$/)) && woodIdx(m[1]) >= 0) return woodIdx(m[1]) < 4 ? { name: 'log', metadata: woodIdx(m[1]) } : { name: 'log2', metadata: woodIdx(m[1]) - 4 };
    if ((m = modern.match(/^(.+)_leaves$/)) && woodIdx(m[1]) >= 0) return woodIdx(m[1]) < 4 ? { name: 'leaves', metadata: woodIdx(m[1]) } : { name: 'leaves2', metadata: woodIdx(m[1]) - 4 };
    if ((m = modern.match(/^(.+)_sapling$/)) && woodIdx(m[1]) >= 0) return { name: 'sapling', metadata: woodIdx(m[1]) };
    if ((m = modern.match(/^(.+)_wool$/)) && LEGACY_COLORS.indexOf(m[1]) >= 0) return { name: 'wool', metadata: LEGACY_COLORS.indexOf(m[1]) };
    if ((m = modern.match(/^(.+)_terracotta$/)) && LEGACY_COLORS.indexOf(m[1]) >= 0) return { name: 'stained_hardened_clay', metadata: LEGACY_COLORS.indexOf(m[1]) };
    if ((m = modern.match(/^(.+)_stained_glass$/)) && LEGACY_COLORS.indexOf(m[1]) >= 0) return { name: 'stained_glass', metadata: LEGACY_COLORS.indexOf(m[1]) };
    const stones = ['stone','granite','polished_granite','diorite','polished_diorite','andesite','polished_andesite'];
    if (stones.indexOf(modern) > 0) return { name: 'stone', metadata: stones.indexOf(modern) };
    const map = {
        grass_block: ['grass', 0], terracotta: ['hardened_clay', 0], stone_bricks: ['stonebrick', 0],
        bricks: ['brick_block', 0], snow_block: ['snow', 0], snow: ['snow_layer', 0],
        sugar_cane: ['reeds', 0], cobweb: ['web', 0], dead_bush: ['deadbush', 0],
        dandelion: ['yellow_flower', 0], poppy: ['red_flower', 0], jack_o_lantern: ['lit_pumpkin', 0],
        coarse_dirt: ['dirt', 1], podzol: ['dirt', 2], red_sand: ['sand', 1], short_grass: ['tallgrass', 1],
    };
    if (map[modern]) return { name: map[modern][0], metadata: map[modern][1] };
    return { name: modern, metadata: 0 };
}

function mergeTrackedBlocksIntoScan(botInstance, chunkX, chunkZ, blocksArray) {
    if (playerPlacedBlocks.size === 0) return;
    const already = new Set(blocksArray.map(b => `${b.x}_${b.y}_${b.z}`));
    for (const [key, pos] of playerPlacedBlocks) {
        if (Math.floor(pos.x / CHUNK_SIZE) !== chunkX || Math.floor(pos.z / CHUNK_SIZE) !== chunkZ) continue;
        let block = null;
        try { block = botInstance.blockAt(new Vec3(pos.x, pos.y, pos.z)); } catch (e) { continue; }
        if (!block) continue; // chunk non charge : on garde le suivi, on retentera
        if (!block.name || block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') {
            playerPlacedBlocks.delete(key); // bloc casse depuis : on n'en parle plus
            continue;
        }
        if (already.has(key)) continue;
        blocksArray.push({ name: mcName(botInstance, block), x: pos.x, y: pos.y, z: pos.z, chunkX, chunkZ });
    }
}

function scanChunkSurface(botInstance, chunkX, chunkZ, aroundY) {
    if (!botInstance) return [];
    const blocksArray = [];
    const baseX = chunkX * CHUNK_SIZE;
    const baseZ = chunkZ * CHUNK_SIZE;
    const topY = Math.floor(aroundY + SURFACE_SCAN_UP);
    const bottomY = Math.floor(aroundY - SURFACE_SCAN_DOWN);
    let anyLoaded = false; // false = chunk pas (encore) charge cote serveur MC -> retourne null (pas de cache)

    for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let z = 0; z < CHUNK_SIZE; z++) {
            const worldX = baseX + x;
            const worldZ = baseZ + z;
            // PATCH "PLANTE HERBE" (+ pousse/sapling, cette revision) : une
            // touffe d'herbe (short_grass/grass/tall_grass) OU une pousse
            // (oak_sapling, spruce_sapling, etc.) juste au-dessus du bloc
            // solide sont des blocs traversables (boundingBox 'empty', voir
            // le filtre plus bas) donc normalement ignorés -- on retient
            // quand même leur position ici pour les renvoyer EN PLUS du bloc
            // solide trouvé en dessous (voir l'ajout a blocksArray après la
            // boucle y), au lieu de les perdre completement comme les autres
            // decorations (torche, pancarte, culture...).
            let grassPlantAbove = null;
            // PATCH "TROU SOUS LES ARBRES" (cette revision) : tronc (log/wood) et
            // feuilles (leaves) sont des blocs SOLIDES (boundingBox != 'empty'),
            // donc le scan s'arretait dessus et les prenait pour "la surface" de
            // la colonne -- le vrai sol (grass_block/dirt...) juste en dessous
            // n'etait alors JAMAIS atteint ni envoye, laissant un trou/vide visible
            // sous chaque arbre cote Roblox (le tronc/les feuilles flottent, sans
            // rien en dessous). On collecte ici TOUS les blocs d'arbre traverses
            // en descendant (potentiellement plusieurs : tronc sur toute sa
            // hauteur + feuilles), et on continue le scan au lieu de s'arreter,
            // jusqu'a trouver le vrai bloc solide du sol -- exactement comme
            // grassPlantAbove le fait deja pour une touffe d'herbe/pousse, mais
            // pour PLUSIEURS blocs empiles au lieu d'un seul.
            const treeBlocksAbove = [];
            let treeBlocksFlushed = false;

            for (let y = topY; y >= bottomY; y--) {
                let block = null;
                try {
                    block = botInstance.blockAt(new Vec3(worldX, y, worldZ));
                } catch (e) {
                    // Chunk pas (encore) charge cote serveur MC : on retentera au prochain passage
                    break;
                }
                if (block) anyLoaded = true;
                if (block && block.name === 'bedrock') {
                    // La bedrock est tres souvent un plafond/mur de PROTECTION (ex:
                    // au-dessus du spawn, pour empecher de construire par-dessus),
                    // pas la vraie surface marchable. Si on s'arretait dessus comme
                    // sur n'importe quel autre bloc solide, elle etait choisie comme
                    // "sol" de la colonne des qu'elle est le premier bloc rencontre
                    // en descendant -- et comme elle peut etre tres haute (ex: y=100+
                    // au-dessus du spawn), elle apparaissait flottante en haut du
                    // rendu Roblox au lieu du vrai sol, plus bas. On l'ignore donc et
                    // on continue de chercher plus bas la vraie surface.
                    continue;
                }
                // FIX "je vois pas le bloc Grass" : un bloc "traversable" (herbe
                // haute short_grass/tall_grass, fougere, fleur, pousse, pancarte,
                // torche, culture...) a un block.boundingBox === 'empty' (API
                // mineflayer/prismarine-block) alors qu'il N'EST PAS de l'air : sans
                // ce filtre, le scan s'arretait dessus et le considerait comme "la
                // surface" de la colonne AVANT meme d'atteindre le vrai bloc solide
                // (le grass_block) juste en-dessous. On garde une exception pour
                // l'eau/la lave (boundingBox 'empty' aussi) qu'on veut quand meme
                // afficher comme "surface" plutot que de traverser jusqu'au fond.
                if (block && block.boundingBox === 'empty' && !isLiquidBlockName(block.name)) {
                    if (!grassPlantAbove && (block.name === 'short_grass' || block.name === 'grass' || block.name === 'tall_grass' || block.name === 'tallgrass' || (block.name && block.name.includes('sapling')))) {
                        // On ne garde que la PREMIERE decoration rencontree en
                        // descendant (la plus haute) : au-dela, ce serait une 2e
                        // touffe/pousse posee sur de l'air au-dessus d'une autre,
                        // cas rarissime qu'on ignore.
                        grassPlantAbove = { name: mcName(botInstance, block), x: worldX, y, z: worldZ, chunkX, chunkZ };
                    }
                    continue;
                }
                // PATCH "TROU SOUS LES ARBRES" (suite) : tronc (contient "log" ou
                // "wood", ex: oak_log, oak_wood, stripped_oak_log) et feuilles
                // (contient "leaves", ex: oak_leaves, azalea_leaves) SONT solides
                // (boundingBox != 'empty', donc pas intercepte par le filtre
                // au-dessus) -- sans ce traitement special, le "if" juste en
                // dessous les prendrait pour LA surface de la colonne et
                // s'arreterait la, sans jamais atteindre le vrai sol. On les
                // collecte donc tous (potentiellement plusieurs empiles : feuilles
                // ET tronc dans la meme colonne) et on continue de descendre.
                if (block && isTreeBlockName(block.name)) {
                    treeBlocksAbove.push({ name: mcName(botInstance, block), x: worldX, y, z: worldZ, chunkX, chunkZ });
                    continue;
                }
                if (block && block.name && block.name !== 'air') {
                    blocksArray.push({
                        name: mcName(botInstance, block),
                        x: worldX,
                        y,
                        z: worldZ,
                        chunkX,
                        chunkZ
                    });
                    if (grassPlantAbove) {
                        // Envoyee APRES le bloc solide, comme un bloc independant a
                        // part entiere (coordonnee y differente) : roblox_client.lua
                        // la rend via son propre gabarit dedie (voir createOrUpdateBlock,
                        // customGrassPlantTemplate) sans avoir besoin d'un traitement
                        // special cote client pour "deux blocs dans la meme colonne".
                        blocksArray.push(grassPlantAbove);
                    }
                    if (treeBlocksAbove.length > 0) {
                        // Tronc/feuilles traverses en descendant, envoyes APRES le
                        // vrai sol (meme principe que grassPlantAbove ci-dessus,
                        // mais pour plusieurs blocs empiles) : roblox_client.lua les
                        // rend chacun via son propre gabarit (customWoodBlockTemplate/
                        // customLeavesBlockTemplate), independamment du sol dessous.
                        for (const treeBlock of treeBlocksAbove) {
                            blocksArray.push(treeBlock);
                        }
                        treeBlocksFlushed = true;
                    }
                    break; // premier bloc solide (hors bedrock/tronc/feuilles) = surface de cette colonne, on passe a la suivante
                }
            }
            if (treeBlocksAbove.length > 0 && !treeBlocksFlushed) {
                // Arbre "flottant" au-dessus d'un trou/d'une grotte : le scan a
                // atteint bottomY sans jamais trouver de vrai sol solide sous le
                // tronc/les feuilles (aucun "break" ci-dessus n'a donc pu les
                // envoyer). On les envoie quand meme ici, plutot que de perdre
                // completement cette portion d'arbre.
                for (const treeBlock of treeBlocksAbove) {
                    blocksArray.push(treeBlock);
                }
            }
        }
    }
    if (!anyLoaded) return null; // chunk non charge : l'appelant reessaiera (voir chunkScanRetryAt)
    mergeTrackedBlocksIntoScan(botInstance, chunkX, chunkZ, blocksArray); // blocs empiles (ajout)
    return blocksArray;
}

// Invalide le chunk contenant (x,z) suite a un blockUpdate reel (pose/casse en
// jeu) et le remet en file de scan, pour que le cache de surface reste a jour
// sans avoir a rescanner tous les chunks visibles a chaque tick.
function invalidateChunkAt(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const key = `${cx}_${cz}`;
    chunkTerrainCache.delete(key);
    chunkScanRetryAt.delete(key);
    if (!chunkScanQueued.has(key)) {
        chunkScanQueue.push(key);
        chunkScanQueued.add(key);
    }
}

// RENDU LOINTAIN : resume un chunk 16x16 en {y, name} a partir de 4 colonnes
// (voir FAR_SAMPLE_OFFSETS). Retourne null si le chunk n'est pas charge cote
// bot (aucune lecture possible), { empty: true } s'il est charge mais sans
// surface solide dans la fenetre verticale (vide/grotte).
function scanChunkFar(botInstance, chunkX, chunkZ, aroundY) {
    if (!botInstance) return null;
    const baseX = chunkX * CHUNK_SIZE;
    const baseZ = chunkZ * CHUNK_SIZE;
    const topY = Math.min(319, Math.floor(aroundY + FAR_SCAN_UP));
    const bottomY = Math.max(-64, Math.floor(aroundY - FAR_SCAN_DOWN));
    let sumY = 0;
    let found = 0;
    let anyLoaded = false;
    const nameCounts = {};
    for (const ox of FAR_SAMPLE_OFFSETS) {
        for (const oz of FAR_SAMPLE_OFFSETS) {
            for (let y = topY; y >= bottomY; y--) {
                let block = null;
                try {
                    block = botInstance.blockAt(new Vec3(baseX + ox, y, baseZ + oz));
                } catch (e) {
                    continue;
                }
                if (!block) continue; // chunk non charge (ou hors monde)
                anyLoaded = true;
                const n = mcName(botInstance, block);
                if (!n || n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'bedrock') continue;
                if (block.boundingBox === 'empty' && !isLiquidBlockName(block.name)) continue;
                // Arbres ignores : la dalle lointaine represente le sol, pas la canopee.
                if (isTreeBlockName(n)) continue;
                sumY += y;
                found++;
                nameCounts[n] = (nameCounts[n] || 0) + 1;
                break;
            }
        }
    }
    if (!anyLoaded) return null;
    if (found === 0) return { empty: true };
    let bestName = 'stone';
    let bestCount = 0;
    for (const n in nameCounts) {
        if (nameCounts[n] > bestCount) { bestCount = nameCounts[n]; bestName = n; }
    }
    return { chunkX, chunkZ, y: Math.round(sumY / found), name: bestName };
}

// Distance (au carre, en chunks) entre un chunk "cx_cz" et le centre actif le
// plus proche (GrokBot ou n'importe quel joueur). Utilisee pour trier
// chunkScanQueue avant chaque tick de scan (voir startLiveSync), pour que le
// terrain se remplisse en partant du joueur/GrokBot vers l'exterieur au lieu
// d'un ordre raster arbitraire.
function distanceSqToNearestCenter(chunkKey, centers) {
    const [cxStr, czStr] = chunkKey.split('_');
    const cx = parseInt(cxStr, 10);
    const cz = parseInt(czStr, 10);
    let minDistSq = Infinity;
    for (const center of centers) {
        const dx = cx - center.chunkX;
        const dz = cz - center.chunkZ;
        const distSq = dx * dx + dz * dz;
        if (distSq < minDistSq) minDistSq = distSq;
    }
    return minDistSq;
}

// ---------------------------------------------------------
// 2.1 OBJETS ROBLOX STUDIO (persistance + API)
// ---------------------------------------------------------
// Les objets sont des Models/Parts du dossier ServerStorage/Objets (Studio),
// identifies par leur NOM. Ici on ne stocke que "quel objet, ou, comment" :
// coordonnees Minecraft x/y/z (y = niveau des pieds), rotation Y en degres,
// echelle, ancrage optionnel.
const OBJECTS_DIR = path.join(__dirname, 'objects');
const OBJECTS_FILE = path.join(OBJECTS_DIR, 'placed_objects.json');
const OBJECTS_API_KEY_FROM_ENV = !!process.env.OBJECTS_API_KEY;
const OBJECTS_API_KEY_FILE = path.join(__dirname, '.objects_api_key');
function loadOrCreateObjectsKey() {
    if (process.env.OBJECTS_API_KEY) return process.env.OBJECTS_API_KEY;
    try {
        const k = fs.readFileSync(OBJECTS_API_KEY_FILE, 'utf8').trim();
        if (k) return k;
    } catch (e) { ignoreErr(e); }
    const k = require('crypto').randomBytes(16).toString('hex');
    try { fs.writeFileSync(OBJECTS_API_KEY_FILE, k, { mode: 0o600 }); } catch (e) { console.warn('[Objets] Cle non sauvegardee : ' + e.message); }
    return k;
}
const OBJECTS_API_KEY = loadOrCreateObjectsKey();
if (!OBJECTS_API_KEY_FROM_ENV) {
    console.warn('[Objets] OBJECTS_API_KEY non definie. Cle sauvegardee dans .objects_api_key : ' + OBJECTS_API_KEY);
    console.warn('[Objets] Definis OBJECTS_API_KEY pour la remplacer.');
}
const OBJECTS_AUTH_MAX_FAILS = 10;       // echecs de cle API par IP et par minute
const OBJECTS_AUTH_WINDOW_MS = 60 * 1000;
const MAX_PLACED_OBJECTS = 300;          // aligne avec MAX_PLACED_OBJECTS cote Lua
const MAX_OBJECTS_PER_REQUEST = 50;
const OBJECT_COORD_LIMIT = 30000000;     // limite du monde Minecraft
if (!fs.existsSync(OBJECTS_DIR)) fs.mkdirSync(OBJECTS_DIR, { recursive: true });

const placedObjects = new Map(); // id -> { id, name, x, y, z, rotY, scale, anchored? }
let objectIdCounter = 0;
// Version de la liste d'objets : +1 a chaque modification. Demarre sur un
// horodatage pour rester croissante entre deux redemarrages du serveur. Les
// clients (Godot...) la passent en ?since=N et recoivent {unchanged:true}
// tant que rien n'a bouge, au lieu de re-telecharger toute la liste.
let objectsVersion = Date.now();
function bumpObjectsVersion() { objectsVersion++; }
let objectsSaveTimer = null;

function newObjectId() {
    objectIdCounter++;
    return `S${Date.now().toString(36)}_${objectIdCounter}`;
}

// Valide/normalise un objet venant de Roblox ou de l'API REST. Retourne null
// si invalide. Un id fourni n'est garde que s'il est "sur" (lettres, chiffres,
// _ et -) ; sinon un nouvel id est genere.
// Nombre strict : refuse booleens, null, chaine vide (Number('') vaut 0, Number(true) vaut 1).
function strictNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '') return Number(v);
    return NaN;
}

function sanitizeObject(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '';
    const x = strictNumber(raw.x), y = strictNumber(raw.y), z = strictNumber(raw.z);
    if (!name || ![x, y, z].every(Number.isFinite)) return null;
    if (Math.abs(x) > OBJECT_COORD_LIMIT || Math.abs(y) > OBJECT_COORD_LIMIT || Math.abs(z) > OBJECT_COORD_LIMIT) return null;

    let rotY = Number(raw.rotY);
    if (!Number.isFinite(rotY)) rotY = 0;
    rotY = ((rotY % 360) + 360) % 360;

    let scale = Number(raw.scale);
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;
    scale = Math.min(Math.max(scale, 0.05), 50);

    const id = (typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(raw.id)) ? raw.id : newObjectId();
    const obj = { id, name, x, y, z, rotY, scale };
    if (typeof raw.anchored === 'boolean') obj.anchored = raw.anchored;
    return obj;
}

function saveObjectsNow() {
    if (objectsSaveTimer) { clearTimeout(objectsSaveTimer); objectsSaveTimer = null; }
    try {
        // Ecriture atomique : fichier temporaire puis rename, pour ne jamais
        // laisser un JSON a moitie ecrit en cas d'arret brutal.
        const tmpFile = OBJECTS_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(Array.from(placedObjects.values()), null, 2));
        fs.renameSync(tmpFile, OBJECTS_FILE);
    } catch (err) {
        console.error('[Objets] Erreur de sauvegarde :', err.message);
    }
}

function scheduleObjectsSave() {
    if (objectsSaveTimer) return;
    objectsSaveTimer = setTimeout(saveObjectsNow, 300);
}

function loadObjects() {
    if (!fs.existsSync(OBJECTS_FILE)) return;
    try {
        const list = JSON.parse(fs.readFileSync(OBJECTS_FILE, 'utf8'));
        if (!Array.isArray(list)) throw new Error('format inattendu (tableau attendu)');
        for (const raw of list) {
            const obj = sanitizeObject(raw);
            if (obj && placedObjects.size < MAX_PLACED_OBJECTS) placedObjects.set(obj.id, obj);
        }
        console.log(`[Objets] ${placedObjects.size} objet(s) charge(s) depuis ${OBJECTS_FILE}`);
    } catch (err) {
        console.error('[Objets] Fichier illisible, ignore :', err.message);
        try {
            const backup = OBJECTS_FILE + '.corrupt-' + Date.now();
            fs.copyFileSync(OBJECTS_FILE, backup);
            console.error('[Objets] Copie de sauvegarde : ' + backup);
        } catch (e) { /* ignore */ }
    }
}
loadObjects();
process.on('exit', () => {
    if (objectsSaveTimer) saveObjectsNow();
});

// Ajoute (ou remplace, meme id) un objet. Retourne { obj } ou { error }.
function addPlacedObject(raw) {
    const obj = sanitizeObject(raw);
    if (!obj) return { error: 'Objet invalide (name, x, y, z requis)' };
    if (!placedObjects.has(obj.id) && placedObjects.size >= MAX_PLACED_OBJECTS) {
        return { error: `Limite atteinte (${MAX_PLACED_OBJECTS} objets)` };
    }
    placedObjects.set(obj.id, obj);
    bumpObjectsVersion();
    scheduleObjectsSave();
    return { obj };
}

function removePlacedObject(id) {
    const existed = placedObjects.delete(id);
    if (existed) { bumpObjectsVersion(); scheduleObjectsSave(); }
    return existed;
}

function clearPlacedObjects() {
    placedObjects.clear();
    bumpObjectsVersion();
    scheduleObjectsSave();
}

// Envoie a Roblox la liste COMPLETE des objets (remplace les objets
// persistants du client Lua) : utilise au (re)demarrage du script Lua.
function queueObjectsSync() {
    queueCommand({ command: 'sync_objects', objects: Array.from(placedObjects.values()) });
}

// ---------------------------------------------------------
// 4. BOTS MIROIRS (Rbx_NomDuJoueur)
// ---------------------------------------------------------

// Appelee sur 'end' d'un bot miroir (timeout keep-alive, kick, deco reseau,
// ou depart volontaire du joueur via removePlayerBot -> playerBot.quit()).
// Ne reconnecte QUE si le joueur Roblox est toujours present : sinon (cas
// removePlayerBot) le depart est volontaire et il ne faut pas le faire
// revenir tout seul.
function scheduleReconnectPlayerBotIfNeeded(robloxUsername) {
    if (!gameState.activePlayers.has(robloxUsername)) {
        playerBotReconnectAttempts.delete(robloxUsername);
        return;
    }

    const connectedAt = playerBotConnectedAt.get(robloxUsername) || 0;
    if (connectedAt && Date.now() - connectedAt >= STABLE_CONNECTION_MS) playerBotReconnectAttempts.delete(robloxUsername);
    playerBotConnectedAt.delete(robloxUsername);
    const attempt = (playerBotReconnectAttempts.get(robloxUsername) || 0) + 1;
    playerBotReconnectAttempts.set(robloxUsername, attempt);
    const delay = Math.max(
        Math.min(
            PLAYER_BOT_RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1),
            PLAYER_BOT_RECONNECT_MAX_DELAY_MS
        ),
        playerBotKickDelay.get(robloxUsername) || 0 // delai impose par la raison du dernier kick (anti-kick)
    );
    playerBotKickDelay.delete(robloxUsername);

    console.log(`⚠️ [Rbx_${robloxUsername}] Deconnecte (timeout/erreur) : reconnexion dans ${Math.round(delay / 1000)}s (tentative ${attempt}).`);

    setTimeout(() => {
        // Le joueur a pu quitter Roblox pendant le delai de backoff.
        if (gameState.activePlayers.has(robloxUsername)) {
            spawnPlayerBot(robloxUsername);
        } else {
            playerBotReconnectAttempts.delete(robloxUsername);
        }
    }, delay);
}

// Construit un pseudo Minecraft "Rbx_XXX" garanti unique parmi les bots
// miroirs actuellement connectes (voir activeMcUsernames ci-dessus). En cas
// de collision, on raccourcit la base pour laisser la place a un suffixe
// numerique _2, _3, ... tout en restant dans la limite de 16 caracteres
// ("Rbx_" + 12 caracteres max, comme avant ce fix).
function buildUniqueMcUsername(cleanName) {
    const candidate = `Rbx_${cleanName}`;
    if (!activeMcUsernames.has(candidate)) return candidate;

    for (let suffix = 2; suffix <= 99; suffix++) {
        const suffixStr = String(suffix);
        const shortenedBase = cleanName.substring(0, Math.max(0, 12 - suffixStr.length));
        const attempt = `Rbx_${shortenedBase}${suffixStr}`;
        if (!activeMcUsernames.has(attempt)) return attempt;
    }
    // Improbable (99 collisions simultanees sur la meme base tronquee) : on
    // part quand meme avec ce nom plutot que de bloquer la connexion.
    return `Rbx_${cleanName}${Date.now() % 1000}`;
}

// ---------------------------------------------------------
// INVENTAIRE CONNECTE MINEFLAYER (ajout)
// Miroir de l'inventaire REEL du bot miroir de chaque joueur Roblox. A chaque
// changement de slot (pose d'un bloc, ramassage, don creatif...) un snapshot
// "inventory_sync" est envoye au client Lua via /api/poll.
// Numerotation cote Roblox : 1..9 = hotbar (slots MC 36..44),
// 10..36 = sac (slots MC 9..35).
// ---------------------------------------------------------
const INVENTORY_SYNC_DEBOUNCE_MS = 150;
const inventorySyncTimers = new Map(); // robloxUsername -> timer en attente

function buildInventorySnapshot(bot) {
    const items = [];
    for (let invSlot = 9; invSlot <= 44; invSlot++) {
        const it = bot.inventory.slots[invSlot];
        if (!it) continue;
        const uiSlot = invSlot >= 36 ? invSlot - 35 : invSlot + 1;
        items.push({ slot: uiSlot, name: it.name, label: it.displayName || it.name, count: it.count });
    }
    const quickBar = Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : 0;
    return { items, selected: quickBar + 1 };
}

function pushInventorySync(robloxUsername, bot) {
    if (!bot || !bot.inventory) return;
    const snap = buildInventorySnapshot(bot);
    queueCommand({ command: 'inventory_sync', player: robloxUsername, items: snap.items, selected: snap.selected });
}

// Regroupe les rafales d'updateSlot (ex: equip + place) en un seul envoi.
function scheduleInventorySync(robloxUsername, bot) {
    if (inventorySyncTimers.has(robloxUsername)) return;
    inventorySyncTimers.set(robloxUsername, setTimeout(() => {
        inventorySyncTimers.delete(robloxUsername);
        try { pushInventorySync(robloxUsername, bot); }
        catch (err) { console.error(`[Inventaire] Erreur sync pour ${robloxUsername} :`, err.message); }
    }, INVENTORY_SYNC_DEBOUNCE_MS));
}

function clearInventorySync(robloxUsername) {
    const timer = inventorySyncTimers.get(robloxUsername);
    if (timer) clearTimeout(timer);
    inventorySyncTimers.delete(robloxUsername);
}

function attachInventorySync(robloxUsername, bot) {
    if (!bot.inventory) return;
    const trigger = () => scheduleInventorySync(robloxUsername, bot);
    bot.inventory.on('updateSlot', trigger);
    bot.on('heldItemChanged', trigger);
    bot.once('spawn', trigger);
}

// ---------------------------------------------------------
// POSE DE BLOC ROBUSTE (ajout) : remplace l'ancienne logique inline de
// "Roblox-Action" / place. Corrige la pose "au-dessus" qui echouait quand :
//   * la case cible contenait une plante/eau (herbe haute, fougere...) : l'ancien
//     test "name !== 'air'" la refusait alors que Minecraft la remplace ;
//   * le bloc d'appui choisi n'etait pas solide (plante, eau) ;
//   * le bot miroir etait trop loin de la case (le ClickDetector Roblox porte a
//     ~6 blocs, la portee de pose Minecraft est ~4.5 blocs) ;
//   * le bot se tenait lui-meme dans la case visee.
// ---------------------------------------------------------
const REPLACEABLE_BLOCK_NAMES = new Set([
    'air', 'cave_air', 'void_air', 'water', 'short_grass', 'grass', 'tall_grass',
    'fern', 'large_fern', 'dead_bush', 'seagrass', 'tall_seagrass',
]);
const PLACE_REACH_BLOCKS = 5.5;      // marge au-dela de la portee vanilla (4.5 survie / 6 creatif)
const PLACE_APPROACH_WAIT_MS = 1500; // temps laisse au bot (qui suit le joueur) pour se rapprocher

// Noms de blocs du menu creatif Roblox qui ne sont pas des items Minecraft : convertis ici
// vers le vrai item avant la pose (ex: "neige_block" = bloc de neige, asset Roblox different).
const BLOCK_NAME_ALIASES = {
    neige_block: 'snow_block',
    ice_block: 'ice',
};

async function placeBlockForPlayer(playerBot, player, x, y, z, mcItemName, opts = {}) {
    mcItemName = BLOCK_NAME_ALIASES[mcItemName] || mcItemName;
    const targetPos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
    const tag = `[Pose] ${player} -> (${targetPos.x},${targetPos.y},${targetPos.z}) "${mcItemName}"`;
    const fail = (why) => {
        console.log(`${tag} ECHEC : ${why}`);
        try { invalidateChunkAt(targetPos.x, targetPos.z); } catch (e) { ignoreErr(e); }
    };

    const existing = playerBot.blockAt(targetPos);
    if (!existing) return fail('chunk non charge cote bot (blockAt = null)');
    if (!REPLACEABLE_BLOCK_NAMES.has(existing.name)) return fail(`case deja occupee par "${existing.name}"`);

    // Le bot ne doit pas se tenir dans la case visee (pieds ou tete).
    const bp = playerBot.entity.position;
    const bx = Math.floor(bp.x), by = Math.floor(bp.y), bz = Math.floor(bp.z);
    if (bx === targetPos.x && bz === targetPos.z && (by === targetPos.y || by + 1 === targetPos.y)) {
        return fail('le bot se tient dans la case visee');
    }

    // Bloc d'appui SOLIDE : dessous d'abord (cas "pose au-dessus"), puis les cotes, puis le dessus.
    const neighborOffsets = [
        new Vec3(0, -1, 0),
        new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1),
        new Vec3(0, 1, 0),
    ];
    let referenceBlock = null;
    let faceVector = null;
    for (const offset of neighborOffsets) {
        const neighbor = playerBot.blockAt(targetPos.plus(offset));
        if (neighbor && neighbor.boundingBox === 'block') {
            referenceBlock = neighbor;
            faceVector = offset.scaled(-1);
            break;
        }
    }
    if (!referenceBlock) return fail('aucun bloc solide adjacent pour servir d\'appui');

    // POSE PAR COORDONNEES (panneau Z/Y/X cote Roblox, opts.remote) : la case visee peut etre
    // loin du joueur, donc loin du bot qui le suit. On envoie le bot a ~3 blocs de la case
    // (8 s max) avant le controle de portee ci-dessous. Si le trajet echoue, le controle de
    // portee refusera la pose avec un message clair.
    if (opts.remote && playerBot.pathfinder) {
        const preCenter = targetPos.offset(0.5, 0.5, 0.5);
        const preDist = () => playerBot.entity.position.offset(0, 1.62, 0).distanceTo(preCenter);
        if (preDist() > PLACE_REACH_BLOCKS) {
            try {
                await Promise.race([
                    playerBot.pathfinder.goto(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3)),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('delai depasse (8 s)')), 8000)),
                ]);
            } catch (err) {
                console.log(`${tag} approche impossible : ${err.message}`);
            }
            if (!playerBot.entity) return fail('bot deconnecte pendant l\'approche');
        }
    }

    // Portee : on laisse un peu de temps au bot (qui suit le joueur) pour se rapprocher.
    const targetCenter = targetPos.offset(0.5, 0.5, 0.5);
    const distToTarget = () => playerBot.entity.position.offset(0, 1.62, 0).distanceTo(targetCenter);
    for (let waited = 0; distToTarget() > PLACE_REACH_BLOCKS && waited < PLACE_APPROACH_WAIT_MS; waited += 100) {
        await new Promise(r => setTimeout(r, 100));
        if (!playerBot.entity) return fail('bot deconnecte pendant l\'attente');
    }
    if (distToTarget() > PLACE_REACH_BLOCKS) {
        return fail(`bot trop loin (${distToTarget().toFixed(1)} blocs, portee ${PLACE_REACH_BLOCKS}) : approche-toi du bloc`);
    }

    // Item : inventaire du bot, sinon don creatif dans le slot 36 (1er slot de la hotbar).
    const legacy = toLegacyItem(playerBot, mcItemName); // 1.12.x : 'birch_planks' -> planks + metadata 2
    let item = playerBot.inventory.items().find(i => i.name === legacy.name && (!legacy.metadata || i.metadata === legacy.metadata));
    if (!item && playerBot.game && playerBot.game.gameMode === 'creative' && playerBot.creative && playerBot.registry) {
        const itemData = playerBot.registry.itemsByName[legacy.name];
        if (itemData) {
            const PItem = require('prismarine-item')(playerBot.registry);
            await playerBot.creative.setInventorySlot(36, new PItem(itemData.id, 64, legacy.metadata || null));
            item = playerBot.inventory.slots[36];
        }
    }
    if (!item) return fail(`pas de "${mcItemName}" en inventaire (et pas en creatif)`);

    try {
        await playerBot.equip(item, 'hand');
        await playerBot.placeBlock(referenceBlock, faceVector);
        console.log(`${tag} OK (appui : ${referenceBlock.name})`);
        trackPlacedBlock(targetPos.x, targetPos.y, targetPos.z);
        try { invalidateChunkAt(targetPos.x, targetPos.z); } catch (e) { ignoreErr(e); } // rescan : le payload contient aussi le bloc du dessous
    } catch (err) {
        fail(`placeBlock a echoue : ${err.message}`);
    }
}

// ---------------------------------------------------------
// ASSISTANCE A L'ESCALADE DU BOT MIROIR (ajout)
// Probleme : le bot miroir est volontairement bride (canDig/towers/scaffolding = false, voir
// spawnPlayerBot) pour ne jamais modifier le monde. Il ne sait donc franchir qu'une marche de
// 1 bloc : des que le joueur Roblox monte sur des blocs EMPILES (pilier, mur, escalier a 2+
// blocs), le bot reste bloque au pied et ne peut plus le rejoindre.
// Solution : si le joueur reste plus haut que le bot (>= 1,6 bloc) pendant 1,5 s, ET que le bot
// est en mode CREATIF, on le fait VOLER jusqu'au joueur (montee verticale puis approche
// horizontale a l'altitude du joueur), puis on coupe le vol : il se pose sur les blocs.
// Aucun bloc n'est casse ni pose. En SURVIE (ou si le vol echoue) on tente un /tp du bot vers le
// joueur (compte du bot OP requis) ; sans OP un message l'indique, une seule fois.
// ---------------------------------------------------------
const BOT_CLIMB_ASSIST = true;     // false = desactive completement
const CLIMB_MIN_DY = 1.6;          // ecart de hauteur (blocs) au-dela duquel le bot est "bloque en bas"
const CLIMB_MAX_DY = 24;           // au-dela : le joueur est trop haut/loin, on ne tente rien
const CLIMB_MAX_HORIZ = 10;        // distance horizontale max (blocs) pour declencher l'aide
const CLIMB_STUCK_MS = 1500;       // duree pendant laquelle l'ecart doit persister
const CLIMB_COOLDOWN_MS = 4000;    // delai minimum entre deux aides
const CLIMB_TICK_MS = 500;         // frequence de surveillance
const CLIMB_FLY_TIMEOUT_MS = 6000; // limite par phase de vol
const BOT_CLIMB_TP_FALLBACK = true; // si le vol est impossible (survie) ou echoue : /tp du bot a cote du joueur (necessite OP)
const CLIMB_TP_CHECK_MS = 1500;     // delai avant de verifier que le /tp a marche
const climbAssistTimers = new Map(); // robloxUsername -> setInterval
const climbAssistState = new Map();  // robloxUsername -> { stuckSince, lastAssist, climbing, lastBotY, warned }

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label} : delai depasse (${ms} ms)`)), ms); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Teleporte le bot sur la case du joueur avec /tp (le compte du bot doit etre OP). On verifie ensuite
// que le bot a bien bouge : sinon on memorise que /tp est refuse pour ne plus spammer le chat.
async function tryTeleportBot(robloxUsername, bot, st) {
    const tag = `[Escalade] ${robloxUsername}`;
    if (!BOT_CLIMB_TP_FALLBACK || st.tpDenied) return false;
    const rbx = robloxPlayersState[robloxUsername];
    if (!rbx || !bot.entity) return false;
    const tx = rbx.x, ty = rbx.y + 0.1, tz = rbx.z;
    try {
        bot.chat(`/tp ${bot.username} ${tx.toFixed(2)} ${ty.toFixed(2)} ${tz.toFixed(2)}`);
    } catch (err) {
        console.log(`${tag} /tp impossible : ${err.message}`);
        return false;
    }
    await new Promise(r => setTimeout(r, CLIMB_TP_CHECK_MS));
    if (!bot.entity) return false;
    const p = bot.entity.position;
    if (Math.hypot(p.x - tx, p.y - ty, p.z - tz) <= 3) {
        console.log(`${tag} teleporte au joueur avec /tp`);
        return true;
    }
    st.tpDenied = true;
    console.log(`${tag} /tp sans effet : le compte "${bot.username}" n'est probablement pas OP. Donne-lui OP (ou passe-le en creatif) pour qu'il puisse monter sur les blocs empiles.`);
    return false;
}

async function runClimbAssist(robloxUsername, bot, st, canFly) {
    const tag = `[Escalade] ${robloxUsername}`;
    try {
        const rbx = robloxPlayersState[robloxUsername];
        if (!rbx || !bot.entity) return;
        try { bot.pathfinder.setGoal(null); } catch (e) { ignoreErr(e); } // le pathfinder ne doit pas lutter contre le vol / le /tp
        const gap = rbx.y - bot.entity.position.y;
        const mode = bot.game ? bot.game.gameMode : 'inconnu';
        console.log(`${tag} bot bloque en bas (joueur ${gap.toFixed(1)} blocs plus haut, mode ${mode}) : ${canFly ? 'vol jusqu\'au joueur' : '/tp vers le joueur'}`);

        if (canFly) {
            try {
                const topY = Math.max(bot.entity.position.y, rbx.y) + 1;
                // Phase 1 : monter a la verticale (colonne d'air au-dessus du bot)
                await withTimeout(bot.creative.flyTo(new Vec3(bot.entity.position.x, topY, bot.entity.position.z)), CLIMB_FLY_TIMEOUT_MS, 'montee');
                // Phase 2 : rejoindre le joueur a cette altitude (position la plus recente)
                const latest = robloxPlayersState[robloxUsername] || rbx;
                await withTimeout(bot.creative.flyTo(new Vec3(latest.x, topY, latest.z)), CLIMB_FLY_TIMEOUT_MS, 'approche');
            } catch (err) {
                console.log(`${tag} vol interrompu : ${err.message}`);
            } finally {
                try { bot.creative.stopFlying(); } catch (e) { ignoreErr(e); } // le bot retombe et se pose sur les blocs
            }
            // Le vol n'a pas suffi (plafond, rubberband...) : on tente le /tp.
            await new Promise(r => setTimeout(r, 800));
            const after = robloxPlayersState[robloxUsername];
            if (after && bot.entity && after.y - bot.entity.position.y >= CLIMB_MIN_DY) {
                await tryTeleportBot(robloxUsername, bot, st);
            }
        } else {
            await tryTeleportBot(robloxUsername, bot, st);
        }
    } catch (err) {
        console.log(`${tag} erreur : ${err.message}`);
    }
}

function climbAssistTick(robloxUsername, bot, now = Date.now()) {
    let st = climbAssistState.get(robloxUsername);
    if (!st) {
        st = { stuckSince: null, lastAssist: 0, climbing: false, lastBotY: null, warned: false, tpDenied: false };
        climbAssistState.set(robloxUsername, st);
    }
    if (st.climbing || !bot.entity) return;

    const rbx = robloxPlayersState[robloxUsername];
    if (!rbx || !Number.isFinite(rbx.y) || (now - rbx.lastUpdate) > 5000) { st.stuckSince = null; return; }

    const pos = bot.entity.position;
    const dy = rbx.y - pos.y;
    const horiz = Math.hypot(rbx.x - pos.x, rbx.z - pos.z);
    const botRose = st.lastBotY !== null && pos.y - st.lastBotY > 0.3; // le bot monte deja tout seul
    st.lastBotY = pos.y;

    if (!(dy >= CLIMB_MIN_DY && dy <= CLIMB_MAX_DY && horiz <= CLIMB_MAX_HORIZ) || botRose) { st.stuckSince = null; return; }
    if (st.stuckSince === null) { st.stuckSince = now; return; }
    if (now - st.stuckSince < CLIMB_STUCK_MS || now - st.lastAssist < CLIMB_COOLDOWN_MS) return;

    const canFly = !!(bot.game && bot.game.gameMode === 'creative' && bot.creative);
    if (!canFly && !(BOT_CLIMB_TP_FALLBACK && !st.tpDenied)) {
        if (!st.warned) {
            st.warned = true;
            console.log(`[Escalade] ${robloxUsername} : le bot ne peut pas monter sur les blocs empiles en mode ${bot.game ? bot.game.gameMode : 'inconnu'} (vol impossible, /tp indisponible). Passe-le en creatif ou donne-lui OP.`);
        }
        return;
    }

    st.climbing = true;
    st.stuckSince = null;
    st.lastAssist = now;
    runClimbAssist(robloxUsername, bot, st, canFly).finally(() => { st.climbing = false; st.lastAssist = Date.now(); });
}

function startClimbAssist(robloxUsername, bot) {
    if (!BOT_CLIMB_ASSIST) return;
    stopClimbAssist(robloxUsername);
    climbAssistTimers.set(robloxUsername, setInterval(() => {
        try { climbAssistTick(robloxUsername, bot); }
        catch (err) { console.error(`[Escalade] Erreur surveillance ${robloxUsername} :`, err.message); }
    }, CLIMB_TICK_MS));
}

function stopClimbAssist(robloxUsername) {
    const timer = climbAssistTimers.get(robloxUsername);
    if (timer) clearInterval(timer);
    climbAssistTimers.delete(robloxUsername);
    climbAssistState.delete(robloxUsername);
}

function spawnPlayerBot(robloxUsername) {
    if (activeBots.has(robloxUsername)) return;
    // FIX JOUEUR (bot orphelin) : le bot est lance 1 s apres Roblox-Join ; si le joueur est deja
    // reparti entre-temps, on ne cree plus un bot miroir que personne ne retirerait.
    if (!gameState.activePlayers.has(robloxUsername)) return;

    let cleanName = robloxUsername.replace(/[^a-zA-Z0-9_]/g, '');
    if (cleanName.length > 12) cleanName = cleanName.substring(0, 12);
    const mcUsername = buildUniqueMcUsername(cleanName);
    activeMcUsernames.add(mcUsername);
    playerBotMcUsernames.set(robloxUsername, mcUsername);

    console.log(`🤖 [ROBLOX -> MC] Connexion du bot miroir : ${mcUsername}`);

    try {
        const activeSrv = getActiveServer();
        const playerBot = mineflayer.createBot({
            host: activeSrv.host,
            port: activeSrv.port,
            username: mcUsername,
            auth: activeSrv.auth,
            version: mcVersionOption(activeSrv.version),
            checkTimeoutInterval: 60000,
            logErrors: false // evite les dumps bruts d'erreurs reseau : les handlers 'error' ci-dessous loguent proprement
        });

        playerBot.loadPlugin(pathfinder);
        attachInventorySync(robloxUsername, playerBot); // inventaire connecte (ajout)
        attachAntiKick(playerBot, mcUsername, { jump: false }); // anti-kick (ajout)
        guardInvalidMovePackets(playerBot, mcUsername); // idem : yaw/pitch viennent de Roblox

        playerBot.once('spawn', () => {
            // Le compteur de backoff est remis a zero a la deconnexion, SEULEMENT si la connexion a dure
            // (STABLE_CONNECTION_MS) : sinon un serveur qui expulse juste apres le spawn serait martele toutes les 2 s.
            playerBotConnectedAt.set(robloxUsername, Date.now());
            playerBot.chat(`Virtuel de ${robloxUsername} actif ! 🎮`);
            try {
                const mcData = require('minecraft-data')(playerBot.version);
                const playerMovements = new Movements(playerBot, mcData);
                // BUG CORRIGE (mouvement "trop aleatoire", n'a plus rien a voir
                // avec le vrai joueur) : la config par defaut de
                // mineflayer-pathfinder autorisait ce bot a creuser des blocs
                // genants, en poser (scaffolding/tours), et faire du parkour
                // des que l'A* jugeait ca "plus rapide" pour rejoindre le
                // GoalNear recalcule a chaque Roblox-Move. Ce bot ne doit que
                // suivre le chemin direct deja disponible, jamais modifier le
                // monde ni prendre de raccourcis acrobatiques.
                playerMovements.canDig = false;
                playerMovements.allow1by1towers = false;
                playerMovements.allowParkour = false;
                playerMovements.scafoldingBlocks = [];
                // Vise la cible en ligne droite quand la ligne de vue est
                // degagee, au lieu de systematiquement suivre la grille de
                // blocs Nord/Sud/Est/Ouest (qui donnait un mouvement en
                // escalier/zigzag peu naturel pour un mouvement miroir).
                playerMovements.allowFreeMotion = true;
                playerBot.pathfinder.setMovements(playerMovements);
            } catch (err) {
                console.error(`[${mcUsername}] Erreur mcData:`, err.message);
            }
            startClimbAssist(robloxUsername, playerBot); // aide a l'escalade (ajout)
        });

        playerBot.on('error', err => {
            if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') return; // serveur MC eteint : la reconnexion avec backoff s'en charge
            if (err.code === 'ECONNRESET' || err.message?.includes('timed out')) {
                playerBotKickDelay.set(robloxUsername, Math.max(playerBotKickDelay.get(robloxUsername) || 0, 8000)); // plancher anti-martelage
                return;
            }
            console.log(`⚠️ [${mcUsername}] Erreur:`, err.message);
        });

        playerBot.on('kicked', reason => {
            const text = kickReasonToText(reason);
            playerBotKickDelay.set(robloxUsername, kickReconnectDelayMs(text));
            console.log(`⚠️ [${mcUsername}] Expulse: ${text}`);
            if (isServerFullKickText(text)) {
                markServerFull(activeSrv.id, 'bot miroir refuse');
                selectActiveServer('mirror-full'); // bascule + reconnexion des bots si un autre serveur est libre
            }
        });

        playerBot.on('end', () => {
            clearInventorySync(robloxUsername);
            stopClimbAssist(robloxUsername);
            activeBots.delete(robloxUsername);
            const usedMcUsername = playerBotMcUsernames.get(robloxUsername);
            if (usedMcUsername) activeMcUsernames.delete(usedMcUsername);
            playerBotMcUsernames.delete(robloxUsername);
            scheduleReconnectPlayerBotIfNeeded(robloxUsername);
        });

        activeBots.set(robloxUsername, playerBot);
    } catch (e) {
        console.log(`⚠️ [ERREUR BOT ROBLOX] Impossible de créer ${mcUsername}:`, e.message);
    }
}

function removePlayerBot(robloxUsername) {
    const playerBot = activeBots.get(robloxUsername);
    if (playerBot) {
        try { playerBot.quit(); } catch (e) { ignoreErr(e); }
        activeBots.delete(robloxUsername);
    }
    // Depart volontaire : purge des maps de throttle/backoff/decalage (memes
    // principes que les autres Maps par-joueur du fichier), pour ne pas les
    // faire grossir indefiniment et pour qu'un futur rejoin reparte a zero.
    playerBotLastGoalTime.delete(robloxUsername);
    playerBotLastGoalPos.delete(robloxUsername);
    playerBotReconnectAttempts.delete(robloxUsername);
    playerBotConnectedAt.delete(robloxUsername);
    playerBotKickDelay.delete(robloxUsername);
    playerLastRawPos.delete(robloxUsername);
    clearInventorySync(robloxUsername);
    stopClimbAssist(robloxUsername);
}

// ---------------------------------------------------------
// 5. BOT PRINCIPAL : GrokBot
// ---------------------------------------------------------

// Programme le prochain petit saut anti-AFK de GrokBot a un delai aleatoire
// entre GROKBOT_ANTI_AFK_MIN_INTERVAL_MS et GROKBOT_ANTI_AFK_MAX_INTERVAL_MS,
// puis se reprogramme lui-meme indefiniment tant que le bot est connecte.
// Un delai aleatoire (plutot qu'un setInterval fixe) evite un pattern trop
// mecanique et se rapproche d'une vraie presence.
function scheduleGrokAntiAfkJump() {
    if (!GROKBOT_ANTI_AFK_ENABLED) return;
    if (grokAntiAfkTimer) { clearTimeout(grokAntiAfkTimer); grokAntiAfkTimer = null; } // evite d'empiler une chaine de timers a chaque reconnexion

    const delay = GROKBOT_ANTI_AFK_MIN_INTERVAL_MS +
        Math.random() * (GROKBOT_ANTI_AFK_MAX_INTERVAL_MS - GROKBOT_ANTI_AFK_MIN_INTERVAL_MS);

    grokAntiAfkTimer = setTimeout(() => {
        if (mainBot && mainBot.entity) {
            try {
                mainBot.setControlState('jump', true);
                setTimeout(() => {
                    if (mainBot) {
                        try { mainBot.setControlState('jump', false); } catch (e) { ignoreErr(e); }
                    }
                }, GROKBOT_ANTI_AFK_JUMP_HOLD_MS);
            } catch (e) {
                console.log('⚠️ [GrokBot] Erreur saut anti-AFK:', e.message);
            }
        }
        scheduleGrokAntiAfkJump();
    }, delay);
}

// connectServer() : cree/reconnecte le GrokBot d'un serveur specifique.
// createMainBot() reste en alias legacy pour la compatibilite.
function connectServer(serverId) {
    const srv = SERVERS.find(s => s.id === serverId);
    if (!srv || !srv.enabled) return;
    const state = serverStates.get(serverId);
    if (!state) return;
    if (state.forcedOffline) {
        console.log('[' + srv.name + '] Mis HORS LIGNE manuellement : aucune connexion.');
        return;
    }
    if (state.bot) return; // deja connecte / en cours de connexion (evite un doublon de bot)
    if (isPlaceholderHost(srv.host)) {
        console.warn('[' + srv.name + '] Adresse factice (' + srv.host + ') : connexion annulee. Mets la vraie IP dans servers.json (ou dans SERVERS).');
        return;
    }

    if (state.liveSyncTimer) { clearInterval(state.liveSyncTimer); state.liveSyncTimer = null; }
    if (state.antiAfkTimer)  { clearTimeout(state.antiAfkTimer);  state.antiAfkTimer  = null; }

    console.log('[' + srv.name + '] Connexion de ' + srv.botName + ' a ' + srv.host + ':' + srv.port + '...');

    const bot = mineflayer.createBot({
        host: srv.host,
        port: srv.port,
        username: srv.botName,
        auth: srv.auth,
        version: mcVersionOption(srv.version),
        checkTimeoutInterval: 60000,
        // Vue du bot : assez large pour recevoir les chunks du rendu lointain (le serveur MC plafonne a son view-distance).
        viewDistance: BOT_INITIAL_VIEW_DISTANCE, // monte ensuite par paliers jusqu'a la distance voulue (voir 'spawn')
        logErrors: false // evite les dumps bruts d'erreurs reseau : le handler 'error' ci-dessous loggue proprement
    });

    state.bot = bot;
    if (serverId === activeServerId) mainBot = bot;

    bot.loadPlugin(pathfinder);
    attachAntiKick(bot, srv.name + '/' + srv.botName, { jump: false, walk: true }); // anti-kick + anti-AFK par deplacement (ajout)
    guardInvalidMovePackets(bot, srv.name + '/' + srv.botName); // jamais de paquet NaN vers le serveur ("Invalid move player packet received")

    bot.once('spawn', () => {
        state.connectedAt = Date.now(); // le backoff n'est remis a zero qu'a la deconnexion, si la connexion a dure (STABLE_CONNECTION_MS)
        state.kickDelayMs = 0;
        console.log('[' + srv.name + '] ' + srv.botName + ' connecte !');
        // Annonce dans le chat differee : un message envoye a la milliseconde du spawn est mal vu des plugins de
        // login / anti-bot (et de certains proxies).
        // Pas d'annonce si la connexion precedente etait une session courte (boucle de reconnexion) : sinon le chat se remplit de "connecte !".
        const announceJoin = !RECONNECT_SPAM_GUARD || !state.shortSessions;
        if (announceJoin) setTimeout(() => { try { if (state.bot === bot && bot.entity) bot.chat(srv.botName + ' connecte !'); } catch (e) { ignoreErr(e); } }, 5000);

        // Montee progressive de la distance de vue (voir BOT_INITIAL_VIEW_DISTANCE).
        {
            const targetView = Math.min(32, Math.max(12, FAR_RENDER_RADIUS_CHUNKS));
            // Plafond appris : si une coupure ECONNRESET est survenue juste apres un palier (voir le handler 'end'),
            // on ne redemande plus ce palier ni les suivants a ce serveur.
            const capView = state.rampMaxView || 0; // 0 = pas de plafond
            const steps = [8, 12, 16, 24, 32].filter(v => v > BOT_INITIAL_VIEW_DISTANCE && v < targetView && (!capView || v <= capView));
            if (targetView > BOT_INITIAL_VIEW_DISTANCE && (!capView || targetView <= capView)) steps.push(targetView);
            if (capView) console.log('[' + srv.name + '] Distance de vue plafonnee a ' + capView + ' chunks (le serveur coupait la connexion au-dela).');
            state.rampLastAt = 0;
            let appliedView = BOT_INITIAL_VIEW_DISTANCE;
            let rampTimer = null;
            let rampIdx = 0;
            const nextStep = () => {
                rampTimer = null;
                if (state.bot !== bot || !bot.entity || rampIdx >= steps.length) return;
                const v = steps[rampIdx++];
                state.rampPrevView = appliedView; state.rampLastView = v; state.rampLastAt = Date.now(); appliedView = v;
                try { bot.setSettings({ viewDistance: v }); console.log('[' + srv.name + '] Distance de vue -> ' + v + ' chunks.'); } catch (e) { ignoreErr(e); }
                rampTimer = setTimeout(nextStep, BOT_VIEW_RAMP_STEP_MS);
            };
            rampTimer = setTimeout(nextStep, BOT_VIEW_RAMP_START_MS);
            bot.once('end', () => { if (rampTimer) { clearTimeout(rampTimer); rampTimer = null; } });
        }

        // Connexion acceptee : le serveur n'est pas plein a cet instant.
        state.full = false;
        state.fullReason = '';
        state.worldData.serverOnline = true;
        // Trop-plein : prend la main (ou la rend) selon l'etat de tous les serveurs.
        selectActiveServer('spawn');

        try {
            const mcData = require('minecraft-data')(bot.version);
            bot.pathfinder.setMovements(new Movements(bot, mcData));
        } catch (err) {
            console.error('[' + srv.botName + '] Erreur mcData:', err.message);
        }

        bot.on('blockUpdate', (oldBlock, newBlock) => {
            if (!oldBlock || !newBlock) return;
            if (serverId !== activeServerId) return; // serveur en veille : son monde n'est pas affiche
            invalidateChunkAt(newBlock.position.x, newBlock.position.z);
            if (oldBlock.name !== 'air' && newBlock.name === 'air') {
                queueCommand({ command: 'break_block',
                    x: oldBlock.position.x, y: oldBlock.position.y, z: oldBlock.position.z,
                    name: oldBlock.name }, serverId);
            } else if (oldBlock.name === 'air' && newBlock.name !== 'air') {
                queueCommand({ command: 'spawn_block',
                    x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z,
                    name: newBlock.name }, serverId);
            }
        });

        if (bot._client) {
            bot._client.on('animation', (packet) => {
                if (packet.animation === 0 && bot.entities) {
                    const entity = bot.entities[packet.entityId];
                    if (entity && entity.type === 'player' && entity.username !== bot.username) {
                        mcPlayerAttackingState.set(entity.username, true);
                        setTimeout(() => mcPlayerAttackingState.set(entity.username, false), 300);
                    }
                }
            });

            bot._client.on('block_break_animation', (packet) => {
                if (!bot.entities) return;
                const entity = bot.entities[packet.entityId];
                if (!entity || entity.type !== 'player' || entity.username === bot.username) return;
                const username = entity.username;
                const isDiggingNow = packet.destroyStage >= 0 && packet.destroyStage <= 9;
                const existingTimeout = mcPlayerDiggingTimeout.get(username);
                if (existingTimeout) clearTimeout(existingTimeout);
                if (isDiggingNow) {
                    mcPlayerDiggingState.set(username, true);
                    mcPlayerDiggingTimeout.set(username, setTimeout(() => {
                        mcPlayerDiggingState.set(username, false);
                        mcPlayerDiggingTimeout.delete(username);
                    }, 1000));
                } else {
                    mcPlayerDiggingState.set(username, false);
                    mcPlayerDiggingTimeout.delete(username);
                }
            });

            bot._client.on('entity_status', (packet) => {
                if (packet.entityStatus !== 3 || !bot.entities) return;
                const entity = bot.entities[packet.entityId];
                if (!entity || entity.type !== 'player' || entity.username === bot.username) return;
                const username = entity.username;
                mcPlayerDeadState.set(username, true);
                const existingDeathTimeout = mcPlayerDeadTimeout.get(username);
                if (existingDeathTimeout) clearTimeout(existingDeathTimeout);
                mcPlayerDeadTimeout.set(username, setTimeout(() => {
                    mcPlayerDeadState.set(username, false);
                    mcPlayerDeadTimeout.delete(username);
                }, DEATH_ANIM_DURATION_MS));
            });
        }

        bot.on('rain', () => {
            console.log('[' + srv.botName + '] Meteo : ' + (bot.isRaining ? 'pluie' : 'sec'));
        });

        bot.on('chat', (username, message) => {
            if (username === bot.username) return;
            chatMessages.push({ time: Date.now(), sender: username, message: message, server: srv.name });
            if (chatMessages.length > 20) chatMessages.shift();
        });

        bot.on('playerLeft', (leftPlayer) => {
            const username = leftPlayer && leftPlayer.username;
            if (!username) return;
            mcPlayerPrevPos.delete(username);
            mcPlayerAttackingState.delete(username);
            mcPlayerDiggingState.delete(username);
            const t1 = mcPlayerDiggingTimeout.get(username);
            if (t1) clearTimeout(t1);
            mcPlayerDiggingTimeout.delete(username);
            mcPlayerDeadState.delete(username);
            const t2 = mcPlayerDeadTimeout.get(username);
            if (t2) clearTimeout(t2);
            mcPlayerDeadTimeout.delete(username);
        });

        startLiveSyncForServer(serverId);
        if (serverId === activeServerId) scheduleGrokAntiAfkJump();
    });

    bot.on('error', err => {
        state.lastErrorCode = err.code || err.message || 'erreur';
        if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'EHOSTUNREACH') {
            console.log('[' + srv.name + '] Serveur injoignable (' + err.code + ' ' + srv.host + ':' + srv.port + ') : il est eteint ou le port est ferme. Nouvelle tentative automatique.');
            return;
        }
        if (err.code === 'ECONNRESET' || err.message && err.message.includes('timed out')) {
            console.log('[' + srv.name + '] Connexion coupee par le serveur ou le reseau (' + (err.code || 'timeout') + ').');
            state.kickDelayMs = Math.max(state.kickDelayMs || 0, 8000); // evite de marteler un serveur qui coupe les sockets (anti-spam / lag / redemarrage)
            return;
        }
        console.log('[' + srv.name + '] Erreur:', err.message);
    });
    bot.on('kicked', reason => {
        const text = kickReasonToText(reason);
        state.kickDelayMs = kickReconnectDelayMs(text);
        state.lastKickText = text;
        console.log('[' + srv.name + '] Expulse:', text);
        if (isOnlineModeKickText(text)) {
            console.warn('[' + srv.name + '] Ce serveur est en mode ONLINE (premium) : le bot "' + srv.botName + '" en auth \'' + srv.auth + '\' est refuse. '
                + 'Soit le serveur passe en online-mode=false (cracked), soit utilise un compte Minecraft : auth "microsoft" dans servers.json.');
        }
        if (isServerFullKickText(text)) markServerFull(serverId, 'refuse : serveur plein');
    });
    bot.on('end', endReason => {
        if (endReason && endReason !== 'socketClosed') console.log('[' + srv.name + '] Fin de connexion : ' + endReason);
        // DIAGNOSTIC : le bot a-t-il ete coupe AVANT d'apparaitre (login refuse) ou apres ?
        if (state.connectedAt) {
            console.log('[' + srv.name + '] Coupe ' + Math.round((Date.now() - state.connectedAt) / 1000) + ' s apres son apparition'
                + (state.lastKickText ? ' (raison : ' + state.lastKickText + ')' : (state.lastErrorCode ? ' (erreur : ' + state.lastErrorCode + ')' : ' (aucune raison donnee par le serveur : redemarrage, anti-bot, ou perte reseau)')) + '.');
        } else if (state.lastErrorCode !== 'ENOTFOUND' && state.lastErrorCode !== 'ECONNREFUSED' && state.lastErrorCode !== 'EHOSTUNREACH') {
            console.log('[' + srv.name + '] Coupe AVANT l\'apparition (pendant la connexion / le login)'
                + (state.lastKickText ? ' : ' + state.lastKickText : (state.lastErrorCode ? ' : ' + state.lastErrorCode : ''))
                + '. Causes frequentes : serveur en mode online (premium), liste blanche, mauvaise version (version "' + srv.version + '"), protection anti-bot, serveur qui redemarre.');
        }
        // Coupure franche (ECONNRESET, sans raison de kick) dans les 10 s qui suivent un palier de distance de vue :
        // on retient le palier precedent comme plafond pour les prochaines connexions de ce serveur.
        if (state.lastErrorCode === 'ECONNRESET' && !state.lastKickText && state.connectedAt
            && state.rampLastAt && state.rampLastAt >= state.connectedAt && Date.now() - state.rampLastAt < 10000) {
            state.rampMaxView = state.rampPrevView || BOT_INITIAL_VIEW_DISTANCE;
            console.log('[' + srv.name + '] Coupe juste apres le passage a ' + state.rampLastView + ' chunks : plafond ramene a ' + state.rampMaxView + ' chunks aux prochaines connexions.');
        }
        state.rampLastAt = 0;
        state.lastKickText = ''; state.lastErrorCode = '';
        // Session courte (coupee avant STABLE_CONNECTION_MS apres l'apparition) : compte pour l'anti-spam "left the game".
        if (state.connectedAt) {
            if (Date.now() - state.connectedAt >= STABLE_CONNECTION_MS) state.shortSessions = 0;
            else state.shortSessions = (state.shortSessions || 0) + 1;
        }
        if (state.connectedAt && Date.now() - state.connectedAt >= STABLE_CONNECTION_MS) state.reconnectAttempts = 0; // connexion stable : on repart d'un delai court
        state.connectedAt = 0;
        state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;
        const spamDelay = RECONNECT_SPAM_GUARD ? shortSessionDelayMs(state.shortSessions || 0) : 0;
        const reconnectDelay = Math.max(reconnectBackoffMs(state.reconnectAttempts), state.kickDelayMs || 0, spamDelay);
        state.kickDelayMs = 0;
        console.log('[' + srv.name + '] Deconnecte. Reconnexion dans ' + Math.round(reconnectDelay / 1000) + 's (tentative ' + state.reconnectAttempts + ')'
            + (spamDelay > 0 ? ' [anti-spam : ' + state.shortSessions + ' connexion(s) courte(s) d\'affilee]' : '') + '...');
        if (grokAntiAfkTimer && serverId === activeServerId) { clearTimeout(grokAntiAfkTimer); grokAntiAfkTimer = null; }
        state.bot = null;
        state.worldData.serverOnline = false;
        if (state.liveSyncTimer) { clearInterval(state.liveSyncTimer); state.liveSyncTimer = null; }
        if (state.antiAfkTimer)  { clearTimeout(state.antiAfkTimer);  state.antiAfkTimer  = null; }
        if (serverId === activeServerId) {
            selectActiveServer('end');
            mainBot = (serverStates.get(activeServerId) || {}).bot || null;
        }
        setTimeout(() => connectServer(serverId), reconnectDelay);
    });
}

function createMainBot() {
    const target = activeServerId || ((SERVERS.find(s => s.enabled) || SERVERS[0]).id);
    connectServer(target);
}


// ---------------------------------------------------------
// 6. BOUCLE DE SYNCHRONISATION LIVE & DÉCALAGE LATÉRAL
// ---------------------------------------------------------
function startLiveSyncForServer(serverId) {
    const state = serverStates.get(serverId);
    if (!state) return;
    const srv = state.config;
    if (state.liveSyncTimer) clearInterval(state.liveSyncTimer);

    state.liveSyncTimer = setInterval(() => {
        const bot = state.bot;
        if (!bot || !bot.entity || !grokViewEnabled) return;
        if (serverId !== activeServerId) return; // serveur en veille (trop-plein) : pas de scan ni d'envoi

        const pos = bot.entity.position;
        const currentChunkX = Math.floor(pos.x / CHUNK_SIZE);
        const currentChunkZ = Math.floor(pos.z / CHUNK_SIZE);

        const zonesList = [];
        let generatedChunksCount = 0;
        const allVisibleBlocks = [];
        let farTerrainPayload = null; // RENDU LOINTAIN 512x512 (rempli plus bas)

        if (plateauEnabled) {
            // Centres de generation de chunks : GrokBot, plus la derniere position
            // demandee par chaque joueur Roblox connecte (voir "Roblox-RequestChunks",
            // rafraichie des qu'un joueur change de chunk cote client). Le monde se
            // genere donc automatiquement aussi autour des joueurs qui s'eloignent a
            // pied de GrokBot, pas seulement autour du bot principal.
            const scanCenters = [
                { chunkX: currentChunkX, chunkZ: currentChunkZ, radius: chunkRenderDistance, y: pos.y }
            ];
            for (const [, req] of playerChunkRequests) {
                scanCenters.push({
                    chunkX: req.chunkX,
                    chunkZ: req.chunkZ,
                    radius: req.radius || chunkRenderDistance,
                    y: (typeof req.y === 'number') ? req.y : pos.y
                });
            }

            // FIX CHUNKS/JOUEUR : les vrais joueurs Minecraft (MCPlayers) ne
            // declenchaient jusqu'ici AUCUN scan/generation de terrain. Seuls
            // GrokBot (ci-dessus) et les joueurs ROBLOX (playerChunkRequests,
            // via "Roblox-RequestChunks") etaient des centres de scan ; un
            // MCPlayer utilise deja sa position comme centre d'AFFICHAGE cote
            // Lua (voir mcPlayersList plus bas, isMcPlayerChunkInRange), mais
            // si ce joueur s'eloignait de GrokBot au-dela de chunkRenderDistance,
            // le terrain autour de lui n'etait jamais scanne cote serveur -> le
            // MCPlayer restait affiche mais "flottait" au-dessus d'un vide
            // (aucun chunk/bloc genere a cet endroit). Ajout : chaque vrai
            // joueur MC connu de bot.players (hors GrokBot lui-meme et
            // hors bots miroirs Rbx_) devient lui aussi un centre de scan des
            // que mineflayer suit son entite (packet spawn_player recu).
            if (bot.players) {
                for (const playerName in bot.players) {
                    if (playerName === bot.username) continue;
                    let isMirrorBot = false;
                    for (const [, botInstance] of activeBots.entries()) {
                        if (botInstance && botInstance.username === playerName) {
                            isMirrorBot = true;
                            break;
                        }
                    }
                    if (isMirrorBot) continue;
                    const mcPlayerObj = bot.players[playerName];
                    if (mcPlayerObj && mcPlayerObj.entity) {
                        const mcPos = mcPlayerObj.entity.position;
                        scanCenters.push({
                            chunkX: Math.floor(mcPos.x / CHUNK_SIZE),
                            chunkZ: Math.floor(mcPos.z / CHUNK_SIZE),
                            radius: chunkRenderDistance,
                            y: mcPos.y
                        });
                    }
                }
            }

            // 1) Determine tous les chunks visibles (union des rayons de chaque
            //    centre) et met en file de scan ceux qui ne sont pas encore en cache.
            const visibleChunkKeys = new Set();
            for (const center of scanCenters) {
                for (let dx = -center.radius; dx <= center.radius; dx++) {
                    for (let dz = -center.radius; dz <= center.radius; dz++) {
                        const key = `${center.chunkX + dx}_${center.chunkZ + dz}`;
                        visibleChunkKeys.add(key);
                        // On retient l'altitude du centre le plus recent a rendre ce
                        // chunk visible : utilisee comme point de depart du scan de
                        // surface (voir section 2), pour ne pas rater le terrain
                        // quand un joueur est tres au-dessus/en-dessous de GrokBot.
                        chunkScanY.set(key, center.y);
                        if (!chunkTerrainCache.has(key) && !chunkScanQueued.has(key) && !((chunkScanRetryAt.get(key) || 0) > Date.now())) {
                            chunkScanQueue.push(key);
                            chunkScanQueued.add(key);
                        }
                    }
                }
            }

            // Chunk redevenu visible (present ce tick, absent du tick precedent) :
            // deja en cache cote Node.js mais son contour/ses blocs viennent
            // d'etre recrees a neuf cote Lua -- on force son renvoi complet meme
            // s'il n'a pas ete rescanne (voir previousVisibleChunkKeys plus haut).
            for (const key of visibleChunkKeys) {
                if (!previousVisibleChunkKeys.has(key) && chunkTerrainCache.has(key)) {
                    pendingResyncChunkKeys.add(key);
                }
            }
            previousVisibleChunkKeys = visibleChunkKeys;

            // ---------------------------------------------------------
            // RENDU LOINTAIN 512x512 (LOD) : voir le bloc de constantes
            // FAR_RENDER_* en haut du fichier. Independant du scan detaille
            // ci-dessus (file, cache et budget par tick separes).
            // ---------------------------------------------------------
            if (FAR_RENDER_ENABLED) {
                farTick++;
                const nowMs = Date.now();
                const farVisible = new Set();
                let farQueueDirty = false;
                for (const center of scanCenters) {
                    for (let dx = -FAR_RENDER_RADIUS_CHUNKS; dx <= FAR_RENDER_RADIUS_CHUNKS; dx++) {
                        for (let dz = -FAR_RENDER_RADIUS_CHUNKS; dz <= FAR_RENDER_RADIUS_CHUNKS; dz++) {
                            const key = `${center.chunkX + dx}_${center.chunkZ + dz}`;
                            farVisible.add(key);
                            farScanY.set(key, center.y);
                            if (!farChunkCache.has(key) && !farScanQueued.has(key) && nowMs >= (farRetryAt.get(key) || 0)) {
                                farScanQueue.push(key);
                                farScanQueued.add(key);
                                farQueueDirty = true;
                            }
                        }
                    }
                }

                // Chunk nouvellement dans la zone lointaine mais deja en cache :
                // on le renvoie (le client Lua a pu le liberer en sortant de portee).
                for (const key of farVisible) {
                    if (!previousFarVisibleKeys.has(key) && farChunkCache.has(key)) {
                        pendingFarResyncKeys.add(key);
                    }
                }
                previousFarVisibleKeys = farVisible;

                if (farQueueDirty && farScanQueue.length > 1) {
                    farScanQueue.sort((a, b) =>
                        distanceSqToNearestCenter(a, scanCenters) - distanceSqToNearestCenter(b, scanCenters)
                    );
                }

                const farTouched = new Set();
                let farScans = 0;
                while (farScans < FAR_SCANS_PER_TICK && farScanQueue.length > 0) {
                    const key = farScanQueue.shift();
                    farScanQueued.delete(key);
                    if (!farVisible.has(key)) { farScanY.delete(key); continue; }
                    const [cxStr, czStr] = key.split('_');
                    const cx = parseInt(cxStr, 10);
                    const cz = parseInt(czStr, 10);
                    const refY = farScanY.has(key) ? farScanY.get(key) : pos.y;
                    let result = null;
                    try { result = scanChunkFar(bot, cx, cz, refY); } catch (e) { result = null; }
                    farScans++;
                    if (result === null) {
                        farRetryAt.set(key, nowMs + FAR_RETRY_MS); // non charge : on retente plus tard, sans bloquer la file
                        continue;
                    }
                    farRetryAt.delete(key);
                    farChunkCache.set(key, result);
                    if (!result.empty) farTouched.add(key);
                }

                // Memoire : evince d'abord ce qui n'est plus dans la zone lointaine.
                if (farChunkCache.size > MAX_CACHED_FAR_CHUNKS) {
                    for (const key of Array.from(farChunkCache.keys())) {
                        if (farChunkCache.size <= MAX_CACHED_FAR_CHUNKS) break;
                        if (!farVisible.has(key)) {
                            farChunkCache.delete(key);
                            farScanY.delete(key);
                            farDirtyUntil.delete(key);
                            pendingFarResyncKeys.delete(key);
                        }
                    }
                }
                if (farRetryAt.size > MAX_CACHED_FAR_CHUNKS) {
                    for (const key of Array.from(farRetryAt.keys())) {
                        if (!farVisible.has(key)) farRetryAt.delete(key);
                    }
                }

                // Selection des entrees a envoyer ce tick (les plus proches d'abord).
                for (const key of farTouched) farDirtyUntil.set(key, farTick + FAR_REDUNDANT_TICKS);
                const farCandidates = new Set();
                for (const [key, until] of farDirtyUntil) {
                    if (until < farTick) farDirtyUntil.delete(key);
                    else farCandidates.add(key);
                }
                for (const key of pendingFarResyncKeys) farCandidates.add(key);

                const farOrdered = Array.from(farCandidates).filter((key) => {
                    const entry = farChunkCache.get(key);
                    const ok = entry && !entry.empty && farVisible.has(key);
                    if (!ok) { pendingFarResyncKeys.delete(key); farDirtyUntil.delete(key); }
                    return ok;
                });
                if (farOrdered.length > 1) {
                    farOrdered.sort((a, b) =>
                        distanceSqToNearestCenter(a, scanCenters) - distanceSqToNearestCenter(b, scanCenters)
                    );
                }
                const farEntries = [];
                for (const key of farOrdered) {
                    if (farEntries.length < FAR_MAX_ENTRIES_PER_PAYLOAD) {
                        farEntries.push(farChunkCache.get(key));
                        pendingFarResyncKeys.delete(key);
                    } else {
                        pendingFarResyncKeys.add(key); // depassement : retente au tick suivant
                    }
                }
                farTerrainPayload = {
                    areaBlocks: FAR_RENDER_AREA_BLOCKS,
                    radiusChunks: FAR_RENDER_RADIUS_CHUNKS,
                    cachedChunks: farChunkCache.size,
                    chunks: farEntries
                };
            }

            // 2) Scanne un nombre limite de chunks en attente a chaque tick
            //    (chargement progressif) au lieu de scanner tout le rayon d'un
            //    coup, ce qui gelerait GrokBot le temps du scan.
            // Trie d'abord la file par distance au centre actif le plus proche :
            // chunkScanQueue est une simple FIFO remplie en ordre raster (etape 1
            // ci-dessus), donc sans ce tri le terrain se remplissait dans un ordre
            // arbitraire au lieu de partir du joueur/GrokBot vers l'exterieur.
            if (chunkScanQueue.length > 1) {
                chunkScanQueue.sort((a, b) =>
                    distanceSqToNearestCenter(a, scanCenters) - distanceSqToNearestCenter(b, scanCenters)
                );
            }
            // On retient aussi QUELS chunks viennent d'etre (re)scannes CE tick
            // (premiere fois, ou rescan suite a un vrai changement de bloc, voir
            // invalidateChunkAt) : c'est ce qui determine plus bas quels blocs
            // ont reellement besoin d'etre (re)envoyes a Roblox.
            let scansThisTick = 0;
            const chunksTouchedThisTick = new Set();
            while (scansThisTick < MAX_CHUNK_SCANS_PER_TICK && chunkScanQueue.length > 0) {
                const key = chunkScanQueue.shift();
                chunkScanQueued.delete(key);
                if (!visibleChunkKeys.has(key)) {
                    chunkScanY.delete(key); // plus visible par aucun centre : inutile de garder son altitude de reference
                    continue; // GrokBot (ou tous les joueurs) a bouge, ce chunk n'est plus visible
                }

                const [cxStr, czStr] = key.split('_');
                const cx = parseInt(cxStr, 10);
                const cz = parseInt(czStr, 10);
                const scanY = chunkScanY.has(key) ? chunkScanY.get(key) : pos.y;
                const scanned = scanChunkSurface(bot, cx, cz, scanY);
                if (scanned === null) {
                    // Chunk pas encore charge cote serveur MC : AVANT, un tableau vide etait mis en cache
                    // pour toujours -> trou permanent dans le terrain Roblox. On reessaie dans 1,5 s.
                    chunkScanRetryAt.set(key, Date.now() + CHUNK_SCAN_RETRY_MS);
                    continue;
                }
                chunkScanRetryAt.delete(key);
                chunkTerrainCache.set(key, scanned);
                chunksTouchedThisTick.add(key);
                scansThisTick++;
            }

            // 3) Evince les chunks en cache les plus eloignes si la limite memoire
            //    est depassee (GrokBot ou un joueur qui parcourt une grande distance
            //    ne doit pas faire grossir le cache indefiniment). La distance est
            //    calculee au centre le plus proche (GrokBot OU n'importe quel
            //    joueur), pas seulement a GrokBot, pour ne pas evincer par erreur
            //    des chunks encore utiles a un joueur eloigne du bot.
            if (chunkTerrainCache.size > MAX_CACHED_CHUNKS) {
                const distFromNearestCenter = (key) => {
                    const [cxStr, czStr] = key.split('_');
                    const kx = parseInt(cxStr, 10);
                    const kz = parseInt(czStr, 10);
                    let minDist = Infinity;
                    for (const center of scanCenters) {
                        const d = Math.abs(kx - center.chunkX) + Math.abs(kz - center.chunkZ);
                        if (d < minDist) minDist = d;
                    }
                    return minDist;
                };
                const overflowKeys = Array.from(chunkTerrainCache.keys())
                    .sort((a, b) => distFromNearestCenter(b) - distFromNearestCenter(a))
                    .slice(0, chunkTerrainCache.size - MAX_CACHED_CHUNKS);
                for (const key of overflowKeys) {
                    chunkTerrainCache.delete(key);
                    chunkScanY.delete(key);
                }
            }

            // 4) Construit les zones a partir du cache (rempli progressivement).
            //    Les chunks les plus proches d'UN centre (GrokBot ou un joueur)
            //    sont traites en premier pour le tableau plat "blocks", plafonne
            //    par securite (MAX_BLOCKS_PER_PAYLOAD) : le terrain proche est
            //    toujours prioritaire sur le terrain lointain si la limite est
            //    atteinte.
            const orderedKeys = Array.from(visibleChunkKeys).map((key) => {
                const [cxStr, czStr] = key.split('_');
                const kx = parseInt(cxStr, 10);
                const kz = parseInt(czStr, 10);
                let minDist = Infinity;
                for (const center of scanCenters) {
                    const d = Math.abs(kx - center.chunkX) + Math.abs(kz - center.chunkZ);
                    if (d < minDist) minDist = d;
                }
                return { key, chunkX: kx, chunkZ: kz, dist: minDist };
            });
            orderedKeys.sort((a, b) => a.dist - b.dist);

            for (const { key, chunkX: targetCX, chunkZ: targetCZ } of orderedKeys) {
                const chunkBlocks = chunkTerrainCache.get(key) || [];

                zonesList.push({
                    id: `chunk_${targetCX}_${targetCZ}`,
                    chunkX: targetCX,
                    chunkZ: targetCZ,
                    x: targetCX * CHUNK_SIZE,
                    y: pos.y,
                    z: targetCZ * CHUNK_SIZE,
                    size: CHUNK_SIZE,
                    // "loaded" reflete maintenant le vrai etat du scan progressif :
                    // false tant que ce chunk n'a pas encore ete scanne (il va
                    // apparaitre dans les prochains ticks).
                    loaded: chunkTerrainCache.has(key),
                    // Reste vrai UNIQUEMENT pour le chunk exact de GrokBot : le
                    // serveur reste la source de verite pour la couleur du contour
                    // cote Roblox (rose = chunk de GrokBot, jaune = tout le reste,
                    // y compris les chunks generes pour les joueurs).
                    isCurrentChunk: (targetCX === currentChunkX && targetCZ === currentChunkZ),
                    // Le detail des blocs n'est PAS duplique ici : cote Lua,
                    // updateChunksAndPlateau ne lit que x/z/chunkX/chunkZ/id/
                    // isCurrentChunk pour dessiner le contour. Le rendu des blocs
                    // eux-memes vient uniquement du tableau plat "blocks" plus bas
                    // (allVisibleBlocks), pour ne pas doubler la taille du JSON.
                    blockCount: chunkBlocks.length
                });
                generatedChunksCount++;

                // LAG RESOLU : avant, TOUS les chunks visibles (jusqu'a
                // MAX_BLOCKS_PER_PAYLOAD, soit jusqu'a 6000 blocs) etaient
                // reconstruits et renvoyes en ENTIER a CHAQUE tick (500ms),
                // meme quand rien n'avait change depuis le tick precedent --
                // ca gonflait le JSON envoye 2x/seconde ET forcait le script
                // Lua a reboucler sur des milliers de blocs deja connus a
                // chaque poll pour ne finalement rien en faire. On ne renvoie
                // desormais les blocs d'un chunk que s'il vient d'etre
                // (re)scanne CE tick (premiere fois, ou suite a un vrai
                // changement de bloc, voir chunksTouchedThisTick) OU s'il fait
                // partie d'un resync en attente apres un (re)demarrage du
                // script Lua (voir pendingResyncChunkKeys, "Roblox-ServerStart"
                // plus bas). Un chunk deja connu et inchange n'est donc plus
                // jamais retransmis.
                const needsResend = chunksTouchedThisTick.has(key) || pendingResyncChunkKeys.has(key);
                if (needsResend) {
                    if (allVisibleBlocks.length < MAX_BLOCKS_PER_PAYLOAD) {
                        // Filtre de securite : meme si une entree "bedrock" trainait
                        // deja dans le cache (ex: chunk scanne avant le fix de
                        // scanChunkSurface, cache pas encore reinvalide), elle n'est
                        // JAMAIS envoyee a Roblox. Garantit la suppression complete
                        // de la bedrock du rendu, quelle que soit son origine (scan
                        // frais deja filtre, vieux cache, ou futur code path qui
                        // oublierait le filtre).
                        const filteredBlocks = chunkBlocks.filter((b) => b.name !== 'bedrock');
                        allVisibleBlocks.push(...filteredBlocks);
                        pendingResyncChunkKeys.delete(key);
                    } else {
                        // FIX PERTE SILENCIEUSE : le plafond MAX_BLOCKS_PER_PAYLOAD
                        // est deja atteint ce tick. Avant, un chunk "needsResend"
                        // uniquement via chunksTouchedThisTick (flag valable UN
                        // SEUL tick) etait alors abandonne pour de bon : au tick
                        // suivant chunksTouchedThisTick est deja reinitialise et
                        // le chunk n'est plus repere comme "a renvoyer" nulle
                        // part, donc ses blocs ne remontent plus jamais a Roblox
                        // tant qu'aucun autre evenement ne le retouche. On le
                        // marque desormais dans pendingResyncChunkKeys pour qu'il
                        // soit retente au(x) prochain(s) tick(s), une fois de la
                        // place liberee dans le payload.
                        pendingResyncChunkKeys.add(key);
                    }
                }
            }
        }

        // VIE/FAIM + OBJET EN MAIN (cette revision) : chaque bot mineflayer
        // (bot ET les bots miroirs dans activeBots) connait sa propre
        // sante (bot.health, 0-20), sa faim (bot.food, 0-20) et l'objet
        // actuellement tenu en main (bot.heldItem, fourni nativement par
        // mineflayer -- null si la main est vide). On les ajoute directement
        // sur chaque entree de botsList (au lieu du seul grokView.health
        // d'avant, qui ne couvrait que GrokBot) pour que roblox_client.lua
        // puisse afficher une barre de vie/faim ET l'objet tenu au-dessus de
        // N'IMPORTE QUEL bot, pas seulement GrokBot.
        const botsList = [{
            name: bot.username,
            x: pos.x,
            y: pos.y,
            z: pos.z,
            yaw: bot.entity.yaw || 0,
            pitch: bot.entity.pitch || 0,
            isMain: true,
            health: (typeof bot.health === 'number') ? bot.health : 20,
            food: (typeof bot.food === 'number') ? bot.food : 20,
            heldItem: bot.heldItem ? (bot.heldItem.displayName || bot.heldItem.name) : null
        }];

        activeBots.forEach((bot, robloxUsername) => {
            if (bot && bot.entity) {
                botsList.push({
                    name: bot.username,
                    x: bot.entity.position.x,
                    y: bot.entity.position.y,
                    z: bot.entity.position.z,
                    yaw: bot.entity.yaw || 0,
                    pitch: bot.entity.pitch || 0,
                    isMain: false,
                    owner: robloxUsername,
                    health: (typeof bot.health === 'number') ? bot.health : 20,
                    food: (typeof bot.food === 'number') ? bot.food : 20,
                    heldItem: bot.heldItem ? (bot.heldItem.displayName || bot.heldItem.name) : null
                });
            }
        });

        for (const playerName in robloxPlayersState) {
            const pData = robloxPlayersState[playerName];
            if (!activeBots.has(playerName)) {
                // FIX DECALAGE Rbx_ : avant ce fix, un offset lateral fixe de 3
                // studs (sideOffsetDistance, dans la direction du regard) etait
                // ajoute a la position brute du joueur tant que son bot miroir
                // n'etait pas encore connecte (activeBots.has() false). Des que
                // le bot miroir finissait par se connecter, on passait a la
                // branche activeBots.forEach() plus haut, qui envoie
                // bot.entity.position SANS aucun offset -> le marqueur bleu
                // "sautait" brutalement de 3 studs sur le cote a cet instant
                // precis, cote Roblox (voir RBX_MARKER_VOFFSET_STUDS et le bloc
                // "elseif string.find(botInfo.name, "Rbx_")" dans
                // roblox_client.lua). On envoie desormais la position BRUTE,
                // identique a celle utilisee une fois le bot miroir actif :
                // plus aucune discontinuite visuelle a la connexion.
                botsList.push({
                    name: "Rbx_" + playerName,
                    x: pData.x,
                    y: pData.y,
                    z: pData.z,
                    yaw: pData.yaw || 0,
                    pitch: pData.pitch || 0,
                    isMain: false
                });
            }
        }

        const mcPlayersList = [];
        if (bot.players) {
            const now = Date.now();
            for (const playerName in bot.players) {
                const playerObj = bot.players[playerName];

                let isMirrorBot = false;
                for (const [, botInstance] of activeBots.entries()) {
                    if (botInstance && botInstance.username === playerName) {
                        isMirrorBot = true;
                        break;
                    }
                }

                if (playerName === bot.username || isMirrorBot) continue;

                if (playerObj && playerObj.entity) {
                    const currentPos = playerObj.entity.position;
                    const currentY = currentPos.y;
                    const prev = mcPlayerPrevPos.get(playerName);
                    const isJumping = prev ? (currentY > prev.y + 0.15 && currentY - prev.y < 1.2) : false;
                    // isFalling (chute) : meme principe qu'isJumping mais pour un
                    // deplacement vertical NEGATIF -- couvre aussi bien "vient de
                    // sauter et redescend" que "a marche hors d'une falaise sans
                    // sauter". Pas de plafond haut (contrairement a isJumping,
                    // limite a 1.2) : en chute libre prolongee, l'ecart vertical
                    // entre deux ticks peut depasser largement cette valeur, et on
                    // veut quand meme continuer a signaler isFalling=true tant que
                    // la chute continue.
                    const isFalling = prev ? (currentY < prev.y - 0.15) : false;

                    // Deplacement horizontal (X/Z) depuis le dernier tick, utilise
                    // cote Roblox pour declencher l'anim de marche et regler sa
                    // cadence (voir mcPlayerInfo.isMoving / mcPlayerInfo.speed).
                    let horizontalSpeed = 0;
                    let isMovingHorizontally = false;
                    if (prev && prev.time) {
                        const dt = (now - prev.time) / 1000;
                        if (dt > 0) {
                            const dx = currentPos.x - prev.x;
                            const dz = currentPos.z - prev.z;
                            const horizontalDist = Math.sqrt(dx * dx + dz * dz);
                            horizontalSpeed = horizontalDist / dt;
                            isMovingHorizontally = horizontalDist > 0.02;
                        }
                    }

                    mcPlayerPrevPos.set(playerName, { x: currentPos.x, y: currentY, z: currentPos.z, time: now });

                    mcPlayersList.push({
                        name: playerName,
                        x: currentPos.x,
                        y: currentY,
                        z: currentPos.z,
                        yaw: playerObj.entity.yaw || 0,
                        pitch: playerObj.entity.pitch || 0,
                        isJumping,
                        isFalling,
                        isMoving: isMovingHorizontally,
                        speed: horizontalSpeed,
                        isAttacking: mcPlayerAttackingState.get(playerName) || false,
                        isDigging: mcPlayerDiggingState.get(playerName) || false,
                        isDead: mcPlayerDeadState.get(playerName) || false,
                        skin: getSkinForMcPlayer(playerName)
                    });
                } else {
                    // playerObj existe (present dans la tab-list) mais son .entity
                    // n'est pas (encore, ou plus) trackee par mineflayer : au lieu
                    // de le faire disparaitre instantanement cote Roblox, on le
                    // maintient a sa derniere position connue pendant ENTITY_GRACE_MS.
                    const prev = mcPlayerPrevPos.get(playerName);
                    if (prev && (now - prev.time) < ENTITY_GRACE_MS) {
                        mcPlayersList.push({
                            name: playerName,
                            x: prev.x,
                            y: prev.y,
                            z: prev.z,
                            yaw: 0,
                            pitch: 0,
                            isJumping: false,
                            isFalling: false,
                            isMoving: false,
                            speed: 0,
                            isAttacking: false,
                            isDigging: false,
                            isDead: mcPlayerDeadState.get(playerName) || false,
                            skin: getSkinForMcPlayer(playerName)
                        });
                    }
                }
            }

            // Diagnostic : n'affiche dans la console que si l'etat change, pour
            // pouvoir verifier facilement si le probleme vient d'ici (le joueur
            // n'apparait meme pas dans la tab-list -> probleme de connexion MC)
            // ou de la trackee d'entite (le joueur est dans "raw" mais pas dans
            // "tracked" -> augmenter viewDistance ou se rapprocher de GrokBot).
            const rawNames = Object.keys(bot.players).filter(n => n !== bot.username);
            const trackedNames = mcPlayersList.map(p => p.name);
            const debugState = rawNames.join(',') + '|' + trackedNames.join(',');
            if (debugState !== lastMcPlayerDebugState) {
                lastMcPlayerDebugState = debugState;
                console.log(`[GrokBot] Tab-list MC: [${rawNames.join(', ') || '-'}] | Envoyes a Roblox comme MCPlayer: [${trackedNames.join(', ') || '-'}]`);
            }
        }

        // MÉTÉO & BIOME : calculés une fois par tick (comme le reste de ce
        // bloc), pas à chaque poll Lua (0.3s) -- lu depuis bot.blockAt à
        // la position actuelle de GrokBot, donc "le biome où est GrokBot",
        // pas forcément celui de chaque joueur Roblox individuellement.
        const currentBiomeName = getBiomeNameAt(bot, new Vec3(Math.floor(pos.x), Math.floor(pos.y), Math.floor(pos.z)));
        const currentIsSnowyBiome = isSnowyBiomeName(currentBiomeName);

        state.worldSyncTick++;
        const mobsList = buildMobsList(bot, pos); // mobs Minecraft proches (ajout)

        const syncData = {
            command: 'sync_mineflayer_world',
            syncTick: state.worldSyncTick,
            serverId: srv.id,        // le client Lua detecte le changement de serveur grace a ce champ
            serverName: srv.name,
            botName: bot.username,
            x: pos.x,
            y: pos.y,
            z: pos.z,
            yaw: bot.entity.yaw || 0,
            pitch: bot.entity.pitch || 0,
            blockSize: globalBlockSize,
            blocks: allVisibleBlocks,
            farTerrain: farTerrainPayload, // RENDU LOINTAIN 512x512 (null si desactive)
            plateauEnabled,
            plateauSize,
            zones: zonesList,
            bots: botsList,
            minecraftPlayers: mcPlayersList,
            mobs: mobsList,
            chats: chatMessages,
            // Etat jour/nuit du monde Minecraft REEL (fourni par mineflayer via
            // bot.time), transmis a Roblox pour que son ciel (Lighting.ClockTime,
            // voir renderMineflayerWorld cote roblox_client.lua) reproduise
            // exactement le meme cycle jour/nuit que Minecraft, au lieu de suivre
            // le sien propre. timeOfDay va de 0 (lever du jour, 6h) a 24000
            // (lever du jour suivant), voir mineflayer/minecraft-protocol.
            time: {
                timeOfDay: (bot.time && typeof bot.time.timeOfDay === 'number') ? bot.time.timeOfDay : 0,
                isDay: bot.time ? bot.time.isDay !== false : true
            },
            // MÉTÉO REELLE du monde Minecraft (nuage/pluie/orage/neige), transmise
            // à Roblox pour que son ciel (nuages Lighting.Clouds, particules
            // pluie/neige, éclairs) reproduise exactement la météo Minecraft, au
            // lieu de rester figé -- même principe que "time" juste au-dessus.
            // isSnowyBiome distingue "il pleut" (vraie pluie) de "il neige"
            // (même pluie MC, mais dans un biome froid -> neige au lieu de
            // pluie, voir SNOWY_BIOME_NAMES / isSnowyBiomeName).
            weather: {
                isRaining: bot.isRaining === true,
                rainLevel: (typeof bot.rainState === 'number') ? bot.rainState : (bot.isRaining ? 1 : 0),
                thunderLevel: (typeof bot.thunderState === 'number') ? bot.thunderState : 0,
                isThundering: (typeof bot.thunderState === 'number') ? bot.thunderState > 0.1 : false,
                biome: currentBiomeName,
                isSnowyBiome: currentIsSnowyBiome
            },
            grokView: {
                activeChunkX: currentChunkX,
                activeChunkZ: currentChunkZ,
                totalActiveChunks: generatedChunksCount,
                renderRadius: chunkRenderDistance,
                isWandering: false,
                dimension: "overworld",
                health: bot.health || 20,
                food: bot.food || 20,
                linkedRobloxPlayers: Array.from(gameState.activePlayers)
            }
        };

        state.worldData = syncData;
        if (serverId === activeServerId) worldData = syncData;
        queueCommand(syncData, serverId);
    }, 300); // FLUIDITÉ (ce patch) : abaissé de 500ms à 300ms. Les positions de GrokBot,
    // des MCPlayer et des bots miroirs Rbx_ sont lues en direct sur leurs entités
    // mineflayer à CHAQUE tick (voir botsList/mcPlayersList plus haut, pas de cache
    // périmé) : les envoyer plus souvent donne à roblox_client.lua des points
    // d'interpolation plus rapprochés, donc un mouvement visuellement plus fluide
    // et moins "par à-coups" entre deux mises à jour. Si le serveur commence à
    // saturer (scan de chunks trop lourd à ce rythme), remonte progressivement
    // (400, puis 500) plutôt que de redescendre encore sous 300.
}

// Alias legacy : startLiveSync() relance le serveur actif.
function startLiveSync() {
    startLiveSyncForServer(activeServerId);
}


// ---------------------------------------------------------
// 7. ENDPOINTS API EXPRESS (CORS & ROUTES)
// ---------------------------------------------------------
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// PURGE ANTI-DECALAGE (affichage du monde) : avant ce fix, /api/poll ne
// renvoyait qu'UNE SEULE commande par requete (~0.3s de rythme cote Lua).
// sync_mineflayer_world etait deja servi en priorite (voir raison ci-dessous),
// mais les commandes individuelles spawn_block/break_block (declenchees par
// CHAQUE bloc casse/pose detecte par mainBot.on('blockUpdate'), voir plus
// haut -- frequent des qu'un joueur MC mine/construit vite, ou que plusieurs
// joueurs sont actifs) continuaient elles a n'etre servies qu'UNE A LA FOIS,
// donc une rafale de N blocs changes cote Minecraft mettait jusqu'a N*0.3s a
// arriver en entier cote Roblox : le monde affiche "rattrapait" son retard
// bloc par bloc au lieu de refleter les changements immediatement. Fix : on
// renvoie desormais TOUTES les commandes en attente d'un coup (plafonnees a
// MAX_COMMANDS_PER_POLL par reponse pour ne pas gonfler demesurement un seul
// payload JSON si la file etait tres remplie), sous forme d'un tableau
// { commands: [...] } ; roblox_client.lua les traite alors toutes dans la
// MEME frame de poll (voir la boucle "for _, cmd in ipairs(data.commands)").
const MAX_COMMANDS_PER_POLL = 40;

app.get('/api/poll', (req, res) => {
    // Agrege les files de tous les serveurs (serveur actif en tete)
    const aggregated = getAggregatedPendingCommands();

    if (aggregated.length === 0) {
        return res.json({ commands: [] });
    }

    const commands = aggregated.slice(0, MAX_COMMANDS_PER_POLL);

    let shouldSaveStatus = false;
    for (const cmd of commands) {
        if (cmd.command === 'spawn_block' || cmd.command === 'sync_mineflayer_world') {
            gameState.totalBlocksSpawned++;
            shouldSaveStatus = true;
        }
    }
    if (shouldSaveStatus) saveGameStatus('Online');

    res.json({ commands });
});

// Nouveau : statut de TOUS les serveurs Minecraft configures.
// Le client Lua le polle toutes les 3s pour afficher le panneau serveurs.
// --- Anti-kick : statut et interrupteur a chaud ---
app.get('/api/anti-kick', (req, res) => {
    res.json({ enabled: antiKickEnabled, walk: ANTI_AFK_WALK_ENABLED && antiKickEnabled, bots: Array.from(antiKickActiveBots) });
});
app.post('/api/anti-kick', requireObjectsKey, (req, res) => {
    const want = req.body && req.body.enabled;
    if (typeof want !== 'boolean') return res.status(400).json({ error: 'Champ "enabled" (true/false) requis.' });
    antiKickEnabled = want;
    console.log('[AntiKick] ' + (want ? 'ACTIVE' : 'DESACTIVE') + ' via l\'API.');
    res.json({ enabled: antiKickEnabled, bots: Array.from(antiKickActiveBots) });
});

app.get('/api/servers', (req, res) => {
    const list = SERVERS.filter(s => s.enabled).map(srv => {
        const state = serverStates.get(srv.id);
        const bot = state && state.bot;
        const online = !!(bot && bot.entity);
        const cap = state ? getServerCapacity(state) : null;
        return {
            id: srv.id,
            name: srv.name,
            online: online,
            isActive: srv.id === activeServerId,
            full: !!(state && state.full),
            forcedOffline: !!(state && state.forcedOffline),
            maxPlayers: cap ? cap.max : null,
            freeSlots: cap ? cap.free : null,
            players: online && bot.players
                ? Object.keys(bot.players).filter(u => u !== bot.username).length
                : 0,
        };
    });
    res.json({ servers: list, activeServerId: activeServerId });
});

// Ajoute / retire un serveur a chaud (cle x-api-key requise ; sauvegarde dans servers.json).
//   POST   /api/servers      { "name":"Serveur 3", "host":"x.aternos.me", "port":12345, "version":"1.20.4", "botName":"GrokBot3" }
//   DELETE /api/servers/:id
app.post('/api/servers', requireObjectsKey, (req, res) => {
    const r = addServerRuntime(req.body || {});
    if (r.error) return res.status(400).json({ error: r.error });
    res.status(201).json({ status: 'success', server: r.server });
});
app.delete('/api/servers/:id', requireObjectsKey, (req, res) => {
    const r = removeServerRuntime(req.params.id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ status: 'success', removed: r.removed });
});

// Met un serveur Minecraft hors ligne / en ligne a la main (cle x-api-key requise).
//   POST /api/servers/serveur_1/offline  -> serveur_1 deconnecte, serveur_2 affiche son monde
//   POST /api/servers/serveur_1/online   -> serveur_1 se reconnecte (retour auto selon OVERFLOW_*)
app.post('/api/servers/:id/:state', requireObjectsKey, (req, res) => {
    if (req.params.state !== 'offline' && req.params.state !== 'online') {
        return res.status(404).json({ error: 'Etat invalide (offline ou online)' });
    }
    const ok = setServerForcedOffline(req.params.id, req.params.state === 'offline');
    if (!ok) return res.status(404).json({ error: 'Serveur inconnu ou desactive (enabled: false)' });
    res.json({ status: 'success', id: req.params.id, forcedOffline: req.params.state === 'offline' });
});

app.post('/api/endpoint', (req, res) => {
    const payload = req.body || {};
    const { source, player, gameName, x, y, z, yaw, pitch, isMoving, speed, sentAt, action, tool, blockName, message, admin, command, chunkX, chunkZ, radius, targetPlayer, objectId, objectName, rotY, scale } = payload;

    if (!source) {
        return res.status(400).json({ error: "Payload invalide" });
    }

    gameState.lastHeartbeat = Date.now();

    switch (source) {
        case "Roblox-ServerStart":
            if (gameName) gameState.gameName = gameName;
            saveGameStatus("Online");
            // Le script Lua vient de (re)demarrer : son cache de blocs cote
            // client est vide, mais chunkTerrainCache (Node.js) peut deja
            // contenir des chunks scannes AVANT ce (re)demarrage. Sans ca,
            // la logique "delta" de startLiveSync() (qui ne renvoie que les
            // chunks fraichement scannes) ne les renverrait alors jamais a ce
            // nouveau client. On force donc leur renvoi complet, etale sur
            // autant de ticks que necessaire si MAX_BLOCKS_PER_PAYLOAD est
            // depasse (voir pendingResyncChunkKeys plus haut).
            for (const key of chunkTerrainCache.keys()) {
                pendingResyncChunkKeys.add(key);
            }
            // RENDU LOINTAIN : le client Lua redemarre sans aucune dalle lointaine.
            for (const key of farChunkCache.keys()) {
                pendingFarResyncKeys.add(key);
            }
            // Renvoie aussi les objets Studio memorises (le client Lua redemarre
            // sans aucun objet persistant).
            queueObjectsSync();
            console.log(`[Bridge] Jeu Roblox connecté : ${gameState.gameName}`);
            break;

        case "Roblox-Device":
            handleRobloxDevice(payload);
            break;

        case "Roblox-Heartbeat":
            saveGameStatus("Online");
            break;

        case "Roblox-Join":
            if (player) {
                recentlyLeftPlayers.delete(player);
                savePlayer(player);
                gameState.activePlayers.add(player);
                saveGameStatus("Online");
                setTimeout(() => spawnPlayerBot(player), 1000);
                console.log(`[Bridge] Joueur Roblox entré : ${player}`);
            }
            break;

        case "Roblox-Leave":
            if (player) {
                gameState.activePlayers.delete(player);
                recentlyLeftPlayers.set(player, Date.now());
                delete robloxPlayersState[player];
                playerChunkRequests.delete(player);
                playerLastMoveSentAt.delete(player);
                handleRobloxLeave({ player });
                saveGameStatus("Online");
                removePlayerBot(player);
                playerChatLastAt.delete(player);
                console.log(`[Bridge] Joueur Roblox parti : ${player}`);
            }
            break;

        case "Roblox-Move":
            if (player) {
                const leftAt = recentlyLeftPlayers.get(player);
                if (leftAt) {
                    if (Date.now() - leftAt < LEFT_PLAYER_IGNORE_MS) break; // paquet tardif d'un joueur parti
                    recentlyLeftPlayers.delete(player);
                }
                // Paquet perime arrive en retard (voir playerLastMoveSentAt plus
                // haut) : on l'ignore completement, sans toucher a
                // robloxPlayersState/playerLastRawPos/au but du bot miroir, pour
                // ne pas faire regresser la position affichee/visee avec une
                // donnee plus ancienne qu'un paquet deja traite.
                if (typeof sentAt === 'number') {
                    const lastSentAt = playerLastMoveSentAt.get(player) || 0;
                    if (sentAt <= lastSentAt) {
                        break;
                    }
                    playerLastMoveSentAt.set(player, sentAt);
                }

                robloxPlayersState[player] = {
                    name: `Rbx_${player}`,
                    x, y, z, yaw, pitch, isMoving, speed,
                    lastUpdate: Date.now()
                };

                const playerBot = activeBots.get(player);
                if (playerBot && playerBot.entity && playerBot.pathfinder
                    && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {

                    const now = Date.now();

                    // Vitesse instantanee estimee entre cette position brute et la
                    // precedente (toutes deux non throttlees) : c'est CE calcul, et
                    // non le rythme de recalcul du but ci-dessous, qui doit refleter
                    // le mouvement reel du joueur.
                    const prevRawPos = playerLastRawPos.get(player);
                    let leadX = x, leadY = y, leadZ = z;
                    if (prevRawPos) {
                        const dt = (now - prevRawPos.time) / 1000;
                        if (dt > 0.01 && dt < 2) {
                            let vx = (x - prevRawPos.x) / dt;
                            let vy = (y - prevRawPos.y) / dt;
                            let vz = (z - prevRawPos.z) / dt;
                            const speedBlocksPerSec = Math.hypot(vx, vy, vz);
                            if (speedBlocksPerSec > MAX_LEAD_SPEED_BLOCKS_PER_SEC) {
                                const scale = MAX_LEAD_SPEED_BLOCKS_PER_SEC / speedBlocksPerSec;
                                vx *= scale; vy *= scale; vz *= scale;
                            }
                            leadX = x + vx * GOAL_LEAD_TIME_SEC;
                            leadY = y + vy * GOAL_LEAD_TIME_SEC;
                            leadZ = z + vz * GOAL_LEAD_TIME_SEC;
                        }
                    }
                    playerLastRawPos.set(player, { x, y, z, time: now });

                    // Throttle temps + distance (voir constantes plus haut), base sur
                    // la position REELLE (x,y,z) et non la cible avec avance : sans
                    // ca, setGoal() relancait un A* complet a CHAQUE paquet
                    // Roblox-Move (plusieurs fois/seconde), au point de saturer
                    // l'event loop et de faire "louper" le keep-alive Minecraft
                    // d'un autre bot -> "client timed out after 60000 milliseconds".
                    const lastGoalTime = playerBotLastGoalTime.get(player) || 0;
                    const lastGoalPos = playerBotLastGoalPos.get(player);
                    const movedEnough = !lastGoalPos
                        || Math.hypot(x - lastGoalPos.x, y - lastGoalPos.y, z - lastGoalPos.z) >= GOAL_RECALC_MIN_DISTANCE;

                    if (movedEnough && (now - lastGoalTime) >= PLAYER_BOT_GOAL_MIN_INTERVAL_MS
                        && Number.isFinite(leadX) && Number.isFinite(leadY) && Number.isFinite(leadZ)) {
                        try {
                            const targetGoal = new goals.GoalNear(leadX, leadY, leadZ, 1);
                            playerBot.pathfinder.setGoal(targetGoal, false);
                            playerBotLastGoalTime.set(player, now);
                            playerBotLastGoalPos.set(player, { x, y, z });
                        } catch (err) {
                            console.error(`[Bridge] Erreur setGoal pour ${player} :`, err.message);
                        }
                    }
                }

                if (playerBot && playerBot.entity && yaw !== undefined && pitch !== undefined) {
                    playerBot.look(yaw, pitch, true).catch(() => {});
                }
            }
            break;

        // Envoye par le script Lua des qu'un joueur Roblox franchit la frontiere
        // d'un nouveau chunk (throttle cote client, pas a chaque frame). On
        // memorise juste le dernier centre demande ; c'est startLiveSync() qui
        // s'en sert pour scanner/generer le vrai terrain Minecraft autour de ce
        // joueur, en plus de la zone autour de GrokBot.
        //
        // BUG CORRIGE (terrain vide autour du joueur Roblox) : un chunk deja
        // present dans chunkTerrainCache (ex: scanne plus tot autour d'un
        // MCPlayer, ou autour de GrokBot, ou d'un autre joueur) n'etait JAMAIS
        // renvoye quand ce joueur Roblox s'en approchait, car previousVisible
        // le considerait deja "visible" cote serveur. Or le client Lua filtre
        // strictement par ses propres centres (GrokBot + joueurs Roblox) et
        // detruit les blocs hors-rayon : il n'avait donc jamais cree ces blocs,
        // et sans renvoi forcé il restait sur du vide. Fix : a chaque nouvelle
        // demande de chunks d'un joueur Roblox, on force le resync de TOUS les
        // chunks deja en cache dans son rayon (meme mecanisme que
        // Roblox-ServerStart / previousVisibleChunkKeys).
        case "Roblox-RequestChunks":
            if (player && typeof chunkX === 'number' && typeof chunkZ === 'number') {
                let reqRadius = (typeof radius === 'number' && radius > 0) ? radius : chunkRenderDistance;
                if (DEVICE_RADIUS_LIMIT_ENABLED) reqRadius = Math.min(reqRadius, getSettings(player).chunkRadius);
                playerChunkRequests.set(player, {
                    chunkX,
                    chunkZ,
                    radius: reqRadius,
                    x, y, z,
                    lastUpdate: Date.now()
                });

                // Force le renvoi des chunks deja connus dans le rayon demande.
                for (let dx = -reqRadius; dx <= reqRadius; dx++) {
                    for (let dz = -reqRadius; dz <= reqRadius; dz++) {
                        const key = `${chunkX + dx}_${chunkZ + dz}`;
                        if (chunkTerrainCache.has(key)) {
                            pendingResyncChunkKeys.add(key);
                        } else if (!chunkScanQueued.has(key)) {
                            // Pas encore en cache : s'assurer qu'il est en file
                            // de scan (startLiveSync le mettra aussi, mais on
                            // gagne un tick en l'ajoutant ici tout de suite).
                            chunkScanQueue.push(key);
                            chunkScanQueued.add(key);
                            if (typeof y === 'number') {
                                chunkScanY.set(key, y);
                            }
                        }
                    }
                }
            }
            break;

        case "Roblox-Action":
            console.log(`[Bridge Action] Joueur ${player} a effectué l'action : ${action}`);
            if (player) {
                const playerBot = activeBots.get(player) || mainBot;
                if (playerBot && playerBot.entity) {
                    if (action === "jump") {
                        playerBot.setControlState('jump', true);
                        setTimeout(() => playerBot.setControlState('jump', false), 350);
                    } else if (action === "attack") {
                        equipToolThenAttack(playerBot, tool, player, targetPlayer);
                    } else if (action === "break") {
                        // Casse REELLE d'un bloc du monde Minecraft, demandee par un
                        // joueur Roblox qui a clique dessus (voir attachBreakHandler
                        // cote roblox_client.lua). x/y/z sont les coordonnees
                        // Minecraft du bloc (pas des studs Roblox).
                        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
                            if (!isWithinAllowedBuildZone(x, y, z)) {
                                console.log(`[Bridge] ${player} a tente de casser hors de la zone autorisee (${x},${y},${z}) : refuse.`);
                                break;
                            }
                            try {
                                const targetBlock = playerBot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
                                if (!targetBlock || targetBlock.name === 'air') {
                                    // Rien a casser ici (deja casse entre-temps, ou desync) : on ignore.
                                } else if (targetBlock.name === 'bedrock') {
                                    // SECURITE COTE SERVEUR : la bedrock ne doit jamais pouvoir
                                    // etre cassee, meme si un client trafique/bypasse la
                                    // verification cote Roblox (qui n'attache normalement
                                    // aucun ClickDetector dessus).
                                    console.log(`[Bridge] ${player} a tente de casser de la bedrock (${x},${y},${z}) : refuse.`);
                                } else {
                                    playerBot.dig(targetBlock).catch(err => {
                                        console.error(`[Bridge] Echec break_block pour ${player} a ${x},${y},${z} :`, err.message);
                                    });
                                }
                            } catch (err) {
                                console.error(`[Bridge] Erreur traitement break_block pour ${player} :`, err.message);
                            }
                        }
                    } else if (action === "place") {
                        // Pose REELLE d'un bloc dans le monde Minecraft, demandee par un
                        // joueur Roblox qui a clique-droit sur la face d'un bloc existant
                        // (voir attachBlockHandlers cote roblox_client.lua). x/y/z sont les
                        // coordonnees Minecraft de la case VIDE ou poser (deja calculees
                        // cote client a partir du bloc clique + de la normale de la face).
                        if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') {
                            if (!isWithinAllowedBuildZone(x, y, z)) {
                                console.log(`[Bridge] ${player} a tente de poser hors de la zone autorisee (${x},${y},${z}) : refuse.`);
                                break;
                            }
                            try {
                                // Pose deleguee a placeBlockForPlayer (voir plus haut) : verifie la
                                // case cible (air OU plante/eau remplacable), choisit un bloc d'appui
                                // SOLIDE, attend que le bot soit a portee, puis pose. Chaque echec
                                // est loggue avec sa raison et declenche un rescan du chunk pour
                                // effacer le bloc "fantome" affiche en avance cote Roblox.
                                placeBlockForPlayer(playerBot, player, x, y, z, blockName || 'dirt', { remote: payload.remote === true }).catch(err => {
                                    console.error(`[Pose] Erreur inattendue pour ${player} a ${x},${y},${z} :`, err.message);
                                });
                            } catch (err) {
                                console.error(`[Bridge] Erreur traitement place_block pour ${player} :`, err.message);
                            }
                        }
                    }
                }
            }
            break;

        case "Roblox-Chat":
            if (player && message) {
                // Le message est dit par le bot miroir du joueur (Rbx_Nom) : c'est "lui" qui parle dans
                // Minecraft. Sans bot miroir actif : repli sur le bot principal avec le prefixe [Roblox].
                // SECURITE : un message commencant par "/" est ignore (sinon un joueur Roblox ferait executer
                // des commandes par un bot qui peut etre OP) ; caracteres de controle et "§" retires.
                const safeMessage = String(message).replace(/[\u0000-\u001f\u007f\u00a7]/g, '').trim().slice(0, PLAYER_CHAT_MAX_LENGTH);
                const nowChat = Date.now();
                if (!safeMessage) {
                    // rien a envoyer
                } else if (safeMessage.startsWith('/')) {
                    console.log(`[Roblox Chat] ${player} : commande "/" ignoree.`);
                } else if (nowChat - (playerChatLastAt.get(player) || 0) < PLAYER_CHAT_MIN_INTERVAL_MS) {
                    // anti-spam : trop rapide, on n'envoie pas a Minecraft (reste visible dans le chat du bridge)
                } else {
                    playerChatLastAt.set(player, nowChat);
                    const ownBot = activeBots.get(player);
                    if (ownBot && ownBot.entity) {
                        ownBot.chat(safeMessage);
                    } else if (mainBot && mainBot.entity) {
                        mainBot.chat(`[Roblox] ${player}: ${safeMessage}`);
                    }
                }
                chatMessages.push({
                    time: Date.now(),
                    sender: `Rbx_${player}`,
                    message
                });
                if (chatMessages.length > 20) chatMessages.shift();
                console.log(`[Roblox Chat] <${player}> ${message}`);
            }
            break;

        // Objets Studio poses/retires depuis le panel "Objets" du script Lua :
        // on se contente de les memoriser (Roblox les a deja affiches, on ne
        // renvoie donc AUCUNE commande pour eviter un double affichage).
        case "Roblox-ObjectPlace": {
            const result = addPlacedObject({ id: objectId, name: objectName, x, y, z, rotY, scale });
            if (result.error) console.log(`[Objets] Pose de ${player || '?'} non memorisee : ${result.error}`);
            else console.log(`[Objets] ${player || '?'} a pose "${result.obj.name}" en (${result.obj.x}, ${result.obj.y}, ${result.obj.z})`);
            break;
        }

        case "Roblox-ObjectRemove":
            if (typeof objectId === 'string') removePlacedObject(objectId);
            break;

        case "Roblox-ObjectClear":
            clearPlacedObjects();
            console.log(`[Objets] Tous les objets supprimes par ${player || '?'}`);
            break;

        // INVENTAIRE CONNECTE (ajout) : le joueur clique un slot de la hotbar
        // dans le panneau Roblox -> le bot miroir change reellement de slot.
        case "Roblox-InventorySelect": {
            const invBot = player ? activeBots.get(player) : null;
            const slotNum = Math.floor(Number(payload.slot));
            if (invBot && invBot.entity && slotNum >= 1 && slotNum <= 9) {
                try { invBot.setQuickBarSlot(slotNum - 1); }
                catch (err) { console.error(`[Inventaire] Selection slot ${slotNum} impossible pour ${player} :`, err.message); }
                scheduleInventorySync(player, invBot);
            }
            break;
        }

        // Le panneau vient d'etre ouvert : on renvoie un snapshot a jour.
        case "Roblox-InventoryRequest": {
            const invBot = player ? activeBots.get(player) : null;
            if (invBot && invBot.entity) scheduleInventorySync(player, invBot);
            break;
        }

        case "Roblox-AdminCommand":
            console.log(`[Admin] Commande reçue de ${admin || player} : ${command}`);
            queueCommand({
                command: "admin_action",
                admin: admin || player || "Inconnu",
                action: command
            });
            break;
    }

    res.json({ status: 'success', received: true });
});

// ---------------------------------------------------------
// API REST OBJETS (voir section 2.1). Protegee par OBJECTS_API_KEY si definie.
// ---------------------------------------------------------
const objectsAuthFails = new Map(); // ip -> { count, resetAt }
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of objectsAuthFails) {
        if (rec.resetAt <= now) objectsAuthFails.delete(ip);
    }
}, OBJECTS_AUTH_WINDOW_MS).unref();

function requireObjectsKey(req, res, next) {
    const provided = Buffer.from(String(req.get('x-api-key') || ''));
    const expected = Buffer.from(OBJECTS_API_KEY);
    if (provided.length === expected.length && require('crypto').timingSafeEqual(provided, expected)) {
        return next(); // une bonne cle n'est jamais bloquee
    }
    const ip = req.ip || 'unknown';
    const now = Date.now();
    let rec = objectsAuthFails.get(ip);
    if (rec && rec.resetAt > now && rec.count >= OBJECTS_AUTH_MAX_FAILS) {
        res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
        return res.status(429).json({ error: 'Trop de tentatives, reessaie plus tard' });
    }
    if (!rec || rec.resetAt <= now) {
        if (objectsAuthFails.size >= 10000) objectsAuthFails.clear();
        rec = { count: 0, resetAt: now + OBJECTS_AUTH_WINDOW_MS };
        objectsAuthFails.set(ip, rec);
    }
    rec.count++;
    return res.status(401).json({ error: 'Cle API invalide' });
}

// Liste des objets memorises.
// Parametre optionnel ?since=<version> : si rien n'a change, repond seulement
// { version, unchanged: true }.
app.get('/api/objects', requireObjectsKey, (req, res) => {
    const since = parseInt(req.query.since, 10);
    if (Number.isInteger(since) && since === objectsVersion) {
        return res.json({ version: objectsVersion, unchanged: true });
    }
    res.json({ version: objectsVersion, count: placedObjects.size, objects: Array.from(placedObjects.values()) });
});

// Un objet par id.
app.get('/api/objects/:id', requireObjectsKey, (req, res) => {
    const obj = placedObjects.get(req.params.id);
    if (!obj) return res.status(404).json({ error: 'Objet inconnu' });
    res.json({ object: obj });
});

// Pose un objet { name, x, y, z, rotY?, scale?, anchored? } ou plusieurs
// { objects: [...] }. Roblox le recoit au prochain poll (commande spawn_object).
// INVENTAIRE CONNECTE (ajout) : lecture de l'inventaire reel du bot miroir d'un joueur.
app.get('/api/inventory/:player', requireObjectsKey, (req, res) => {
    const invBot = activeBots.get(req.params.player);
    if (!invBot || !invBot.inventory) return res.status(404).json({ error: 'Bot introuvable pour ce joueur' });
    res.json({ player: req.params.player, ...buildInventorySnapshot(invBot) });
});

app.post('/api/objects', requireObjectsKey, (req, res) => {
    const body = req.body || {};
    const items = Array.isArray(body.objects) ? body.objects : [body];
    if (items.length > MAX_OBJECTS_PER_REQUEST) {
        return res.status(400).json({ error: `Maximum ${MAX_OBJECTS_PER_REQUEST} objets par requete` });
    }
    const added = [];
    const errors = [];
    items.forEach((raw, index) => {
        const result = addPlacedObject(raw);
        if (result.error) {
            errors.push({ index, error: result.error });
        } else {
            added.push(result.obj);
            queueCommand(Object.assign({ command: 'spawn_object' }, result.obj));
        }
    });
    res.status(added.length > 0 ? 201 : 400).json({ added, errors, version: objectsVersion });
});

// Force un renvoi complet de la liste vers Roblox.
app.post('/api/objects/sync', requireObjectsKey, (req, res) => {
    queueObjectsSync();
    res.json({ status: 'success', count: placedObjects.size });
});

// Retire un objet par id.
app.delete('/api/objects/:id', requireObjectsKey, (req, res) => {
    const id = req.params.id;
    if (!removePlacedObject(id)) return res.status(404).json({ error: 'Objet inconnu' });
    queueCommand({ command: 'remove_object', id });
    res.json({ status: 'success', removed: id });
});

// Retire tous les objets memorises.
app.delete('/api/objects', requireObjectsKey, (req, res) => {
    const count = placedObjects.size;
    clearPlacedObjects();
    queueCommand({ command: 'clear_objects' });
    res.json({ status: 'success', removed: count });
});

// ---------------------------------------------------------
// CARTE 3D DU MONDE (page web, three.js)
//   http://localhost:PORT/map          -> la carte (tourner, zoomer, suivre un joueur)
//   GET /api/map                       -> blocs du terrain en cache (palette + tableaux compacts)
//   GET /api/map/players               -> joueurs/bot + appareil + signature de changement (leger)
// Acces : uniquement depuis cette machine (localhost), ou avec ?key=OBJECTS_API_KEY.
// ---------------------------------------------------------
function mapAccess(req, res, next) {
    const ip = req.socket.remoteAddress || '';
    const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    const proxied = !!(req.headers['x-forwarded-for'] || req.headers['x-real-ip']); // tunnel (ngrok...) => ne pas faire confiance a "localhost"
    if (isLoopback && !proxied) return next();
    const provided = Buffer.from(String(req.query.key || req.get('x-api-key') || ''));
    const expected = Buffer.from(OBJECTS_API_KEY);
    if (provided.length === expected.length && require('crypto').timingSafeEqual(provided, expected)) return next();
    res.status(403).json({ error: 'Acces refuse : localhost ou ?key=OBJECTS_API_KEY requis' });
}

function mapSignature() {
    let n = 0;
    for (const blocks of chunkTerrainCache.values()) if (Array.isArray(blocks)) n += blocks.length;
    return chunkTerrainCache.size + ':' + n + ':' + farChunkCache.size;
}

app.get('/api/map', mapAccess, (req, res) => {
    const palette = [];
    const paletteIdx = new Map();
    const idxOf = (name) => {
        let i = paletteIdx.get(name);
        if (i === undefined) { i = palette.length; palette.push(name); paletteIdx.set(name, i); }
        return i;
    };
    const chunks = [];
    for (const [key, blocks] of chunkTerrainCache) {
        if (!Array.isArray(blocks) || blocks.length === 0) continue;
        const flat = [];
        for (const b of blocks) flat.push(idxOf(b.name), b.x, b.y, b.z);
        chunks.push({ k: key, b: flat });
    }
    const far = [];
    for (const [key, v] of farChunkCache) {
        if (!v || v.empty || chunkTerrainCache.has(key)) continue; // le detail l'emporte sur le lointain
        far.push([v.chunkX, v.chunkZ, v.y, idxOf(v.name)]);
    }
    res.json({ sig: mapSignature(), palette, chunks, far });
});

app.get('/api/map/players', mapAccess, (req, res) => {
    const now = Date.now();
    const players = [];
    if (mainBot && mainBot.entity && mainBot.entity.position) {
        const p = mainBot.entity.position;
        players.push({ name: 'GrokBot', kind: 'bot', x: p.x, y: p.y, z: p.z });
    }
    for (const [name, st] of Object.entries(robloxPlayersState)) {
        if (!st || !Number.isFinite(st.x) || now - (st.lastUpdate || 0) > 15000) continue;
        players.push({ name, kind: 'roblox', device: getDevice(name), x: st.x, y: st.y, z: st.z });
    }
    for (const [name, st] of mcPlayerPrevPos) {
        if (!st || now - (st.time || 0) > 30000) continue;
        players.push({ name, kind: 'minecraft', x: st.x, y: st.y, z: st.z });
    }
    res.json({ sig: mapSignature(), players });
});

const MAP_PAGE_HTML = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Carte 3D du monde</title>
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#87b7e8;font-family:system-ui,sans-serif}
canvas{display:block;touch-action:none}
#ui{position:fixed;top:10px;left:10px;background:rgba(0,0,0,.6);color:#fff;padding:10px 12px;border-radius:10px;font-size:13px;max-width:260px}
#ui select,#ui button{margin-top:6px;width:100%;padding:6px;border-radius:6px;border:0;font-size:13px}
#legend span{display:inline-block;margin:2px 6px 0 0}
#legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:3px;vertical-align:middle}
</style></head><body>
<div id="ui">
<b>Carte 3D</b> <span id="stat">chargement...</span>
<select id="focus"><option value="">Suivre : libre</option></select>
<button id="reload">Recharger le monde</button>
<div id="legend"></div>
<div style="margin-top:6px;opacity:.8">Glisser = tourner - clic droit/Maj = deplacer - molette/pincer = zoom</div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
var KEY = new URLSearchParams(location.search).get('key');
function api(p){ return fetch(p + (KEY ? (p.indexOf('?')<0?'?':'&') + 'key=' + encodeURIComponent(KEY) : '')).then(function(r){return r.json();}); }

var renderer = new THREE.WebGLRenderer({antialias:false});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);
var scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b7e8);
var camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.5, 4000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 0.9));
var sun = new THREE.DirectionalLight(0xffffff, 0.6); sun.position.set(0.5,1,0.3); scene.add(sun);

// --- controles orbitaux (souris + tactile) ---
var target = new THREE.Vector3(0,64,0), theta = 0.8, phi = 1.0, dist = 120;
function updateCam(){
  camera.position.set(target.x + dist*Math.sin(phi)*Math.sin(theta), target.y + dist*Math.cos(phi), target.z + dist*Math.sin(phi)*Math.cos(theta));
  camera.lookAt(target);
}
function pan(dx, dy){
  var k = dist*0.0022;
  target.x -= Math.cos(theta)*dx*k; target.z += Math.sin(theta)*dx*k;
  target.x += -Math.sin(theta)*dy*k; target.z += -Math.cos(theta)*dy*k;
}
var ptrs = {}, lastPinch = 0;
var cv = renderer.domElement;
cv.addEventListener('contextmenu', function(e){ e.preventDefault(); });
cv.addEventListener('pointerdown', function(e){ cv.setPointerCapture(e.pointerId); ptrs[e.pointerId] = {x:e.clientX, y:e.clientY}; lastPinch = 0; focusSel.value=''; });
cv.addEventListener('pointerup', function(e){ delete ptrs[e.pointerId]; lastPinch = 0; });
cv.addEventListener('pointermove', function(e){
  var p = ptrs[e.pointerId]; if(!p) return;
  var dx = e.clientX - p.x, dy = e.clientY - p.y;
  var ids = Object.keys(ptrs);
  if (ids.length === 1) {
    if ((e.buttons & 2) || e.shiftKey) pan(dx, dy);
    else { theta -= dx*0.005; phi = Math.max(0.1, Math.min(1.5, phi - dy*0.005)); }
  } else if (ids.length === 2) {
    var a = ptrs[ids[0]], b = ptrs[ids[1]];
    var d = Math.hypot(a.x-b.x, a.y-b.y);
    if (lastPinch) dist = Math.max(8, Math.min(1500, dist * lastPinch / d));
    lastPinch = d; pan(dx/2, dy/2);
  }
  p.x = e.clientX; p.y = e.clientY;
});
cv.addEventListener('wheel', function(e){ e.preventDefault(); dist = Math.max(8, Math.min(1500, dist*(1 + Math.sign(e.deltaY)*0.1))); }, {passive:false});
addEventListener('resize', function(){ renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); });

// --- couleurs des blocs (selon le nom) ---
var COLORS = [['grass',0x5da64a],['leaves',0x2f7a2c],['log',0x6b4f2a],['wood',0x6b4f2a],['planks',0xb08a50],['dirt',0x8a5c3a],['podzol',0x6a4a2a],['mud',0x4a3a30],
 ['sand',0xe3d59a],['gravel',0x8d8a88],['snow',0xf4f8ff],['ice',0xa6d4f2],['water',0x3b6fd6],['lava',0xff6a1a],['deepslate',0x4a4a52],['netherrack',0x7a2a2a],
 ['terracotta',0xb26a4a],['clay',0x9aa5b8],['stone',0x8a8a8a],['cobble',0x7c7c7c],['coal',0x333333],['iron',0xc9a98c],['gold',0xf2d13a],['diamond',0x55e0d6],
 ['bedrock',0x222222],['glass',0xc8e6f2],['brick',0xa3503f],['sandstone',0xd9c98a],['obsidian',0x1d1033],['wool',0xe8e8e8],['concrete',0xbdbdbd]];
function colorOf(name){
  for (var i=0;i<COLORS.length;i++) if (name.indexOf(COLORS[i][0])>=0) return COLORS[i][1];
  var h=0; for (var j=0;j<name.length;j++) h=(h*31+name.charCodeAt(j))|0;
  return new THREE.Color().setHSL(((h>>>0)%360)/360, 0.45, 0.55).getHex();
}

// --- monde ---
var worldMesh = null, farMesh = null, lastSig = null, loading = false, lastLoad = 0, blockCount = 0, farCount = 0;
function disposeMesh(m){ if(m){ scene.remove(m); m.geometry.dispose(); m.material.dispose(); } }
function buildWorld(data){
  disposeMesh(worldMesh); disposeMesh(farMesh); worldMesh = farMesh = null;
  var cols = data.palette.map(function(n){ return new THREE.Color(colorOf(n)); });
  var total = 0; data.chunks.forEach(function(c){ total += c.b.length/4; });
  blockCount = total; farCount = data.far.length;
  var m = new THREE.Matrix4();
  if (total > 0) {
    worldMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshLambertMaterial(), total);
    var n = 0;
    data.chunks.forEach(function(c){
      var b = c.b;
      for (var i=0;i<b.length;i+=4){
        m.makeTranslation(b[i+1]+0.5, b[i+2]+0.5, b[i+3]+0.5);
        worldMesh.setMatrixAt(n, m); worldMesh.setColorAt(n, cols[b[i]]); n++;
      }
    });
    worldMesh.instanceMatrix.needsUpdate = true; worldMesh.instanceColor.needsUpdate = true;
    scene.add(worldMesh);
  }
  if (data.far.length > 0) {
    farMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(16,2,16), new THREE.MeshLambertMaterial(), data.far.length);
    data.far.forEach(function(f, i){
      m.makeTranslation(f[0]*16+8, f[2]-1, f[1]*16+8);
      farMesh.setMatrixAt(i, m); farMesh.setColorAt(i, cols[f[3]]);
    });
    farMesh.instanceMatrix.needsUpdate = true; farMesh.instanceColor.needsUpdate = true;
    scene.add(farMesh);
  }
}
function loadWorld(force){
  if (loading || (!force && Date.now()-lastLoad < 4000)) return;
  loading = true;
  api('/api/map').then(function(d){ buildWorld(d); lastSig = d.sig; lastLoad = Date.now(); loading = false; updateStat(); })
    .catch(function(){ loading = false; });
}

// --- joueurs ---
var DEVICE_COLORS = {PC:0x3b82f6, Mobile:0xf97316, Tablet:0xeab308, Console:0xa855f7, Gamepad:0x14b8a6, VR:0xec4899, Generic:0x9ca3af};
var legend = document.getElementById('legend');
legend.innerHTML = Object.keys(DEVICE_COLORS).map(function(k){ return '<span><i style="background:#'+DEVICE_COLORS[k].toString(16).padStart(6,'0')+'"></i>'+k+'</span>'; }).join('')
  + '<span><i style="background:#fff"></i>Bot</span><span><i style="background:#999"></i>Minecraft</span>';
var markers = {};
function makeLabel(text){
  var c = document.createElement('canvas'); c.width = 256; c.height = 64;
  var g = c.getContext('2d'); g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(0,0,256,64);
  g.fillStyle = '#fff'; g.font = 'bold 26px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 128, 32);
  var s = new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(c), depthTest:false}));
  s.scale.set(10, 2.5, 1); s.position.y = 3.2; s.renderOrder = 10; return s;
}
function updatePlayers(list){
  var seen = {};
  list.forEach(function(p){
    var id = p.kind + ':' + p.name; seen[id] = true;
    var color = p.kind==='roblox' ? (DEVICE_COLORS[p.device] || 0x3b82f6) : p.kind==='bot' ? 0xffffff : 0x999999;
    var label = p.name + (p.device ? ' (' + p.device + ')' : '');
    var mk = markers[id];
    if (!mk || mk.label !== label) {
      if (mk) scene.remove(mk.obj);
      var grp = new THREE.Group();
      var body = new THREE.Mesh(new THREE.BoxGeometry(0.9,1.8,0.9), new THREE.MeshBasicMaterial({color:color}));
      body.position.y = 0.9; grp.add(body); grp.add(makeLabel(label));
      scene.add(grp); mk = markers[id] = {obj:grp, label:label};
    }
    mk.obj.position.set(p.x, p.y, p.z); mk.data = p;
  });
  Object.keys(markers).forEach(function(id){ if(!seen[id]){ scene.remove(markers[id].obj); delete markers[id]; } });
  var sel = focusSel.value;
  focusSel.innerHTML = '<option value="">Suivre : libre</option>' + list.map(function(p){
    var id = p.kind+':'+p.name; return '<option value="'+id+'">'+p.name+(p.device?' ('+p.device+')':'')+'</option>'; }).join('');
  focusSel.value = markers[sel] ? sel : '';
}
var focusSel = document.getElementById('focus');
document.getElementById('reload').onclick = function(){ loadWorld(true); };

function updateStat(){ document.getElementById('stat').textContent = blockCount + ' blocs - ' + farCount + ' zones lointaines - ' + Object.keys(markers).length + ' joueurs'; }

var firstCenter = true;
function poll(){
  api('/api/map/players').then(function(d){
    updatePlayers(d.players); updateStat();
    if (d.sig !== lastSig) loadWorld(false);
    if (firstCenter && d.players.length) { var p = d.players[0]; target.set(p.x, p.y, p.z); firstCenter = false; }
  }).catch(function(){}).then(function(){ setTimeout(poll, 1000); });
}
loadWorld(true); poll();

(function loop(){
  requestAnimationFrame(loop);
  var f = markers[focusSel.value];
  if (f) target.lerp(f.obj.position, 0.15);
  updateCam(); renderer.render(scene, camera);
})();
</script></body></html>`;

app.get('/map', mapAccess, (req, res) => {
    res.type('html').send(MAP_PAGE_HTML);
});

app.use((req, res) => {
    res.status(404).json({ error: 'Route non trouvée' });
});

// ---------------------------------------------------------
// 8. FERMETURE PROPRE & DÉMARRAGE DU SERVEUR
// ---------------------------------------------------------
function shutdown() {
    console.log('\nArret propre du serveur...');
    saveObjectsNow();
    for (const [, state] of serverStates) {
        if (state.liveSyncTimer) clearInterval(state.liveSyncTimer);
        if (state.antiAfkTimer)  clearTimeout(state.antiAfkTimer);
        if (state.bot) { try { state.bot.quit(); } catch (e) { ignoreErr(e); } }
    }
    if (liveSyncTimer) clearInterval(liveSyncTimer);
    if (grokAntiAfkTimer) clearTimeout(grokAntiAfkTimer);
    activeBots.forEach((bot) => { try { bot.quit(); } catch (e) { ignoreErr(e); } });
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Filet de securite : une erreur reseau non geree (ECONNREFUSED, ECONNRESET...)
// ne doit pas faire tomber tout le pont Roblox/Minecraft. Les autres erreurs
// restent loguees avec leur stack.
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']);
process.on('uncaughtException', err => {
    if (err && NETWORK_ERROR_CODES.has(err.code)) {
        console.log('⚠️ [Reseau] ' + err.code + (err.address ? ' ' + err.address + ':' + err.port : '') + ' (ignore, reconnexion automatique)');
        return;
    }
    console.error('❌ uncaughtException:', err);
});
process.on('unhandledRejection', err => {
    if (err && NETWORK_ERROR_CODES.has(err.code)) {
        console.log('⚠️ [Reseau] ' + err.code + ' (promesse rejetee, ignore)');
        return;
    }
    console.error('❌ unhandledRejection:', err);
});

app.listen(PORT, HOST, () => {
    // Initialise les etats par serveur AVANT de connecter les bots
    initServerStates();

    const enabled = SERVERS.filter(s => s.enabled);
    console.log('==================================================');
    console.log('  Serveur Bridge Node.js MULTI-SERVEUR');
    console.log('  Actif sur http://' + HOST + ':' + PORT);
    console.log('  Carte 3D  : http://localhost:' + PORT + '/map');
    console.log('  ' + enabled.length + ' serveur(s) Minecraft configure(s) :');
    for (const srv of enabled) {
        console.log('    - [' + srv.id + '] ' + srv.name + ' -> ' + srv.host + ':' + srv.port);
    }
    console.log('==================================================');

    // Trop-plein : verification periodique des places libres + bascule automatique
    setInterval(overflowMonitorTick, OVERFLOW_CHECK_MS).unref();

    // Connexion de tous les serveurs actives (decalage de 2s entre chacun)
    enabled.forEach((srv, idx) => {
        setTimeout(() => connectServer(srv.id), idx * 2000);
    });
});

module.exports = { app, worldData, getDevice, getSettings, listDevices };