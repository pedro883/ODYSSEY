/**
 * Um corpo planetário completo: quadtrees de superfície, oceano, atmosfera e
 * vegetação.
 *
 * Nada aqui é pré-calculado ou armazenado em disco — o planeta inteiro é
 * reconstruído a partir de `config.seed` toda vez. Instanciar outro planeta é
 * `new Planet(seed, scene, posição, pool, id)`; o pool de workers é
 * compartilhado por todo o sistema estelar.
 */

import * as THREE from 'three';
import { createPlanetConfig } from './PlanetConfig.js';
import { createTerrainSampler, CUBE_FACES } from '../shared/terrain.js';
import { ChunkManager } from './ChunkManager.js';
import { QuadTreeNode } from './QuadTreeNode.js';
import { PropScatter } from './PropScatter.js';
import { createAtmosphere } from '../shaders/AtmosphereShader.js';

const _tangentA = new THREE.Vector3();
const _tangentB = new THREE.Vector3();

export class Planet {
  /**
   * @param {number} seed
   * @param {THREE.Scene} scene
   * @param {THREE.Vector3} position posição do planeta no sistema
   * @param {import('../workers/WorkerPool.js').WorkerPool} pool
   * @param {number} planetId identificador dentro do pool compartilhado
   */
  constructor(seed, scene, position, pool, planetId) {
    this.config = createPlanetConfig(seed);
    this.planetId = planetId;

    // O MESMO amostrador que roda dentro dos workers. Aqui ele serve para
    // altitude da nave, colisão e posicionamento dos nós da quadtree — se as
    // duas implementações divergissem, a nave atravessaria o chão visível.
    this.sampler = createTerrainSampler(this.config);

    this.group = new THREE.Group();
    this.group.position.copy(position);
    scene.add(this.group);

    this.terrainGroup = new THREE.Group();
    this.group.add(this.terrainGroup);

    pool.register(planetId, this.config);
    this.chunks = new ChunkManager(this.config, this.terrainGroup, pool, planetId);

    this.props = new PropScatter(this, this.terrainGroup);
    this.chunks.props = this.props;

    // Uma quadtree por face do cubo. Cada raiz cobre 1/6 do planeta.
    this.roots = CUBE_FACES.map((_, face) => new QuadTreeNode(this, face, 0, 0, 1, 0));

    // --- Oceano ------------------------------------------------------------
    // Esfera simples no nível do mar. Barato e resolve 90% da leitura visual:
    // o relevo abaixo de zero já foi gerado como fundo submarino.
    if (this.config.hasWater) {
      const waterColor = new THREE.Color().fromArray(this.config.waterColor);
      this.ocean = new THREE.Mesh(
        new THREE.SphereGeometry(this.config.radius, 128, 96),
        new THREE.MeshStandardMaterial({
          color: waterColor,
          transparent: true,
          opacity: 0.85,
          roughness: 0.06,
          metalness: 0.15,
        })
      );
      this.ocean.renderOrder = 1;
      this.group.add(this.ocean);
    }

    // --- Atmosfera ---------------------------------------------------------
    const atmosphere = createAtmosphere(this.config);
    this.atmosphereMesh = atmosphere.mesh;
    this.atmosphereUniforms = atmosphere.uniforms;
    this.atmosphereUniforms.uPlanetCenter.value.copy(position);
    this.group.add(this.atmosphereMesh);

    this._localPoint = new THREE.Vector3();

    /**
     * Resultado reaproveitado de `sampleAt()`. Por INSTÂNCIA e não por módulo:
     * com vários planetas no sistema, um objeto compartilhado seria sobrescrito
     * assim que outro planeta fosse consultado no mesmo frame.
     */
    this._sample = {
      distance: 0,
      surfaceRadius: 0,
      altitude: 0,
      direction: new THREE.Vector3(),
      elevation: 0,
    };
  }

  get name() {
    return this.config.name;
  }

  get radius() {
    return this.config.radius;
  }

  get atmosphereRadius() {
    return this.config.radius + this.config.atmosphere.height;
  }

  /**
   * Atualiza LOD e fila de geração.
   * @param {THREE.Vector3} cameraWorld posição da câmera em espaço de mundo
   * @param {THREE.Vector3} sunDirection direção normalizada até o sol
   */
  update(cameraWorld, sunDirection) {
    const cameraLocal = this._localPoint.copy(cameraWorld).sub(this.group.position);

    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);

    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(cameraLocal.lengthSq() < this.atmosphereRadius * this.atmosphereRadius);
  }

  /**
   * Atualização barata para planetas distantes: só a atmosfera e o LOD
   * grosseiro. Evita percorrer 900 nós de quadtree de um mundo que está a
   * 40 000 unidades e ocupa 20 pixels na tela.
   */
  updateDistant(cameraWorld, sunDirection) {
    const cameraLocal = this._localPoint.copy(cameraWorld).sub(this.group.position);
    for (const root of this.roots) root.update(cameraLocal);
    this.chunks.update(cameraLocal);
    this.atmosphereUniforms.uSunDirection.value.copy(sunDirection);
    this.setAtmosphereSide(false);
  }

  /**
   * Escolhe qual face da casca atmosférica é renderizada.
   * Ver a explicação longa no topo de `AtmosphereShader.js` — em resumo:
   * de fora, as faces frontais são as únicas que sobrevivem ao depth test
   * sobre o disco do planeta; de dentro, só as traseiras estão à frente da
   * câmera. Trocar `side` é estado de renderização, não exige recompilar
   * o shader.
   *
   * @param {boolean} inside a câmera está dentro da casca?
   */
  setAtmosphereSide(inside) {
    const side = inside ? THREE.BackSide : THREE.FrontSide;
    if (this.atmosphereMesh.material.side !== side) {
      this.atmosphereMesh.material.side = side;
    }
  }

  /**
   * Consulta o terreno sob uma posição de mundo.
   * Devolve SEMPRE o mesmo objeto — copie o que precisar guardar.
   *
   * @param {THREE.Vector3} worldPosition
   */
  sampleAt(worldPosition) {
    const sample = this._sample;
    const local = sample.direction.copy(worldPosition).sub(this.group.position);
    const distance = local.length();
    // Guarda contra a singularidade exata no centro do planeta.
    local.divideScalar(distance || 1);

    const elevation = this.sampler.heightAt(local.x, local.y, local.z);

    // Em mundos com oceano o "chão" para pouso é o nível do mar, não o fundo.
    const groundElevation = this.config.hasWater ? Math.max(elevation, 0) : elevation;

    sample.distance = distance;
    sample.elevation = elevation;
    sample.surfaceRadius = this.config.radius + groundElevation;
    sample.altitude = distance - sample.surfaceRadius;
    return sample;
  }

  /** Declive do terreno em [0,1] sob uma posição. */
  slopeAt(worldPosition) {
    const s = this.sampleAt(worldPosition);
    const d = s.direction;

    const eps = 0.0004;
    const tangent = _tangentA.set(-d.y, d.x, 0);
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    tangent.normalize();
    const bitangent = _tangentB.crossVectors(d, tangent);

    const hA = this.sampler.heightAt(d.x + tangent.x * eps, d.y + tangent.y * eps, d.z + tangent.z * eps);
    const hB = this.sampler.heightAt(d.x + bitangent.x * eps, d.y + bitangent.y * eps, d.z + bitangent.z * eps);
    const run = this.config.radius * eps;
    return Math.min(1, Math.hypot(hA - s.elevation, hB - s.elevation) / (run || 1));
  }

  /** Nome do bioma sob a posição. */
  biomeAt(worldPosition) {
    const slope = this.slopeAt(worldPosition);
    const s = this.sampleAt(worldPosition);
    return this.sampler.biomeAt(s.direction.x, s.direction.y, s.direction.z, s.elevation, slope);
  }

  dispose() {
    for (const root of this.roots) root.dispose();
    this.chunks.dispose();
    this.props.dispose();

    this.atmosphereMesh.geometry.dispose();
    this.atmosphereMesh.material.dispose();
    if (this.ocean) {
      this.ocean.geometry.dispose();
      this.ocean.material.dispose();
    }
    this.group.removeFromParent();
  }
}
