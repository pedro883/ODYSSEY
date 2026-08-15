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

  // --- Água ----------------------------------------------------------------
  /**
   * Fração da gravidade cancelada com o corpo submerso.
   *
   * 1.06 — acima de 1 de propósito. Com exatamente 1 o corpo fica em equilíbrio
   * neutro e PARA onde estiver, inclusive a dez unidades de profundidade, o que
   * na prática é voar dentro da água. Com um empuxo um pouco maior que o peso,
   * soltar os controles faz subir devagar até a superfície e boiar ali.
   */
  empuxo: 1.06,
  /** Quanto a água tira da velocidade de nado (0 = nada, 1 = imóvel). */
  arrastoAgua: 0.45,
  /** Amortecimento da velocidade vertical na água — evita ficar quicando. */
  arrastoVertical: 2.6,
  /** Empurrão de nado para cima/baixo, por segundo. */
  impulsoNado: 26,
  /** Teto da velocidade vertical nadando. */
  velocidadeSubidaAgua: 6,
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
    /** 0 = seco, 1 = cabeça abaixo da linha d'água. */
    this.submerso = 0;
    /** Nadando de fato (não apenas com os pés molhados). */
    this.nadando = false;
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

    // -----------------------------------------------------------------------
    // ÁGUA
    //
    // `submersao` é o quanto da altura do corpo está abaixo da linha d'água,
    // em [0,1]. Não é um interruptor: entre andar na praia e nadar existe a
    // faixa em que a pessoa está com água pela cintura, e tratar isso como
    // liga/desliga produz o pulo característico de jogo mal-acabado — o
    // personagem alterna entre correndo e boiando a cada onda.
    //
    // O nível do mar é o RAIO do planeta: a elevação do terreno é medida a
    // partir dele (negativa = fundo submerso), então a superfície da água é a
    // esfera de raio `config.radius`. É a mesma referência que o oceano usa.
    // -----------------------------------------------------------------------
    // -----------------------------------------------------------------------
    // "ABAIXO DO NÍVEL DO MAR" NÃO É "DENTRO D'ÁGUA".
    //
    // A regra era só `hasWater`, com a profundidade medida contra o raio do
    // planeta. Numa caverna cujo piso fica abaixo do nível do mar isso ligava o
    // empuxo em terra seca, e o jogador SUBIA sozinho depois de pousar — a
    // queda na caverna funcionava e a permanência não.
    //
    // Tentei antes resolver com uma marcha para cima procurando rocha, e estava
    // errado por outro motivo: numa boca de caverna o poço é aberto até o topo,
    // logo não há rocha acima e o teste dizia "água". Mas a boca abre a +31 do
    // nível do mar — água nenhuma entraria ali.
    //
    // A pergunta certa é sobre o TERRENO, não sobre o corpo: só há coluna
    // d'água onde o chão daquele lugar está abaixo do nível do mar. É mais
    // simples que a marcha, mais correto, e de graça.
    // -----------------------------------------------------------------------
    const naAgua = planet.config.hasWater && sample.elevation < 0;
    const profundidade = naAgua ? planet.config.radius - sample.distance : -1;
    const submersao = naAgua
      ? Math.min(1, Math.max(0, (profundidade + SETTINGS.eyeHeight * 0.35) / SETTINGS.eyeHeight))
      : 0;
    this.submerso = submersao;
    this.nadando = submersao > 0.55;

    const damping = this.grounded ? SETTINGS.groundDamping : SETTINGS.airDamping;
    const rate = moving ? SETTINGS.acceleration : damping;
    // A água freia o movimento e limita a velocidade: nadar é mais lento que
    // correr, e o arrasto é o que dá peso à massa de água em volta.
    _wish.multiplyScalar(1 - submersao * SETTINGS.arrastoAgua);
    _tangential.lerp(_wish, 1 - Math.exp(-(rate * (1 - submersao * 0.55)) * dt));

    // --- Movimento radial: gravidade, empuxo, pulo e jetpack ----------------
    // O empuxo cancela a gravidade quando submerso e sobra um pouco: parado, o
    // corpo sobe devagar até a linha da água e fica boiando ali, que é o
    // comportamento que se espera ao soltar os controles dentro do mar.
    const gravidadeEfetiva = SETTINGS.gravity * (1 - submersao * SETTINGS.empuxo);
    radialSpeed -= gravidadeEfetiva * dt;
    if (submersao > 0) {
      // Arrasto vertical: sem ele o corpo oscilaria para sempre em torno da
      // linha d'água, porque empuxo e gravidade formam um oscilador sem perda.
      radialSpeed *= Math.exp(-SETTINGS.arrastoVertical * submersao * dt);
    }

    const wantsUp = k.has('Space');
    this.jetpackActive = false;

    if (wantsUp && this.nadando) {
      // Nadar para cima: subida constante, sem gastar o jetpack. Chegando à
      // superfície o empuxo já segura; isto é para vencer a coluna de água.
      radialSpeed = Math.min(SETTINGS.velocidadeSubidaAgua, radialSpeed + SETTINGS.impulsoNado * dt);
    } else if (wantsUp && this.grounded) {
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

    // Mergulhar: agachar dentro d'água empurra para baixo.
    if (this.nadando && (k.has('ControlLeft') || k.has('KeyC'))) {
      radialSpeed = Math.max(-SETTINGS.velocidadeSubidaAgua, radialSpeed - SETTINGS.impulsoNado * dt);
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
    // -----------------------------------------------------------------------
    // A COLISÃO RESOLVE CONTRA O CHÃO SÓLIDO, NÃO CONTRA A SUPERFÍCIE DE APOIO.
    //
    // Sobre o mar as duas divergem: `surfaceRadius` é o NÍVEL DO MAR (é o que
    // faz a nave pousar na água) e `groundRadius` é o FUNDO. Resolvendo contra
    // a primeira, o corpo era reassentado na linha d'água todo quadro e o
    // resultado era andar sobre o oceano — com toda a natação já escrita logo
    // acima, e inalcançável, porque nada conseguia afundar um centímetro.
    //
    // Contra o fundo, quem entra no mar afunda até o empuxo segurá-lo, que é o
    // que as linhas de `submersao` sempre esperaram encontrar.
    // -----------------------------------------------------------------------
    const after = planet.sampleAt(this.position);
    if (after.distance < after.groundRadius) {
      this.up.copy(after.direction);
      this.position.copy(planet.group.position).addScaledVector(this.up, after.groundRadius);
      const into = this.velocity.dot(this.up);
      if (into < 0) this.velocity.addScaledVector(this.up, -into);
      this.grounded = true;
    } else if (after.distance - after.groundRadius > 0.35) {
      // Também aqui a referência é o CHÃO. Com `altitude` (medida do nível do
      // mar) todo nadador ficava permanentemente `grounded`, porque debaixo
      // d'água ela é negativa — e "no chão" dá pulo e recarrega o jetpack.
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
