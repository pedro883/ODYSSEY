/**
 * Entrada + física de voo + câmera de perseguição.
 *
 * MODELO DE VOO
 * Não é newtoniano puro. Voo orbital realista é péssimo de pilotar: sem
 * atrito, qualquer manobra vira uma órbita e o jogador passa o tempo lutando
 * contra a inércia. Usamos o modelo "arcade" do gênero:
 *
 *   1. a velocidade converge exponencialmente para `frente * velocidadeAlvo`
 *      (isso embute empuxo E arrasto num parâmetro só, a responsividade);
 *   2. a gravidade é somada por fora, então você AINDA cai se soltar o motor;
 *   3. a mesma convergência que simula arrasto cria a velocidade terminal.
 *
 * Perto do planeta a responsividade sobe (o ar "agarra") e a velocidade máxima
 * cai — o que faz a entrada na atmosfera ser sentida no controle, não só vista.
 */

import * as THREE from 'three';

const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();
const _desiredVelocity = new THREE.Vector3();
const _gravity = new THREE.Vector3();
const _euler = new THREE.Euler();
const _deltaQuat = new THREE.Quaternion();
const _targetQuat = new THREE.Quaternion();
const _lookMatrix = new THREE.Matrix4();
const _lookTarget = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _cameraGoal = new THREE.Vector3();
const _cameraLook = new THREE.Vector3();
const _offset = new THREE.Vector3();

const SETTINGS = {
  maxSpeedSpace: 900,
  maxSpeedBoost: 3200,
  maxSpeedAtmosphere: 260,

  /**
   * Pulse drive: velocidade de cruzeiro interplanetária.
   *
   * Os planetas do sistema estão a dezenas de milhares de unidades. A 3200 u/s
   * do booster, o vizinho mais próximo levaria minutos de linha reta — tempo
   * morto, não exploração. O pulse resolve isso e se desliga sozinho ao
   * chegar, que é justamente o que o torna uma mecânica e não um teleporte.
   */
  pulseSpeed: 26000,
  /** Aceleração até a velocidade de pulso (segundos para engatar). */
  pulseSpoolTime: 1.4,
  /**
   * Altitude de corte, em MÚLTIPLOS da espessura da atmosfera local.
   *
   * Um valor absoluto não funciona: numa lua com atmosfera de 90 unidades ele
   * seria alto demais (nunca dá para engatar) e num gigante gasoso, baixo
   * demais. Relativo à atmosfera, a regra é sempre "logo depois de sair dela".
   */
  pulseCutoffAtmospheres: 1.6,
  pulseCutoffFloor: 260,
  /**
   * Velocidade máxima de pulse por unidade de altitude. Ver a explicação da
   * trava anti-tunelamento em `_integrate()`.
   */
  pulseApproach: 5,

  pitchRate: 1.25,
  yawRate: 0.95,
  rollRate: 2.1,
  angularDamping: 6.0,

  mouseSensitivity: 0.0022,
  stickAutoCenter: 2.4,

  gravity: 26,
  /** Folga mínima entre a nave e o terreno (raio de colisão grosseiro). */
  groundClearance: 2.2,
  groundFriction: 0.82,

  cameraOffset: new THREE.Vector3(0, 2.4, 10.5),
  cameraLookAhead: new THREE.Vector3(0, 0.9, -8),
  cameraStiffness: 7.5,
  cockpitOffset: new THREE.Vector3(0, 0.42, -0.5),
};

export class ShipController {
  /**
   * @param {THREE.Object3D} shipObject
   * @param {HTMLElement} domElement elemento que recebe o pointer lock
   */
  constructor(shipObject, domElement) {
    this.object = shipObject;
    this.domElement = domElement;

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3(); // x=pitch, y=yaw, z=roll (local)
    this.throttle = 0.25;
    this.boost = false;
    this.braking = false;
    this.landed = false;
    this.autopilot = false;
    this.cockpitView = false;

    /** Pulse drive engatado? */
    this.pulse = false;
    /** Rampa de 0 a 1 enquanto o pulse acelera — evita o salto instantâneo. */
    this.pulseSpool = 0;
    /** Motivo do último desligamento automático, para o HUD avisar. */
    this.pulseBlocked = '';

    /** "Manche virtual" alimentado pelo mouse; se auto-centra sozinho. */
    this.stick = new THREE.Vector2();

    this.keys = new Set();
    this._pointerLocked = false;

    this._bind();
  }

  get speed() {
    return this.velocity.length();
  }

  get position() {
    return this.object.position;
  }

  /**
   * Vetor "para frente" da nave em espaço de mundo.
   *
   * Cuidado clássico do Three.js: `Object3D.getWorldDirection()` devolve o
   * eixo +Z, mas câmeras (e o modelo desta nave) olham para -Z. Usar aquele
   * método aqui faria a nave voar de ré. Calculamos explicitamente.
   *
   * @param {THREE.Vector3} target
   */
  _getForward(target) {
    return target.set(0, 0, -1).applyQuaternion(this.object.quaternion);
  }

  /* ===================================================================== */
  /* Entrada                                                                */
  /* ===================================================================== */

  _bind() {
    this._onKeyDown = (event) => {
      // Não sequestra atalhos do browser (F5, F12, Ctrl+R...).
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      this.keys.add(event.code);

      if (event.code === 'KeyC') this.cockpitView = !this.cockpitView;
      if (event.code === 'KeyG') this.autopilot = !this.autopilot;
      if (event.code === 'KeyX') this.pulse = !this.pulse;
      if (['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space'].includes(event.code)) {
        event.preventDefault();
      }
    };

    this._onKeyUp = (event) => this.keys.delete(event.code);

    this._onMouseMove = (event) => {
      if (!this._pointerLocked) return;
      this.stick.x += event.movementX * SETTINGS.mouseSensitivity;
      this.stick.y += event.movementY * SETTINGS.mouseSensitivity;
      this.stick.clampLength(0, 1);
      // Qualquer input manual assume o controle de volta do piloto automático.
      if (this.stick.lengthSq() > 0.02) this.autopilot = false;
    };

    this._onPointerLockChange = () => {
      this._pointerLocked = document.pointerLockElement === this.domElement;
      if (!this._pointerLocked) this.keys.clear();
    };

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
  }

  requestPointerLock() {
    // Pode rejeitar por motivos fora do nosso controle (documento aninhado,
    // gesto do usuário expirado, política do navegador). Engolimos a rejeição
    // porque o jogo continua jogável no teclado — só o mouse fica de fora.
    this.domElement.requestPointerLock?.()?.catch?.(() => {});
  }

  /* ===================================================================== */
  /* Simulação                                                              */
  /* ===================================================================== */

  /**
   * @param {number} dt segundos
   * @param {import('../world/Planet.js').Planet} planet
   * @param {number} atmosphere 0 = vácuo, 1 = ao nível do solo
   */
  update(dt, planet, atmosphere) {
    this._updatePulse(dt, planet, atmosphere);
    this._updateThrottle(dt);

    if (this.autopilot) {
      this._steerAutopilot(dt, planet);
    } else {
      this._steerManual(dt, atmosphere);
    }

    this._integrate(dt, planet, atmosphere);
  }

  /**
   * Engate e desengate automático do pulse drive.
   *
   * A regra de corte é o que impede o pulse de virar um teleporte: perto de um
   * planeta ele desliga sozinho, então a chegada sempre termina em voo normal.
   */
  _updatePulse(dt, planet, atmosphere) {
    if (!this.pulse) {
      this.pulseSpool = Math.max(0, this.pulseSpool - dt / SETTINGS.pulseSpoolTime);
      return;
    }

    const sample = planet.sampleAt(this.object.position);
    const cutoff = Math.max(
      SETTINGS.pulseCutoffFloor,
      planet.config.atmosphere.height * SETTINGS.pulseCutoffAtmospheres
    );
    if (sample.altitude < cutoff || atmosphere > 0.01) {
      this.pulse = false;
      this.pulseBlocked = 'MASSA PLANETÁRIA';
      this.pulseSpool = 0;
      return;
    }

    this.pulseBlocked = '';
    this.pulseSpool = Math.min(1, this.pulseSpool + dt / SETTINGS.pulseSpoolTime);
  }

  _updateThrottle(dt) {
    const k = this.keys;
    if (k.has('KeyW')) this.throttle += dt * 0.75;
    if (k.has('KeyS')) this.throttle -= dt * 0.75;
    this.throttle = THREE.MathUtils.clamp(this.throttle, 0, 1);

    this.boost = k.has('ShiftLeft') || k.has('ShiftRight');
    this.braking = k.has('Space');
    if (this.autopilot) this.throttle = 0.8;
    // O pulse é um regime de cruzeiro, não um acelerador: assume a potência.
    if (this.pulse) this.throttle = 1;
  }

  _steerManual(dt, atmosphere) {
    const k = this.keys;

    // Manche auto-centrante: o mouse acumula deslocamento e ele decai sozinho.
    // Isso dá o "peso" de um manche em vez da resposta seca de um mouse look.
    this.stick.multiplyScalar(Math.exp(-SETTINGS.stickAutoCenter * dt));

    let pitch = -this.stick.y;
    let yaw = -this.stick.x;
    let roll = 0;

    if (k.has('ArrowUp')) pitch += 1;
    if (k.has('ArrowDown')) pitch -= 1;
    if (k.has('ArrowLeft')) yaw += 1;
    if (k.has('ArrowRight')) yaw -= 1;
    if (k.has('KeyA')) roll += 1;
    if (k.has('KeyD')) roll -= 1;

    // Superfícies de controle perdem autoridade no vácuo? Ao contrário: aqui
    // damos MAIS autoridade no ar, porque é onde o jogador precisa de precisão
    // para pousar. Fora da atmosfera a nave é mais "pesada" e cinematográfica.
    const authority = 0.75 + atmosphere * 0.45;

    this.angularVelocity.x = THREE.MathUtils.damp(
      this.angularVelocity.x, pitch * SETTINGS.pitchRate * authority, SETTINGS.angularDamping, dt
    );
    this.angularVelocity.y = THREE.MathUtils.damp(
      this.angularVelocity.y, yaw * SETTINGS.yawRate * authority, SETTINGS.angularDamping, dt
    );
    this.angularVelocity.z = THREE.MathUtils.damp(
      this.angularVelocity.z, roll * SETTINGS.rollRate, SETTINGS.angularDamping, dt
    );

    _euler.set(
      this.angularVelocity.x * dt,
      this.angularVelocity.y * dt,
      this.angularVelocity.z * dt,
      'XYZ'
    );
    _deltaQuat.setFromEuler(_euler);
    // Multiplicação à DIREITA = rotação em espaço LOCAL. À esquerda seria em
    // espaço de mundo e a nave giraria em relação aos eixos globais (errado
    // para voo 6DOF: você perderia a noção de "para cima" da própria nave).
    this.object.quaternion.multiply(_deltaQuat).normalize();
  }

  /**
   * Piloto automático de demonstração: mergulha no planeta e nivela ao chegar
   * na atmosfera baixa. Existe para mostrar a transição sem exigir perícia.
   */
  _steerAutopilot(dt, planet) {
    const sample = planet.sampleAt(this.object.position);
    _up.copy(sample.direction);

    // Longe: aponta para o centro do planeta (mergulho).
    _desiredDir.copy(_up).negate();

    // Perto: mistura com a tangente ao horizonte (arredonda o mergulho).
    const flare = THREE.MathUtils.clamp(
      1 - sample.altitude / (planet.config.atmosphere.height * 0.9), 0, 1
    );
    this._getForward(_forward);
    _tangent.copy(_forward).addScaledVector(_up, -_forward.dot(_up));
    if (_tangent.lengthSq() > 1e-6) {
      _tangent.normalize();
      _desiredDir.lerp(_tangent, flare).normalize();
    }

    _lookTarget.copy(this.object.position).add(_desiredDir);
    _lookMatrix.lookAt(this.object.position, _lookTarget, _up);
    _targetQuat.setFromRotationMatrix(_lookMatrix);
    this.object.quaternion.slerp(_targetQuat, 1 - Math.exp(-1.8 * dt));

    this.angularVelocity.set(0, 0, 0);

    // Desliga sozinho ao chegar na superfície.
    if (sample.altitude < SETTINGS.groundClearance * 8) this.autopilot = false;
  }

  _integrate(dt, planet, atmosphere) {
    this._getForward(_forward);

    // Amostrar ANTES de decidir a velocidade: o limite de aproximação abaixo
    // depende da altitude atual.
    const sample = planet.sampleAt(this.object.position);
    _up.copy(sample.direction);

    let maxSpeed = THREE.MathUtils.lerp(
      this.boost ? SETTINGS.maxSpeedBoost : SETTINGS.maxSpeedSpace,
      SETTINGS.maxSpeedAtmosphere * (this.boost ? 2.2 : 1),
      atmosphere
    );

    // A rampa do pulse interpola a partir da velocidade normal, então engatar
    // e desengatar são transições e não teletransportes.
    if (this.pulseSpool > 0) {
      const pulseSpeed = Math.min(
        SETTINGS.pulseSpeed,
        // TRAVA ANTI-TUNELAMENTO. A 26 000 u/s a nave avança ~430 unidades por
        // frame — mais que a espessura inteira da zona de corte, então ela
        // atravessaria o planeta entre dois frames sem nunca "ver" a
        // superfície. Limitando a velocidade a um múltiplo da altitude, o
        // deslocamento por frame nunca chega perto do solo, e a aproximação
        // vira uma desaceleração suave em vez de uma checagem que falha.
        Math.max(SETTINGS.maxSpeedSpace, sample.altitude * SETTINGS.pulseApproach)
      );
      maxSpeed = THREE.MathUtils.lerp(maxSpeed, pulseSpeed, this.pulseSpool);
    }

    const targetSpeed = this.braking ? 0 : this.throttle * maxSpeed;
    _desiredVelocity.copy(_forward).multiplyScalar(targetSpeed);

    // Responsividade = empuxo + arrasto num único termo. No ar é maior:
    // a nave freia mais rápido e responde mais rápido.
    let responsiveness = THREE.MathUtils.lerp(0.9, 2.6, atmosphere);
    if (this.braking) responsiveness *= 3.5;
    // No pulse a resposta é mais firme, senão a nave "escorrega" por inércia
    // muito depois de o motor ter reduzido.
    if (this.pulseSpool > 0) responsiveness = Math.max(responsiveness, 3.5);

    this.velocity.lerp(_desiredVelocity, 1 - Math.exp(-responsiveness * dt));

    // --- Gravidade ---------------------------------------------------------
    // Só puxa perto do planeta. Gravidade newtoniana de verdade transformaria
    // qualquer voo em mecânica orbital — divertido em outro jogo, não neste.
    const gravityRange = planet.config.atmosphere.height * 2.5;
    const gravityFactor = THREE.MathUtils.clamp(1 - sample.altitude / gravityRange, 0, 1);
    _gravity.copy(_up).multiplyScalar(-SETTINGS.gravity * gravityFactor);
    this.velocity.addScaledVector(_gravity, dt);

    // -----------------------------------------------------------------------
    // TRAVA DE APROXIMAÇÃO — o passo do frame nunca passa de metade da altitude.
    //
    // A trava do pulse (acima) limita a velocidade ALVO. Não basta: a
    // velocidade REAL converge para o alvo com constante de tempo ~0,3 s, e a
    // 20 000 u/s isso são ~5 800 unidades de frenagem — mais que o raio de um
    // planeta inteiro. A nave chegava do outro lado antes de o motor obedecer.
    //
    // Pior: `dt` é limitado a 0,1 s (um engasgo de GC, um stall de driver), e
    // um único frame desses a 26 000 u/s são 2 600 unidades num salto só. Como
    // a colisão testa um PONTO, e não o trajeto, o planeta simplesmente não
    // estava lá em nenhum dos dois frames.
    //
    // Metade da altitude por frame é uma série geométrica: a nave sempre chega
    // perto, nunca atravessa, e o piso de `groundClearance * 2` garante que ela
    // ainda consegue de fato tocar o solo para pousar.
    // -----------------------------------------------------------------------
    const step = this.velocity.length() * dt;
    const safeStep = Math.max(sample.altitude * 0.5, SETTINGS.groundClearance * 2);
    if (step > safeStep) {
      // Freia a VELOCIDADE, não só o deslocamento: limitar o passo mantendo a
      // velocidade faria a nave pairar contra uma parede invisível, acelerada,
      // sem nunca encostar no chão nem desacelerar.
      this.velocity.multiplyScalar(safeStep / step);
    }

    this.object.position.addScaledVector(this.velocity, dt);

    this._resolveGroundCollision(planet, dt);
  }

  /**
   * Colisão contra o terreno.
   *
   * Usa uma única amostra do campo de altura sob o centro da nave — barato e
   * suficiente para uma PoC. Um jogo real amostraria alguns pontos (nariz,
   * pontas das asas, trem de pouso) e reagiria à normal do terreno.
   */
  _resolveGroundCollision(planet, dt) {
    const sample = planet.sampleAt(this.object.position);
    const minRadius = sample.surfaceRadius + SETTINGS.groundClearance;

    if (sample.distance >= minRadius) {
      this.landed = false;
      return;
    }

    _up.copy(sample.direction);

    // Reposiciona exatamente na superfície.
    this.object.position
      .copy(planet.group.position)
      .addScaledVector(_up, minRadius);

    // Zera só a componente que aponta PARA DENTRO do planeta; a componente
    // tangencial vira deslizamento (a nave escorrega ao invés de grudar).
    const radialSpeed = this.velocity.dot(_up);
    if (radialSpeed < 0) this.velocity.addScaledVector(_up, -radialSpeed);
    this.velocity.multiplyScalar(Math.pow(SETTINGS.groundFriction, dt * 60));

    this.landed = true;
  }

  /* ===================================================================== */
  /* Câmera                                                                 */
  /* ===================================================================== */

  /**
   * Câmera de perseguição com amortecimento exponencial.
   *
   * `damp` em vez de `lerp` cru porque o lerp com fator fixo é dependente do
   * frame rate: a 144 Hz a câmera gruda na nave, a 30 Hz ela arrasta.
   */
  updateCamera(camera, dt) {
    if (this.cockpitView) {
      _offset.copy(SETTINGS.cockpitOffset).applyQuaternion(this.object.quaternion);
      camera.position.copy(this.object.position).add(_offset);
      camera.quaternion.copy(this.object.quaternion);
      return;
    }

    _offset.copy(SETTINGS.cameraOffset).applyQuaternion(this.object.quaternion);
    _cameraGoal.copy(this.object.position).add(_offset);

    const k = 1 - Math.exp(-SETTINGS.cameraStiffness * dt);
    camera.position.lerp(_cameraGoal, k);

    _cameraLook.copy(SETTINGS.cameraLookAhead).applyQuaternion(this.object.quaternion);
    _cameraLook.add(this.object.position);

    // O "up" da câmera é o da nave: sem isso, ao fazer um loop a câmera
    // giraria sozinha para manter o Y global para cima e embrulharia o estômago.
    _up.set(0, 1, 0).applyQuaternion(this.object.quaternion);
    camera.up.copy(_up);
    camera.lookAt(_cameraLook);
  }

  /**
   * Cola a câmera na posição de perseguição AGORA, sem amortecimento.
   *
   * Existe para os teletransportes (a chegada de um salto interestelar). O
   * amortecimento da `updateCamera` é o que dá peso à câmera em voo, e é
   * exatamente o que estraga uma troca de sistema: a câmera parte de onde
   * estava no sistema ANTERIOR e viaja até a nova posição ao longo de quase um
   * segundo, atravessando o espaço numa cambalhota — que é como o jogador
   * descreve o efeito, e ele tem razão.
   *
   * `dt` infinito zera o termo exponencial e o `lerp` vai direto ao destino, o
   * que mantém uma implementação só do enquadramento.
   */
  assentarCamera(camera) {
    this.updateCamera(camera, Infinity);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
  }
}
