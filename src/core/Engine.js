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
import { AerialPerspective } from '../shaders/AerialPerspective.js';

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

    // -----------------------------------------------------------------------
    // Alvo de renderização para o pass de perspectiva aérea.
    //
    // TIPO MEIA-PRECISÃO FLUTUANTE, não byte: a cena agora é desenhada SEM
    // tone mapping (ele passa a ser a última etapa, no pass), então o alvo
    // guarda radiância crua, que passa de 1.0 com folga. Num alvo de 8 bits
    // por canal tudo acima de 1 seria ceifado, e o poente — justamente a parte
    // mais bonita — viraria um borrão branco chapado.
    //
    // `samples: 4` mantém o MSAA que o canvas tinha. Sem isso, trocar o canvas
    // por um render target custaria as bordas serrilhadas de todo o terreno.
    // -----------------------------------------------------------------------
    this.aerial = new AerialPerspective();
    // `?aerial=off` volta ao caminho antigo: cena direto no canvas, com o tone
    // mapping dentro de cada material. Não é só depuração — mover o tone
    // mapping para o fim MUDA a cor de toda a cena (ver README §3.6.3), e ter
    // como comparar lado a lado é o que permite julgar a troca.
    const desligado = new URLSearchParams(location.search).get('aerial') === 'off';
    this.aerialEnabled = this.renderer.capabilities.isWebGL2 && !desligado;

    if (this.aerialEnabled) {
      const depthTexture = new THREE.DepthTexture();
      depthTexture.type = THREE.UnsignedIntType;

      this.renderTarget = new THREE.WebGLRenderTarget(1, 1, {
        type: THREE.HalfFloatType,
        depthTexture,
        samples: 4,
      });
      // O tone mapping sai dos materiais e vira a última etapa do pass. Se
      // ficasse ligado aqui, o espalhamento seria somado a cores JÁ
      // comprimidas — o que, no limite, é somar luz a um branco saturado.
      //
      // EFEITO COLATERAL MEDIDO: a cena inteira fica mais escura, sobretudo no
      // azul (em órbita, o canal azul cai de 26 para 15 na média da tela). O
      // motivo é o termo de "offset" do Khronos Neutral, que subtrai o canal
      // mínimo: antes ele era aplicado camada por camada, agora incide uma vez
      // só sobre a SOMA — e numa cena escura como o espaço isso pesa. A
      // calibração de `uSunIntensity` documentada no README foi feita no
      // pipeline antigo e não vale mais ao pé da letra.
      this.renderer.toneMapping = THREE.NoToneMapping;
    }

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

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

    // O alvo vive em PIXELS DE DISPOSITIVO, não em pixels de CSS: ele
    // substitui o framebuffer do canvas, e dimensioná-lo pelo tamanho da
    // janela numa tela 2x renderizaria a cena em metade da resolução.
    if (this.renderTarget) {
      const ratio = this.renderer.getPixelRatio();
      this.renderTarget.setSize(Math.round(width * ratio), Math.round(height * ratio));
    }
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
    this.render();
  }

  /**
   * Um pass quando não há perspectiva aérea, dois quando há.
   *
   * A ordem importa: a cena inteira (terreno, props, nuvens e a casca de
   * atmosfera) vai para o alvo em radiância LINEAR; só depois o pass lê cor e
   * profundidade, acrescenta o espalhamento sobre o terreno e fecha com
   * exposição, tone mapping e conversão para sRGB.
   */
  render() {
    // -----------------------------------------------------------------------
    // MAPA GALÁCTICO: SUBSTITUI O MUNDO, NÃO SE SOMA A ELE.
    //
    // O mapa é uma cena inteira em outra escala (voxels de anos-luz contra
    // unidades de metro). Desenhar os dois no mesmo frame não traria nada — o
    // jogador está olhando o mapa — e obrigaria a conciliar dois planos de
    // profundidade separados por dez ordens de grandeza.
    //
    // A sobreposição continua sendo desenhada por cima: é onde vive o túnel do
    // salto, que precisa cobrir tanto o mapa quanto o mundo.
    // -----------------------------------------------------------------------
    if (this.mapa?.aberto) {
      this.renderer.render(this.mapa.scene, this.mapa.camera);
      this._renderOverlay();
      return;
    }

    if (!this.aerialEnabled) {
      this.renderer.render(this.scene, this.camera);
      this._renderOverlay();
      return;
    }

    this.aerial.setCamera(this.camera);

    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    this.aerial.render(
      this.renderer,
      this.renderTarget.texture,
      this.renderTarget.depthTexture,
      this.renderer.toneMappingExposure
    );
    this._renderOverlay();
  }

  /**
   * Cena de sobreposição (mãos e ferramenta em primeira pessoa).
   *
   * Desenhada por ÚLTIMO e com o depth buffer limpo. As duas coisas são
   * necessárias: por último porque no caminho da perspectiva aérea a imagem só
   * chega ao canvas depois do pass de tela cheia — desenhar antes seria pintar
   * num alvo que é descartado; e com o depth limpo porque a ferramenta está a
   * 40 cm do olho, mais perto do que o plano próximo da câmera do jogo, e
   * qualquer profundidade herdada a esconderia atrás do chão.
   *
   * `autoClear = false` no renderer inteiro seria mais simples e erraria feio:
   * o frame seguinte acumularia sobre este.
   */
  _renderOverlay() {
    if (!this.overlay?.visivel) return;
    const autoClearAntes = this.renderer.autoClear;
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.overlay.scene, this.overlay.camera);
    this.renderer.autoClear = autoClearAntes;
  }

  dispose() {
    this.stop();
    this.timer.disconnect();
    window.removeEventListener('resize', this._onResize);
    this.aerial.dispose();
    this.renderTarget?.dispose();
    this.renderer.dispose();
  }
}
