/**
 * Sistema estelar: vários planetas reais (com terreno, atmosfera e vegetação)
 * orbitando uma estrela, servidos por UM pool de workers.
 *
 * A diferença entre "uma demo de planeta" e "um universo" é justamente esta
 * classe: o jogador escolhe um destino, viaja e chega — sem carregamento,
 * porque todos os corpos já estão na mesma cena desde o início. O que muda com
 * a distância é só o nível de detalhe, e disso a quadtree já cuida sozinha.
 */

import * as THREE from 'three';
import { Planet } from './Planet.js';
import { WorkerPool } from '../workers/WorkerPool.js';
import { createStarBackdrop } from './StarField.js';
import { mulberry32 } from '../shared/noise.js';

/**
 * Onde cada corpo fica. Distâncias generosas de propósito: o pulse drive
 * precisa ter o que atravessar para a viagem interplanetária ter peso.
 */
function layout(rand) {
  const bodies = [];

  // Corpo inicial na origem — é onde a nave começa.
  bodies.push({ offset: new THREE.Vector3(0, 0, 0), scale: 1 });

  // Uma lua próxima: dá um destino alcançável em segundos e uma referência
  // visual de escala no céu do planeta principal.
  bodies.push({
    offset: new THREE.Vector3(6200, 1400, -4800),
    scale: 0.42,
    moon: true,
  });

  const count = 2 + ((rand() * 2) | 0);
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const distance = 16000 + i * 14000 + rand() * 9000;
    bodies.push({
      offset: new THREE.Vector3(
        Math.cos(angle) * distance,
        (rand() - 0.5) * 6000,
        Math.sin(angle) * distance
      ),
      scale: 0.8 + rand() * 0.5,
    });
  }

  return bodies;
}

export class StarSystem {
  /**
   * @param {THREE.Scene} scene
   * @param {number} seed
   */
  constructor(scene, seed) {
    this.scene = scene;
    this.seed = seed;

    const rand = mulberry32(seed ^ 0x5bf03635);

    this.backdrop = createStarBackdrop(scene, seed);
    this.sunDirection = this.backdrop.sunDirection;
    this.sunLight = this.backdrop.sunLight;

    // Um pool para todos. Ver a justificativa em WorkerPool.js.
    this.pool = new WorkerPool(
      () => new Worker(new URL('../workers/terrain.worker.js', import.meta.url), { type: 'module' }),
      (data) => this._route(data)
    );

    /** @type {Planet[]} */
    this.planets = [];
    /** @type {Map<number, Planet>} */
    this.byId = new Map();

    layout(rand).forEach((body, index) => {
      const planetSeed = (seed + index * 7919) >>> 0;

      // ---------------------------------------------------------------------
      // A ESCALA VAI PARA DENTRO DA CONFIG, ANTES DE CONSTRUIR O PLANETA.
      //
      // Antes ela era aplicada AQUI, depois do `new Planet(...)` — e era um bug
      // sério, ainda que silencioso. Quando esta linha rodava, o planeta já
      // tinha:
      //   - criado o `sampler` de colisão,
      //   - enviado a config ao worker (structured clone: uma CÓPIA, que nunca
      //     mais via a alteração feita aqui),
      //   - construído as malhas de atmosfera e de nuvens.
      //
      // Ou seja: o terreno que você VÊ nascia com o raio sorteado, enquanto
      // `sampleAt()` — que responde por altitude, gravidade, pouso e colisão —
      // passava a usar o raio ESCALADO. Numa lua (escala 0,42) a nave
      // atravessava o solo visível e só parava lá dentro; num planeta de escala
      // 1,3 ela "pousava" a centenas de unidades no ar, e o jogo oferecia sair
      // da nave no vazio.
      // ---------------------------------------------------------------------
      const planet = new Planet(planetSeed, scene, body.offset, this.pool, index, body.scale);

      planet.isMoon = !!body.moon;
      this.planets.push(planet);
      this.byId.set(index, planet);
    });

    this._tmp = new THREE.Vector3();
  }

  get isReady() {
    return this.planets.every((p) => p.chunks.isReady);
  }

  get activeChunks() {
    return this.planets.reduce((sum, p) => sum + p.chunks.activeChunks, 0);
  }

  get queueLength() {
    return this.planets.reduce((sum, p) => sum + p.chunks.queueLength, 0);
  }

  get triangles() {
    return this.planets.reduce((sum, p) => sum + p.chunks.triangles, 0);
  }

  /**
   * Planeta cuja SUPERFÍCIE está mais perto — não cujo centro está mais perto.
   * Um gigante distante pode ter o centro mais próximo que uma lua ao lado da
   * nave; o que importa para gravidade, atmosfera e pouso é a superfície.
   *
   * @param {THREE.Vector3} worldPosition
   * @returns {Planet}
   */
  nearestPlanet(worldPosition) {
    let best = this.planets[0];
    let bestDistance = Infinity;

    for (const planet of this.planets) {
      const distance = this._tmp.copy(worldPosition).sub(planet.group.position).length() - planet.radius;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = planet;
      }
    }
    return best;
  }

  /**
   * Estrelas e sol. Roda ANTES da física porque define a direção do sol que o
   * resto do frame usa (iluminação, terminador, dia/noite).
   */
  updateBackdrop(camera, elapsed, atmosphereFactor) {
    this.backdrop.update(camera, elapsed, atmosphereFactor);
  }

  /**
   * LOD dos planetas. Roda DEPOIS da câmera: a quadtree precisa subdividir em
   * torno de onde a câmera realmente está neste frame, não onde estava no
   * anterior.
   *
   * @param {THREE.Vector3} cameraPosition
   * @param {Planet} active planeta em foco (recebe atualização completa)
   * @param {number} elapsed segundos desde o boot
   */
  updatePlanets(cameraPosition, active, elapsed) {
    for (const planet of this.planets) {
      if (planet === active) planet.update(cameraPosition, this.sunDirection, elapsed);
      else planet.updateDistant(cameraPosition, this.sunDirection, elapsed);
    }
  }

  _route(data) {
    if (data.type !== 'chunk') return;
    const planet = this.byId.get(data.planetId);
    if (planet) planet.chunks._onChunkReady(data);
  }

  dispose() {
    this.pool.dispose();
    for (const planet of this.planets) planet.dispose();
    this.backdrop.dispose();
  }
}
