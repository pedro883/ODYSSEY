/**
 * Carregamento e preparo dos modelos glTF.
 *
 * Faz a ponte entre "arquivo .glb no disco" e "geometria pronta para
 * InstancedMesh", resolvendo quatro problemas que aparecem sempre que se troca
 * geometria procedural por arte de verdade:
 *
 *   1. Um .glb é uma CENA (hierarquia de nós com transformações), não uma
 *      geometria. Instancing precisa de UMA geometria — daí o achatamento.
 *   2. Cada modelo vem na escala e no pivô que o artista escolheu. O jogo
 *      precisa de convenção única: base na origem, altura 1.
 *   3. Vários modelos Kenney apontam para o MESMO `Textures/colormap.png`. Sem
 *      deduplicação, 10 animais = 10 cópias da mesma textura na VRAM.
 *   4. Assets podem faltar (quem clonou o repo e não rodou `npm run assets`).
 *      Nesse caso devolvemos a primitiva antiga e o jogo continua jogável.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Base das URLs dos assets.
 *
 * Precisa passar por `BASE_URL` por causa do `base: './'` no vite.config: em
 * desenvolvimento vira `/models/...`, no build vira `./models/...` e continua
 * funcionando quando o site é hospedado numa subpasta.
 */
const BASE = `${import.meta.env.BASE_URL}models/`;

/** Atributos mantidos ao achatar. Qualquer outro impede o merge. */
const ATTRIBUTES = ['position', 'normal', 'uv'];

const _box = new THREE.Box3();
const _size = new THREE.Vector3();
const _center = new THREE.Vector3();

/**
 * Pasta do modelo (`fauna/animal-fox.glb` -> `fauna`).
 *
 * É a chave de deduplicação de textura. Não é um atalho preguiçoso: o
 * `scripts/extract-assets.ps1` GARANTE que uma pasta de destino recebe textura
 * externa de um pack só — e aborta se algum dia deixar de ser verdade. Então
 * "mesma pasta" e "mesmo arquivo de textura" são equivalentes por construção.
 */
function pastaDe(path) {
  const i = path.indexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export class AssetLibrary {
  constructor() {
    this.loader = new GLTFLoader();
    /** @type {Map<string, Promise<any>>} */
    this._pending = new Map();
    /** @type {Map<string, THREE.BufferGeometry|null>} */
    this.geometries = new Map();
    /** @type {Map<string, {scene: THREE.Object3D, animations: THREE.AnimationClip[]}|null>} */
    this.scenes = new Map();

    /**
     * Uma textura por pasta de modelos.
     *
     * NÃO é um atlas único global: Cube Pets e Survival Kit têm colormaps
     * DIFERENTES, e aplicar o do deserto num animal (ou vice-versa) daria cores
     * aleatórias, porque as UVs de cada pack apontam para regiões próprias.
     * @type {Map<string, THREE.Texture>}
     */
    this._textures = new Map();
    /** Textura que cada modelo usa, ou null se ele não tem nenhuma. */
    this._modelTexture = new Map();

    /** glTF já resolvidos, para acesso síncrono depois do preload. */
    this._gltf = new Map();

    this.loaded = 0;
    this.failed = 0;
    /** @type {string[]} */
    this.missing = [];
  }

  get total() {
    return this.loaded + this.failed;
  }

  /**
   * Carrega um .glb uma única vez, mesmo se pedido em paralelo.
   * @param {string} path caminho relativo a public/models/
   */
  _load(path) {
    let promise = this._pending.get(path);
    if (promise) return promise;

    promise = new Promise((resolve) => {
      this.loader.load(
        BASE + path,
        (gltf) => {
          this._shareTextures(gltf.scene, path);
          this._gltf.set(path, gltf);
          this.loaded++;
          resolve(gltf);
        },
        undefined,
        () => {
          // Falha silenciosa de propósito: um asset ausente é um cenário
          // esperado, não um erro fatal. Quem chamou usa o fallback.
          this._gltf.set(path, null);
          this.failed++;
          this.missing.push(path);
          resolve(null);
        }
      );
    });

    this._pending.set(path, promise);
    return promise;
  }

  /**
   * Faz todos os modelos de uma pasta compartilharem uma textura só, e anota
   * qual textura cada modelo usa.
   */
  _shareTextures(scene, path) {
    const pasta = pastaDe(path);
    let compartilhada = this._textures.get(pasta) ?? null;
    let usada = null;

    scene.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (!material.map) continue;

        if (!compartilhada) {
          compartilhada = material.map;
          compartilhada.colorSpace = THREE.SRGBColorSpace;
          // O colormap do Kenney é minúsculo e de cores chapadas: filtro linear
          // borraria as faixas de cor vizinhas umas nas outras.
          compartilhada.magFilter = THREE.NearestFilter;
          this._textures.set(pasta, compartilhada);
        } else if (material.map !== compartilhada) {
          material.map.dispose();
          material.map = compartilhada;
        }
        usada = compartilhada;
      }
    });

    this._modelTexture.set(path, usada);
  }

  /**
   * Textura de um modelo já carregado, ou `null` se ele não usa nenhuma.
   *
   * Boa parte dos modelos (Nature Kit, Space Kit) não tem textura alguma — a
   * cor vem do material. Devolver `null` nesses casos é o comportamento certo:
   * o material do jogo fica só com a cor da paleta do planeta.
   *
   * @param {string} path
   * @returns {THREE.Texture|null}
   */
  textureFor(path) {
    return this._modelTexture.get(path) ?? null;
  }

  /**
   * Achata a cena do glTF numa única `BufferGeometry`, já normalizada.
   *
   * "Normalizada" aqui significa: centrada em X/Z, base em Y=0 e altura
   * exatamente 1. Duas razões:
   *
   *   - o espalhamento de props usa `position` como PONTO DE CONTATO com o
   *     solo (ver PropScatter); um modelo com pivô no centro nasceria metade
   *     enterrado;
   *   - com altura 1, o campo `escalas` de `shared/props.js` passa a significar
   *     literalmente "altura em unidades de mundo", em vez de um multiplicador
   *     opaco que depende de como o artista exportou.
   */
  _flatten(scene) {
    const parts = [];

    scene.updateMatrixWorld(true);
    scene.traverse((node) => {
      if (!node.isMesh || !node.geometry) return;

      const geometry = node.geometry.clone();
      geometry.applyMatrix4(node.matrixWorld);

      // `mergeGeometries` exige que TODAS as geometrias tenham exatamente o
      // mesmo conjunto de atributos. Modelos exportados de ferramentas
      // diferentes trazem extras (tangent, color, uv2) em alguns meshes e não
      // em outros, e aí o merge devolve null sem explicar por quê.
      for (const name of Object.keys(geometry.attributes)) {
        if (!ATTRIBUTES.includes(name)) geometry.deleteAttribute(name);
      }
      for (const name of ATTRIBUTES) {
        if (!geometry.attributes[name]) {
          const count = geometry.attributes.position?.count ?? 0;
          const size = name === 'uv' ? 2 : 3;
          geometry.setAttribute(name, new THREE.BufferAttribute(new Float32Array(count * size), size));
        }
      }
      geometry.morphAttributes = {};
      parts.push(geometry);
    });

    if (parts.length === 0) return null;

    const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (!merged) {
      for (const part of parts) part.dispose();
      return null;
    }
    if (parts.length > 1) for (const part of parts) part.dispose();

    merged.computeBoundingBox();
    _box.copy(merged.boundingBox);
    _box.getSize(_size);
    _box.getCenter(_center);

    merged.translate(-_center.x, -_box.min.y, -_center.z);
    const height = _size.y || 1;
    merged.scale(1 / height, 1 / height, 1 / height);

    merged.computeBoundingSphere();
    return merged;
  }

  /**
   * Geometria pronta para instanciar.
   * @param {string} path
   * @param {() => THREE.BufferGeometry} fallback usado se o modelo não existir
   */
  async getGeometry(path, fallback) {
    if (this.geometries.has(path)) {
      return this.geometries.get(path) ?? fallback();
    }

    const gltf = await this._load(path);
    const geometry = gltf ? this._flatten(gltf.scene) : null;
    this.geometries.set(path, geometry);
    return geometry ?? fallback();
  }

  /**
   * Cena animada, para clonar (fauna).
   *
   * Devolve o original — quem chama faz `.clone()`. Os Cube Pets não têm
   * skinning, só animação de nós, então o `clone()` comum do Object3D basta:
   * o `AnimationMixer` religa as faixas pelo NOME dos nós, que o clone preserva.
   * (Com skinning seria preciso `SkeletonUtils.clone`.)
   *
   * @param {string} path
   * @returns {Promise<{scene: THREE.Object3D, animations: THREE.AnimationClip[]}|null>}
   */
  async getAnimated(path) {
    if (this.scenes.has(path)) return this.scenes.get(path);

    const gltf = await this._load(path);
    const entry = gltf ? { scene: gltf.scene, animations: gltf.animations ?? [] } : null;
    this.scenes.set(path, entry);
    return entry;
  }

  /**
   * Carrega E achata uma lista de modelos.
   *
   * Chamado uma vez no boot. Depois disso `getGeometrySync` funciona, o que
   * permite que `PropScatter` continue com um construtor síncrono — se a
   * geometria só ficasse pronta via Promise, cada planeta teria que ser
   * construído em duas fases e trocar malhas no meio do voo.
   */
  async prepareGeometries(paths) {
    await Promise.all(paths.map((path) => this.getGeometry(path, () => null)));
  }

  /**
   * Geometria já preparada. Devolve o fallback se o modelo não existe, falhou
   * ao carregar ou ainda não passou por `prepareGeometries`.
   *
   * @param {string} path
   * @param {() => THREE.BufferGeometry} fallback
   */
  getGeometrySync(path, fallback) {
    return this.geometries.get(path) ?? fallback();
  }

  /**
   * Cena crua de um modelo já pré-carregado, ou `null`.
   *
   * Diferente de `getGeometrySync`, devolve a hierarquia COM materiais — para
   * objetos únicos como a nave, que não são instanciados e portanto não
   * precisam (nem devem) ser achatados numa geometria só.
   *
   * @param {string} path
   * @returns {THREE.Object3D|null}
   */
  getSceneSync(path) {
    return this._gltf.get(path)?.scene ?? null;
  }

  /** Pré-carrega uma lista de caminhos, para o boot poder esperar por todos. */
  async preload(paths) {
    await Promise.all(paths.map((path) => this._load(path)));
  }
}

/** Instância única — os assets são globais, não por planeta. */
export const assets = new AssetLibrary();
