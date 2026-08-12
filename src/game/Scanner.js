/**
 * Multiferramenta: pulso de varredura + feixe de mineração.
 *
 * São as duas ações que transformam "andar num terreno bonito" em jogo: o
 * pulso revela e cataloga o que existe ao redor, o feixe converte isso em
 * recurso. Ambas partem do mesmo lugar (a mão do jogador) e por isso vivem
 * na mesma classe.
 */

import * as THREE from 'three';
import { PROP_TYPE, PROP_YIELD, RESOURCES } from '../shared/props.js';

const PULSE_DURATION = 1.7;
const PULSE_RADIUS = 130;

/** Alcance e velocidade do feixe. */
const MINING_RANGE = 26;
/** Segundos para extrair um alvo (depósitos demoram mais). */
const MINING_TIME = { [PROP_TYPE.BUSH]: 0.55, [PROP_TYPE.TREE]: 1.1, [PROP_TYPE.ROCK]: 1.3, [PROP_TYPE.DEPOSIT]: 2.2 };

const _direction = new THREE.Vector3();
const _midpoint = new THREE.Vector3();
const _beamAxis = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

export class Scanner {
  /** @param {THREE.Scene} scene */
  constructor(scene) {
    this.scene = scene;

    // --- Visual do pulso ---------------------------------------------------
    // Esfera em wireframe que cresce e some. Aditiva e sem depth write para
    // atravessar o terreno como um pulso de energia, não como um objeto.
    this.pulse = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 3),
      new THREE.MeshBasicMaterial({
        color: 0x58e8ff,
        wireframe: true,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    this.pulse.visible = false;
    this.pulse.frustumCulled = false;
    scene.add(this.pulse);
    this.pulseTime = -1;

    // --- Visual do feixe ---------------------------------------------------
    const beamGeometry = new THREE.CylinderGeometry(0.045, 0.11, 1, 6, 1, true);
    beamGeometry.translate(0, 0.5, 0); // base na origem: facilita orientar
    this.beam = new THREE.Mesh(
      beamGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
      })
    );
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    /** Alvo atual e progresso da extração. */
    this.target = null;
    this.progress = 0;
  }

  /* ===================================================================== */
  /* Varredura                                                             */
  /* ===================================================================== */

  /**
   * Dispara o pulso: cataloga espécies ao redor e devolve o censo.
   *
   * @param {THREE.Vector3} origin
   * @param {import('../world/Planet.js').Planet} planet
   * @param {import('./Discovery.js').Discovery} discovery
   * @param {import('./Inventory.js').Inventory} inventory
   * @returns {{contagem:number[], novas:Array<object>, unidades:number}}
   */
  scan(origin, planet, discovery, inventory) {
    this.pulse.position.copy(origin);
    this.pulseTime = 0;
    this.pulse.visible = true;

    const contagem = planet.props.census(origin, PULSE_RADIUS);
    const novas = [];
    let unidades = 0;

    for (let type = 0; type < contagem.length; type++) {
      if (contagem[type] === 0) continue;
      const resultado = discovery.registerSpecies(planet, type);
      if (resultado.novo) {
        novas.push(resultado);
        unidades += resultado.unidades;
      }
    }

    inventory.units += unidades;
    return { contagem, novas, unidades };
  }

  updatePulse(dt) {
    if (this.pulseTime < 0) return;

    this.pulseTime += dt;
    const t = this.pulseTime / PULSE_DURATION;
    if (t >= 1) {
      this.pulseTime = -1;
      this.pulse.visible = false;
      return;
    }

    // Cresce rápido e desacelera; some no fim.
    const eased = 1 - Math.pow(1 - t, 2.2);
    this.pulse.scale.setScalar(eased * PULSE_RADIUS);
    this.pulse.material.opacity = (1 - t) * 0.5;
  }

  /* ===================================================================== */
  /* Mineração                                                             */
  /* ===================================================================== */

  /**
   * Encontra o prop sob a mira.
   *
   * Não usa raycast contra as instâncias: `InstancedMesh` suporta raycast, mas
   * testar milhares de instâncias por frame é caro e a precisão nem é
   * desejável aqui — mirar num arbusto de 60 cm a 20 m seria frustrante.
   * Em vez disso, projetamos um ponto à frente da mira e pegamos o prop mais
   * próximo dele, o que dá o "aim assist" que o gênero usa.
   *
   * @param {THREE.Vector3} origin
   * @param {THREE.Vector3} direction normalizada
   * @param {import('../world/Planet.js').Planet} planet
   */
  aim(origin, direction, planet) {
    let best = null;

    // Amostra alguns pontos ao longo da mira; o primeiro que encontrar algo
    // por perto vence (favorece o alvo mais próximo do jogador).
    for (let step = 0.25; step <= 1.0; step += 0.25) {
      _direction.copy(origin).addScaledVector(direction, MINING_RANGE * step);
      const found = planet.props.findNearest(_direction, 3.2 + step * 3.0);
      if (found) { best = found; break; }
    }

    if (!best || !this.target || best.key !== this.target.key || best.index !== this.target.index) {
      this.progress = 0;
    }
    this.target = best;
    return best;
  }

  /**
   * Extrai o alvo atual. Chame enquanto o botão estiver pressionado.
   *
   * @returns {{recurso:object, quantidade:number, nome:string}|null} colheita
   *   concluída neste frame, ou null
   */
  mine(dt, planet, inventory) {
    if (!this.target) return null;

    const duration = MINING_TIME[this.target.type] ?? 1;
    this.progress += dt / duration;
    if (this.progress < 1) return null;

    this.progress = 0;
    if (!planet.props.collect(this.target.key, this.target.index)) return null;

    const yieldSpec = PROP_YIELD[this.target.type];
    const resourceId = yieldSpec.recurso ?? RESOURCES[planet.config.depositResource].id;
    const [min, max] = yieldSpec.quantidade;
    const quantidade = Math.round(min + Math.random() * (max - min));

    const added = inventory.add(resourceId, quantidade);
    const resource = RESOURCES.find((r) => r.id === resourceId);

    this.target = null;
    return added > 0
      ? { recurso: resource, quantidade: added, nome: resource.nome }
      : { recurso: resource, quantidade: 0, nome: resource.nome, cheio: true };
  }

  /**
   * Posiciona o feixe entre a mão e o alvo.
   * @param {THREE.Vector3} from
   * @param {THREE.Vector3|null} to null desliga o feixe
   */
  updateBeam(from, to) {
    if (!to) {
      this.beam.visible = false;
      return;
    }

    _beamAxis.copy(to).sub(from);
    const length = _beamAxis.length();
    if (length < 1e-4) {
      this.beam.visible = false;
      return;
    }

    this.beam.visible = true;
    this.beam.position.copy(from);
    this.beam.scale.set(1, length, 1);
    _beamAxis.divideScalar(length);
    this.beam.quaternion.setFromUnitVectors(Y_AXIS, _beamAxis);

    // Pulsa enquanto extrai: dá retorno visual do progresso sem barra na tela.
    this.beam.material.opacity = 0.55 + Math.sin(performance.now() * 0.02) * 0.25;
  }

  /** Progresso da extração atual em [0,1] — usado pelo HUD. */
  get miningProgress() {
    return this.target ? this.progress : 0;
  }

  dispose() {
    this.pulse.geometry.dispose();
    this.pulse.material.dispose();
    this.beam.geometry.dispose();
    this.beam.material.dispose();
    this.pulse.removeFromParent();
    this.beam.removeFromParent();
  }
}
