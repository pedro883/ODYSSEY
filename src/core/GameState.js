/**
 * A transição seamless espaço -> atmosfera -> superfície.
 *
 * Este arquivo é o "diretor de fotografia" do jogo: ele não move nada, só lê a
 * altitude da nave e interpola TODOS os parâmetros de ambiente em função dela.
 * Como cada parâmetro é uma função contínua da altitude, não existe momento de
 * troca — não há tela de carregamento nem corte, que é exatamente o efeito
 * procurado.
 *
 * O que é interpolado:
 *   - densidade e cor da névoa (perspectiva aérea)
 *   - intensidade e cor da luz ambiente (do preto do vácuo ao céu difuso)
 *   - opacidade do campo de estrelas (o dia apaga as estrelas)
 *   - exposição do tonemapper (o espaço é escuro; a superfície é clara)
 *   - o modelo de voo (feito no ShipController, com o mesmo fator)
 */

import * as THREE from 'three';

export const Phase = {
  SPACE: 'ESPAÇO',
  ATMOSPHERE: 'ATMOSFERA',
  SURFACE: 'SUPERFÍCIE',
  LANDED: 'POUSADO',
};

const _up = new THREE.Vector3();
const _skyColor = new THREE.Color();
const _groundColor = new THREE.Color();
const _nightColor = new THREE.Color(0x02040a);

export class GameState {
  /**
   * @param {import('./Engine.js').Engine} engine
   * @param {ReturnType<typeof import('../world/StarField.js').createStarSystem>} starSystem
   */
  constructor(engine, starSystem) {
    this.engine = engine;
    this.starSystem = starSystem;

    this.phase = Phase.SPACE;
    this.atmosphere = 0;
    this.altitude = Infinity;
    this.dayFactor = 1;
    /**
     * Direção unitária do centro do planeta até a nave — o "para cima" local.
     * Fica exposto para que o resto do frame (lat/lon do HUD, por exemplo)
     * reaproveite em vez de chamar `sampleAt()` de novo: cada chamada custa
     * uma avaliação completa de fBm.
     */
    this.up = new THREE.Vector3(0, 1, 0);

    // Névoa exponencial ao quadrado: a queda com a distância é mais suave que
    // a linear e é o que melhor imita perspectiva aérea real.
    this.fog = new THREE.FogExp2(0x000000, 0);
    engine.scene.fog = this.fog;

    // Uma hemisférica basta: a direcional do sol já faz o trabalho pesado, e
    // esta preenche as sombras com a cor do céu (o "bounce" do ambiente).
    this.ambientLight = new THREE.HemisphereLight(0x88bbff, 0x443322, 0.05);
    engine.scene.add(this.ambientLight);

    /** @type {(phase: string, previous: string) => void} */
    this.onPhaseChange = null;
  }

  /**
   * @param {import('../world/Planet.js').Planet} planet
   * @param {THREE.Vector3} position posição da nave
   * @param {boolean} landed
   */
  update(planet, position, landed) {
    const sample = planet.sampleAt(position);
    this.altitude = sample.altitude;
    _up.copy(sample.direction);
    this.up.copy(sample.direction);

    // Fator de atmosfera: 0 no vácuo, 1 ao nível do solo. A curva quadrática
    // concentra a mudança visual no fim da descida — subindo, o céu abre de
    // uma vez perto do topo, que é o comportamento real.
    const raw = 1 - sample.altitude / planet.config.atmosphere.height;
    const t = THREE.MathUtils.clamp(raw, 0, 1);
    this.atmosphere = t * t;

    // Sol a pino = 1; sol abaixo do horizonte = 0. Governa dia/noite.
    const sunElevation = _up.dot(this.starSystem.sunDirection);
    this.dayFactor = THREE.MathUtils.clamp(sunElevation * 1.6 + 0.22, 0, 1);

    this._updateAtmosphereVisuals(planet);
    this._updatePhase(landed, planet);
  }

  _updateAtmosphereVisuals(planet) {
    const atmo = this.atmosphere;
    const day = this.dayFactor;

    _skyColor.fromArray(planet.config.atmosphere.tint);

    // --- Névoa --------------------------------------------------------------
    // Cor: céu do planeta de dia, quase preto à noite.
    this.fog.color.copy(_nightColor).lerp(_skyColor, day * 0.9);
    // Névoa diurna precisa ser CLARA. A cor de espalhamento crua é escura
    // demais e o horizonte fica com aspecto de fumaça em vez de distância.
    this.fog.color.multiplyScalar(0.35 + day * 1.5);

    // Densidade: 0 no vácuo. O expoente cúbico mantém o espaço absolutamente
    // limpo e só "fecha" o horizonte nos últimos milhares de unidades.
    this.fog.density = Math.pow(atmo, 3) * 0.00055 * planet.config.atmosphere.density;

    // --- Luz ambiente -------------------------------------------------------
    _groundColor.fromArray(planet.config.palette.dry);
    this.ambientLight.color.copy(_skyColor).multiplyScalar(0.6 + day * 0.4);
    this.ambientLight.groundColor.copy(_groundColor);
    this.ambientLight.intensity = 0.04 + atmo * day * 0.9;

    // --- Exposição ----------------------------------------------------------
    // O vácuo tem contraste altíssimo (fonte pontual, sem espalhamento); a
    // superfície diurna tem luz difusa em toda parte. Subir a exposição ao
    // descer evita que o planeta pareça um objeto escuro dentro de um céu claro.
    this.engine.renderer.toneMappingExposure = THREE.MathUtils.lerp(0.95, 1.25, atmo * day);
  }

  _updatePhase(landed, planet) {
    const h = planet.config.atmosphere.height;
    let next;

    if (landed) next = Phase.LANDED;
    else if (this.altitude > h) next = Phase.SPACE;
    else if (this.altitude > h * 0.12) next = Phase.ATMOSPHERE;
    else next = Phase.SURFACE;

    if (next !== this.phase) {
      const previous = this.phase;
      this.phase = next;
      this.onPhaseChange?.(next, previous);
    }
  }

  dispose() {
    this.ambientLight.removeFromParent();
    this.engine.scene.fog = null;
  }
}
