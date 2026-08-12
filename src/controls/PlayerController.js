/**
 * Exploração a pé, em primeira pessoa, sobre a superfície de uma esfera.
 *
 * O PROBLEMA CENTRAL de andar num planeta (e não num mapa plano) é que "para
 * cima" muda a cada passo. Um controlador FPS comum guarda yaw e pitch em
 * relação a eixos globais e quebra assim que você caminha 90° ao redor do
 * mundo — de repente você está andando de lado.
 *
 * A solução aqui: em vez de ângulos globais, guardamos um VETOR `forward` no
 * espaço do mundo e o reprojetamos no plano tangente a cada frame. O yaw do
 * mouse gira esse vetor em torno do "para cima" LOCAL; o pitch é aplicado só
 * na hora de montar a câmera, nunca acumulado no estado. Assim o referencial
 * acompanha a curvatura sem nenhum caso especial nos polos.
 */

import * as THREE from 'three';

const _right = new THREE.Vector3();
const _wish = new THREE.Vector3();
const _tangential = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _lookTarget = new THREE.Vector3();

const SETTINGS = {
  walkSpeed: 9,
  sprintSpeed: 18,
  acceleration: 12,
  /** Atrito ao soltar as teclas — alto o bastante para não patinar no gelo. */
  groundDamping: 9,
  airDamping: 1.2,

  gravity: 22,
  jumpImpulse: 9,

  /** Empuxo do jetpack enquanto houver combustível. */
  jetpackForce: 34,
  jetpackFuel: 2.6,
  jetpackRefill: 1.1,
  /** Velocidade radial máxima subindo com o jetpack (evita virar foguete). */
  jetpackMaxClimb: 16,

  eyeHeight: 1.7,
  mouseSensitivity: 0.0022,
  maxPitch: 1.48, // ~85°
};

export class PlayerController {
  /**
   * @param {HTMLElement} domElement
   */
  constructor(domElement) {
    this.domElement = domElement;
    this.enabled = false;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1);
    /**
     * "Para cima" local (radial). Mantido no objeto, não num temporário de
     * módulo: a câmera e o HUD precisam dele DEPOIS do `update()`, e um temp
     * compartilhado já teria sido sobrescrito por outra chamada qualquer.
     */
    this.up = new THREE.Vector3(0, 1, 0);
    this.pitch = 0;

    this.grounded = false;
    this.jetpackFuel = SETTINGS.jetpackFuel;
    this.jetpackActive = false;

    this.keys = new Set();
    this._pointerLocked = false;
    this._bind();
  }

  get speed() {
    return this.velocity.length();
  }

  get fuelRatio() {
    return this.jetpackFuel / SETTINGS.jetpackFuel;
  }

  _bind() {
    this._onKeyDown = (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      this.keys.add(event.code);
      if (this.enabled && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'].includes(event.code)) {
        event.preventDefault();
      }
    };
    this._onKeyUp = (event) => this.keys.delete(event.code);
    this._onMouseMove = (event) => {
      if (!this.enabled || !this._pointerLocked) return;
      this._yawDelta -= event.movementX * SETTINGS.mouseSensitivity;
      this.pitch = THREE.MathUtils.clamp(
        this.pitch - event.movementY * SETTINGS.mouseSensitivity,
        -SETTINGS.maxPitch,
        SETTINGS.maxPitch
      );
    };
    this._onPointerLockChange = () => {
      this._pointerLocked = document.pointerLockElement === this.domElement;
      if (!this._pointerLocked) this.keys.clear();
    };

    this._yawDelta = 0;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  /**
   * Coloca o jogador na superfície, ao lado de um ponto de referência.
   * @param {THREE.Vector3} worldPosition
   * @param {import('../world/Planet.js').Planet} planet
   * @param {THREE.Vector3} [facing] direção inicial do olhar
   */
  spawnAt(worldPosition, planet, facing) {
    const sample = planet.sampleAt(worldPosition);
    const _up = this.up.copy(sample.direction);
    this.position.copy(planet.group.position).addScaledVector(_up, sample.surfaceRadius + 0.05);
    this.velocity.set(0, 0, 0);
    this.pitch = 0;
    this.jetpackFuel = SETTINGS.jetpackFuel;

    if (facing) this.forward.copy(facing);
    // Reprojeta no plano tangente; se o olhar apontava direto para cima/baixo,
    // escolhe qualquer direção horizontal válida.
    this.forward.addScaledVector(_up, -this.forward.dot(_up));
    if (this.forward.lengthSq() < 1e-6) {
      this.forward.set(_up.y, -_up.x, 0);
      if (this.forward.lengthSq() < 1e-6) this.forward.set(1, 0, 0);
    }
    this.forward.normalize();
  }

  /**
   * @param {number} dt
   * @param {import('../world/Planet.js').Planet} planet
   */
  update(dt, planet) {
    if (!this.enabled) return;

    const sample = planet.sampleAt(this.position);
    const _up = this.up.copy(sample.direction);

    // --- Referencial local -------------------------------------------------
    // Reprojetar todo frame é o que faz andar ao redor do planeta funcionar:
    // o `forward` "escorrega" continuamente sobre a esfera em vez de precisar
    // de um caso especial quando cruzamos um polo.
    this.forward.addScaledVector(_up, -this.forward.dot(_up));
    if (this.forward.lengthSq() < 1e-8) this.forward.set(_up.z, _up.x, _up.y);
    this.forward.normalize();

    if (this._yawDelta !== 0) {
      this.forward.applyAxisAngle(_up, this._yawDelta).normalize();
      this._yawDelta = 0;
    }

    _right.crossVectors(this.forward, _up).normalize();

    // --- Movimento tangencial ----------------------------------------------
    const k = this.keys;
    let ax = 0;
    let az = 0;
    if (k.has('KeyW')) az += 1;
    if (k.has('KeyS')) az -= 1;
    if (k.has('KeyD')) ax += 1;
    if (k.has('KeyA')) ax -= 1;

    const sprinting = k.has('ShiftLeft') || k.has('ShiftRight');
    const targetSpeed = sprinting ? SETTINGS.sprintSpeed : SETTINGS.walkSpeed;

    _wish.copy(this.forward).multiplyScalar(az).addScaledVector(_right, ax);
    const moving = _wish.lengthSq() > 1e-6;
    if (moving) _wish.normalize().multiplyScalar(targetSpeed);

    // Separa a velocidade em tangencial e radial: só a tangencial responde ao
    // input, só a radial responde à gravidade. Misturar as duas faz o jogador
    // "deslizar" para cima ao andar em encostas.
    let radialSpeed = this.velocity.dot(_up);
    _tangential.copy(this.velocity).addScaledVector(_up, -radialSpeed);

    const damping = this.grounded ? SETTINGS.groundDamping : SETTINGS.airDamping;
    const rate = moving ? SETTINGS.acceleration : damping;
    _tangential.lerp(_wish, 1 - Math.exp(-rate * dt));

    // --- Movimento radial: gravidade, pulo e jetpack -----------------------
    radialSpeed -= SETTINGS.gravity * dt;

    const wantsUp = k.has('Space');
    this.jetpackActive = false;

    if (wantsUp && this.grounded) {
      radialSpeed = SETTINGS.jumpImpulse;
      this.grounded = false;
    } else if (wantsUp && this.jetpackFuel > 0) {
      this.jetpackActive = true;
      this.jetpackFuel = Math.max(0, this.jetpackFuel - dt);
      radialSpeed = Math.min(
        SETTINGS.jetpackMaxClimb,
        radialSpeed + SETTINGS.jetpackForce * dt
      );
    }

    if (this.grounded && !this.jetpackActive) {
      this.jetpackFuel = Math.min(
        SETTINGS.jetpackFuel,
        this.jetpackFuel + SETTINGS.jetpackRefill * dt
      );
    }

    this.velocity.copy(_tangential).addScaledVector(_up, radialSpeed);
    this.position.addScaledVector(this.velocity, dt);

    // --- Colisão com o solo -------------------------------------------------
    const after = planet.sampleAt(this.position);
    if (after.distance < after.surfaceRadius) {
      this.up.copy(after.direction);
      this.position.copy(planet.group.position).addScaledVector(this.up, after.surfaceRadius);
      const into = this.velocity.dot(this.up);
      if (into < 0) this.velocity.addScaledVector(this.up, -into);
      this.grounded = true;
    } else if (after.altitude > 0.35) {
      this.grounded = false;
    }
  }

  /** Direção do olhar em espaço de mundo (forward + pitch). */
  getLookDirection(target) {
    _right.crossVectors(this.forward, this.up).normalize();
    return target.copy(this.forward).applyAxisAngle(_right, this.pitch).normalize();
  }

  /** Posição do olho (câmera), acima dos pés. */
  getEyePosition(target) {
    return target.copy(this.position).addScaledVector(this.up, SETTINGS.eyeHeight);
  }

  /** @param {THREE.PerspectiveCamera} camera */
  updateCamera(camera) {
    this.getEyePosition(camera.position);
    camera.up.copy(this.up);
    this.getLookDirection(_lookDir);
    _lookTarget.copy(camera.position).add(_lookDir);
    camera.lookAt(_lookTarget);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }
}
