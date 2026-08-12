/**
 * Ponto de entrada: monta o sistema estelar e roda o loop.
 *
 * ORDEM DE ATUALIZAÇÃO POR FRAME (importa!)
 *   1. fundo estelar   -> define a direção do sol deste frame
 *   2. planeta ativo   -> o corpo mais próximo governa gravidade e atmosfera
 *   3. física          -> nave OU jogador a pé
 *   4. estado do jogo  -> lê a nova altitude e ajusta névoa/luz/exposição
 *   5. câmera          -> posição final deste frame
 *   6. LOD dos planetas-> subdivide em torno da câmera JÁ atualizada
 *   7. ferramentas + HUD
 *
 * Atualizar o LOD antes de mover a câmera custa um frame de atraso na
 * subdivisão — visível como terreno que "engrossa" tarde ao mergulhar.
 */

import * as THREE from 'three';
import { Engine } from './core/Engine.js';
import { GameState, Phase } from './core/GameState.js';
import { StarSystem } from './world/StarSystem.js';
import { createShip } from './entities/Ship.js';
import { WarpLines } from './entities/WarpLines.js';
import { ShipController } from './controls/ShipController.js';
import { PlayerController } from './controls/PlayerController.js';
import { Inventory } from './game/Inventory.js';
import { Discovery } from './game/Discovery.js';
import { Scanner } from './game/Scanner.js';
import { HUD, toLatLon } from './ui/HUD.js';

/* ========================================================================== */
/* Seed                                                                       */
/* ========================================================================== */

// `?seed=12345` na URL reproduz exatamente o mesmo sistema estelar. Todo o
// universo desta PoC cabe nesse inteiro — é o que torna "infinito" viável.
const params = new URLSearchParams(location.search);
const SEED = params.has('seed')
  ? Number(params.get('seed')) >>> 0
  : (Math.random() * 0xffffffff) >>> 0;

/* ========================================================================== */
/* Montagem                                                                   */
/* ========================================================================== */

const canvas = document.getElementById('viewport');
const engine = new Engine(canvas);

const starSystem = new StarSystem(engine.scene, SEED);
const homePlanet = starSystem.planets[0];

const ship = createShip();
engine.scene.add(ship.group);
ship.group.position
  .copy(homePlanet.group.position)
  .add(new THREE.Vector3(homePlanet.radius * 0.35, homePlanet.radius * 0.55, homePlanet.radius * 2.1));
orientTowards(ship.group, homePlanet.group.position);

const shipController = new ShipController(ship.group, canvas);
const playerController = new PlayerController(canvas);
const warpLines = new WarpLines(engine.scene);

const gameState = new GameState(engine, starSystem);
const inventory = new Inventory();
const discovery = new Discovery();
const scanner = new Scanner(engine.scene);
const hud = new HUD();

/** 'SHIP' | 'FOOT' */
let mode = 'SHIP';
let activePlanet = homePlanet;

shipController.updateCamera(engine.camera, 1);

/**
 * Aponta o -Z de um objeto para um alvo.
 * `Object3D.lookAt()` NÃO serve: para objetos que não são câmera/luz ele
 * alinha o +Z, o oposto da convenção usada pela nave.
 */
function orientTowards(object, target) {
  const matrix = new THREE.Matrix4().lookAt(object.position, target, object.up);
  object.quaternion.setFromRotationMatrix(matrix);
}

/* ========================================================================== */
/* Tela de abertura                                                           */
/* ========================================================================== */

const overlay = document.getElementById('overlay');
const startButton = document.getElementById('start-btn');
const bootStatus = document.getElementById('boot-status');

let started = false;
const CHUNKS_TO_BOOT = 30;

startButton.addEventListener('click', () => {
  if (startButton.disabled) return;
  started = true;
  overlay.classList.add('fade-out');
  hud.show();
  requestPointerLock();
  hud.notify(`SISTEMA ${homePlanet.name.toUpperCase()}`, 3.5);
});

canvas.addEventListener('click', () => {
  if (started) requestPointerLock();
});

function requestPointerLock() {
  // Pode rejeitar por motivos fora do nosso controle (documento aninhado,
  // política do navegador). O jogo continua jogável no teclado.
  canvas.requestPointerLock?.()?.catch?.(() => {});
}

/* ========================================================================== */
/* Entrar e sair da nave                                                      */
/* ========================================================================== */

const BOARDING_RANGE = 14;
const _shipToPlayer = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _eye = new THREE.Vector3();

function canBoard() {
  return mode === 'FOOT' && playerController.position.distanceTo(ship.group.position) < BOARDING_RANGE;
}

function canDisembark() {
  return mode === 'SHIP' && shipController.landed;
}

function disembark() {
  // Nasce ao lado da nave, não dentro dela: sair "dentro" da geometria da nave
  // empurraria o jogador para fora de forma imprevisível na primeira colisão.
  const side = new THREE.Vector3(1, 0, 0).applyQuaternion(ship.group.quaternion).multiplyScalar(6);
  const spawn = ship.group.position.clone().add(side);

  const facing = new THREE.Vector3(0, 0, -1).applyQuaternion(ship.group.quaternion);
  playerController.spawnAt(spawn, activePlanet, facing);
  playerController.enabled = true;
  mode = 'FOOT';
  hud.notify('FORA DA NAVE', 2.0);
}

function board() {
  playerController.enabled = false;
  mode = 'SHIP';
  shipController.velocity.set(0, 0, 0);
  shipController.throttle = 0;
  hud.notify('A BORDO', 2.0);
}

window.addEventListener('keydown', (event) => {
  if (!started || event.ctrlKey || event.metaKey || event.altKey) return;

  if (event.code === 'KeyF') {
    if (canDisembark()) disembark();
    else if (canBoard()) board();
  }

  if (event.code === 'KeyV' && mode === 'FOOT') {
    runScan();
  }

  if (event.code === 'F3') {
    event.preventDefault();
    // Wireframe revela a quadtree: dá para ver os chunks subdividindo ao vivo.
    for (const planet of starSystem.planets) {
      planet.chunks.material.wireframe = !planet.chunks.material.wireframe;
    }
  }
});

/* ========================================================================== */
/* Multiferramenta                                                            */
/* ========================================================================== */

let mining = false;

canvas.addEventListener('mousedown', (event) => {
  if (started && mode === 'FOOT' && event.button === 0) mining = true;
});
window.addEventListener('mouseup', () => { mining = false; });

function runScan() {
  playerController.getEyePosition(_eye);
  const resultado = scanner.scan(_eye, activePlanet, discovery, inventory);

  if (resultado.novas.length > 0) {
    const primeira = resultado.novas[0];
    hud.showDiscovery(primeira.nome, primeira.categoria + ' · ' + activePlanet.name, resultado.unidades);
  } else {
    const total = resultado.contagem.reduce((a, b) => a + b, 0);
    hud.notify(total > 0 ? `${total} FORMAS DE VIDA NO RAIO` : 'NENHUM SINAL', 2.2);
  }
}

function updateTools(dt) {
  if (mode !== 'FOOT') {
    scanner.updateBeam(null, null);
    scanner.target = null;
    return;
  }

  playerController.getEyePosition(_eye);
  playerController.getLookDirection(_lookDir);

  const target = scanner.aim(_eye, _lookDir, activePlanet);

  if (mining && target) {
    scanner.updateBeam(_eye, target.position);
    const colheita = scanner.mine(dt, activePlanet, inventory);
    if (colheita) {
      if (colheita.cheio) hud.notify('CARGA CHEIA', 1.8);
      else hud.notify(`+${colheita.quantidade} ${colheita.nome.toUpperCase()}`, 1.4);
    }
  } else {
    scanner.updateBeam(null, null);
  }
}

/* ========================================================================== */
/* Descoberta de planetas                                                     */
/* ========================================================================== */

function checkPlanetDiscovery(planet, altitude) {
  // Registrado ao ENTRAR na atmosfera: é o momento em que o jogador de fato
  // chegou, e não apenas apontou a nave na direção certa.
  if (altitude > planet.config.atmosphere.height) return;
  const resultado = discovery.registerPlanet(planet);
  if (resultado.novo) {
    inventory.units += resultado.unidades;
    hud.showDiscovery(resultado.nome, `Planeta ${planet.config.type}`, resultado.unidades);
  }
}

/* ========================================================================== */
/* Marcadores                                                                 */
/* ========================================================================== */

const markerList = [];

function buildMarkers(referencePosition) {
  markerList.length = 0;

  if (mode === 'FOOT') {
    // A única coisa que importa a pé: onde ficou a nave.
    const distance = playerController.position.distanceTo(ship.group.position);
    markerList.push({
      id: 'ship',
      position: ship.group.position,
      label: 'NAVE',
      sub: `${distance.toFixed(0)} m`,
      kind: 'ship',
    });
    return markerList;
  }

  // Em voo: todos os corpos do sistema, para escolher destino sem abrir mapa.
  for (const planet of starSystem.planets) {
    if (planet === activePlanet && gameState.atmosphere > 0.15) continue;
    const distance = referencePosition.distanceTo(planet.group.position) - planet.radius;
    markerList.push({
      id: `planet-${planet.planetId}`,
      position: planet.group.position,
      label: planet.name.toUpperCase(),
      sub: formatRange(distance),
      kind: planet.isMoon ? 'moon' : 'planet',
    });
  }
  return markerList;
}

function formatRange(value) {
  if (value < 0) return 'superfície';
  if (value > 1000) return `${(value / 1000).toFixed(1)} km`;
  return `${value.toFixed(0)} m`;
}

/* ========================================================================== */
/* Transições                                                                 */
/* ========================================================================== */

gameState.onPhaseChange = (phase, previous) => {
  if (!started) return;

  if (phase === Phase.ATMOSPHERE && previous === Phase.SPACE) {
    hud.notify('ENTRADA ATMOSFÉRICA');
  } else if (phase === Phase.SPACE && previous === Phase.ATMOSPHERE) {
    hud.notify('ÓRBITA ALCANÇADA');
  } else if (phase === Phase.SURFACE && previous === Phase.ATMOSPHERE) {
    hud.notify('APROXIMAÇÃO FINAL');
  }
};

/* ========================================================================== */
/* Loop                                                                       */
/* ========================================================================== */

const _reference = new THREE.Vector3();
let biomeLabel = '—';
let biomeTimer = 0;
const BIOME_INTERVAL = 0.25;

engine.start((dt, elapsed) => {
  // 1. Sol deste frame (dia/noite) ---------------------------------------
  starSystem.updateBackdrop(engine.camera, elapsed, gameState.atmosphere);

  // 2. Quem manda agora: o corpo cuja superfície está mais perto ----------
  _reference.copy(mode === 'FOOT' ? playerController.position : ship.group.position);
  activePlanet = starSystem.nearestPlanet(_reference);

  // 3. Física --------------------------------------------------------------
  if (started) {
    if (mode === 'FOOT') playerController.update(dt, activePlanet);
    else shipController.update(dt, activePlanet, gameState.atmosphere);
  }
  _reference.copy(mode === 'FOOT' ? playerController.position : ship.group.position);

  // 4. Ambiente (névoa, luz, exposição) em função da nova altitude ---------
  const landed = mode === 'FOOT' ? playerController.grounded : shipController.landed;
  gameState.update(activePlanet, _reference, landed);
  if (started) checkPlanetDiscovery(activePlanet, gameState.altitude);

  // 5. Câmera --------------------------------------------------------------
  if (mode === 'FOOT') playerController.updateCamera(engine.camera);
  else shipController.updateCamera(engine.camera, dt);
  engine.tuneCameraPlanes(Math.max(gameState.altitude, 1));

  // 6. LOD + fila de geração ----------------------------------------------
  starSystem.updatePlanets(engine.camera.position, activePlanet);

  // 7. Ferramentas e efeitos ----------------------------------------------
  updateTools(dt);
  scanner.updatePulse(dt);
  warpLines.update(engine.camera, shipController.velocity, mode === 'SHIP' ? shipController.pulseSpool : 0);
  ship.setThrust(
    mode === 'FOOT' ? 0 : shipController.braking ? 0 : shipController.throttle * (shipController.boost ? 1 : 0.75)
  );

  // 8. Boot ----------------------------------------------------------------
  if (!started) {
    const ready = starSystem.isReady && starSystem.activeChunks >= CHUNKS_TO_BOOT;
    if (ready && startButton.disabled) {
      startButton.disabled = false;
      bootStatus.textContent =
        `${starSystem.planets.length} corpos · ${homePlanet.name} (${homePlanet.config.type}) · seed ${SEED}`;
    } else if (!ready) {
      bootStatus.textContent = starSystem.isReady
        ? `Gerando terreno… ${starSystem.activeChunks}/${CHUNKS_TO_BOOT} setores`
        : 'Iniciando workers de geração…';
    }
  }

  // 9. HUD ------------------------------------------------------------------
  const { latitude, longitude } = toLatLon(gameState.up);

  biomeTimer -= dt;
  if (biomeTimer <= 0) {
    // Classificar o bioma custa 3 avaliações de fBm. O HUD mostra isso como
    // texto a 10 Hz, então recalcular 60x por segundo é desperdício de CPU —
    // e essa CPU é a que a main thread precisa para manter o render loop.
    biomeTimer = BIOME_INTERVAL;
    biomeLabel = activePlanet.biomeAt(_reference);
  }

  const chunkStats = activePlanet.chunks;
  const totalRequests = chunkStats.cacheHits + chunkStats.cacheMisses;

  hud.update(dt, {
    speed: mode === 'FOOT' ? playerController.speed : shipController.speed,
    altitude: gameState.altitude,
    phase: mode === 'FOOT' ? 'A PÉ' : shipController.pulse ? 'PULSE' : gameState.phase,
    planetName: activePlanet.name,
    planetClass: activePlanet.config.type,
    biome: biomeLabel,
    latitude,
    longitude,
    cataloged: discovery.hasPlanet(activePlanet),
    onFoot: mode === 'FOOT',
    throttle: shipController.braking ? 0 : shipController.throttle,
    jetpack: playerController.fuelRatio,
    shield: 1,
    atmosphere: gameState.atmosphere,
    miningProgress: scanner.miningProgress,
    units: inventory.units,
    slotsUsed: inventory.slotsUsed,
    slots: inventory.slots,
    items: inventory.entries(),
    fps: engine.fps,
    chunks: starSystem.activeChunks,
    queue: starSystem.queueLength,
    props: activePlanet.props.instanceCount,
    cacheHitRate: totalRequests > 0 ? chunkStats.cacheHits / totalRequests : 0,
  });

  hud.updateMarkers(engine.camera, buildMarkers(_reference));

  // Prompt contextual
  if (!started) hud.setPrompt(null);
  else if (canDisembark()) hud.setPrompt('<b>F</b> sair da nave');
  else if (canBoard()) hud.setPrompt('<b>F</b> embarcar');
  else if (mode === 'FOOT' && scanner.target) hud.setPrompt('<b>Botão esq.</b> extrair &nbsp;·&nbsp; <b>V</b> varredura');
  else if (mode === 'FOOT') hud.setPrompt('<b>V</b> varredura');
  else if (shipController.pulseBlocked) hud.setPrompt(`pulse indisponível: ${shipController.pulseBlocked}`);
  else hud.setPrompt(null);
});

/* ========================================================================== */
/* Diagnóstico                                                                */
/* ========================================================================== */

if (!engine.isWebGL2) {
  console.warn('[NMS] WebGL2 indisponível — o fallback WebGL1 não foi testado.');
}

window.__nms = {
  engine, starSystem, ship, shipController, playerController,
  gameState, inventory, discovery, scanner, seed: SEED,
  get mode() { return mode; },
  get activePlanet() { return activePlanet; },
  disembark, board,
};

console.info(
  `%c[NMS] seed ${SEED} · ${starSystem.planets.length} corpos · ${homePlanet.config.name}`,
  'color:#58e8ff'
);
