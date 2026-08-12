/**
 * Renderer, câmera, loop e resize. Nenhuma regra de jogo mora aqui.
 *
 * DUAS DECISÕES QUE VALEM EXPLICAÇÃO
 *
 * 1. `logarithmicDepthBuffer: true`
 *    Numa cena que vai de 0,5 unidade (o cockpit) a 90.000 (as estrelas), o
 *    depth buffer linear de 24 bits não dá conta: montanhas a 3 km piscariam
 *    contra o oceano (z-fighting). O depth logarítmico redistribui a precisão
 *    e resolve isso sem truque de multi-pass. Custo: shaders custom precisam
 *    incluir os chunks `logdepthbuf_*` (ver AtmosphereShader.js).
 *
 * 2. `near` dinâmico
 *    Mesmo com depth log, aproximar `near` do olho quando se está no espaço é
 *    desperdício. Ajustamos `near` pela altitude: 0,1 ao pousar, dezenas de
 *    unidades em órbita.
 */

import * as THREE from 'three';

export class Engine {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
      stencil: false,
    });

    // Cap em 2: em telas 3x (celulares topo de linha) o custo de fragment
    // triplica sem ganho visual perceptível numa cena deste tipo.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral em vez de ACES. Medindo o céu deste planeta pelos
    // dois: ACES devolve (132,174,172) e Neutral (99,162,160) para a mesma
    // entrada — ACES puxa o canal vermelho para cima e lava o matiz. Num jogo
    // cujo apelo é justamente "cada planeta tem uma cor", ACES corrói o que
    // a geração procedural acabou de produzir. Neutral comprime só as altas
    // luzes e preserva a saturação nos tons médios.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      72,
      window.innerWidth / window.innerHeight,
      0.1,
      400000
    );
    // A câmera é dirigida pelo ShipController via lookAt; deixá-la fora do
    // grafo da nave evita herdar jitter da física.
    this.scene.add(this.camera);

    // `Timer` (sucessor do `Clock`, que está deprecado no r185). O `connect`
    // liga a Page Visibility API: ao voltar de uma aba em segundo plano ele
    // devolve um delta sensato em vez dos segundos que realmente passaram.
    this.timer = new THREE.Timer();
    this.timer.connect(document);
    this.elapsed = 0;

    // Média móvel de FPS — um contador instantâneo pisca demais para ser lido.
    this.fps = 60;
    this._frameCount = 0;
    this._fpsAccumulator = 0;

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this._running = false;
    this._update = null;
  }

  get isWebGL2() {
    return this.renderer.capabilities.isWebGL2;
  }

  resize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /**
   * Ajusta o plano near conforme a proximidade do terreno.
   * @param {number} altitude unidades acima da superfície
   */
  tuneCameraPlanes(altitude) {
    const near = THREE.MathUtils.clamp(altitude * 0.02, 0.1, 40);
    if (Math.abs(near - this.camera.near) > near * 0.25) {
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** @param {(dt: number, elapsed: number) => void} update */
  start(update) {
    this._update = update;
    this._running = true;
    this.renderer.setAnimationLoop((time) => this._tick(time));
  }

  stop() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
  }

  _tick(time) {
    if (!this._running) return;

    this.timer.update(time);
    // Clamp mesmo com o Timer conectado: um GC longo ou um stall de driver
    // ainda produz um pico, e a nave atravessaria o planeta num único passo.
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.elapsed += dt;

    this._fpsAccumulator += dt;
    this._frameCount++;
    if (this._fpsAccumulator >= 0.5) {
      this.fps = this._frameCount / this._fpsAccumulator;
      this._fpsAccumulator = 0;
      this._frameCount = 0;
    }

    this._update?.(dt, this.elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.stop();
    this.timer.disconnect();
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
  }
}
