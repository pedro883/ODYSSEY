/**
 * Animação do salto interestelar.
 *
 * ===========================================================================
 * A ANIMAÇÃO NÃO É ENFEITE — ELA É O CARREGAMENTO
 * ===========================================================================
 * Trocar de sistema significa destruir cinco planetas, encerrar seis workers,
 * subir outros seis e gerar terreno do zero. Isso leva alguns segundos em que
 * a tela mostraria o vazio.
 *
 * O túnel cobre exatamente esse intervalo, e por isso ele não tem duração
 * fixa: acelera até a velocidade de cruzeiro, PERMANECE lá enquanto o mundo
 * novo não estiver pronto, e só então desacelera. É a diferença entre "a
 * animação terminou e agora esperamos" e "a viagem durou o que tinha de durar".
 *
 * ===========================================================================
 * TRÊS CAMADAS
 * ===========================================================================
 *   1. Túnel de listras — linhas radiais que se esticam com a velocidade. É o
 *      que dá a leitura de movimento; sozinhas já seriam reconhecíveis.
 *   2. Clarão — pico no engate e no desengate, escondendo a troca de cena.
 *   3. Vinheta de cor — puxa o quadro para a cor da estrela de destino, para a
 *      chegada não ser idêntica à partida.
 *
 * Tudo desenhado na cena de sobreposição, depois do mundo e com profundidade
 * limpa (ver `Engine._renderOverlay`), porque precisa cobrir qualquer coisa —
 * inclusive o nada que existe enquanto o sistema é reconstruído.
 */

import * as THREE from 'three';

/** Quantas listras formam o túnel. */
const LISTRAS = 900;

const FASE = {
  PARADO: 0,
  ACELERANDO: 1,
  CRUZEIRO: 2,
  DESACELERANDO: 3,
};

const DUR_ACELERA = 1.5;
const DUR_DESACELERA = 1.3;
/** Tempo mínimo em cruzeiro, mesmo que o mundo fique pronto antes. */
const CRUZEIRO_MINIMO = 1.1;

const vertexShader = `
  attribute float aOffset;
  attribute float aRaio;
  attribute float aAngulo;
  attribute float aVelocidade;

  uniform float uTempo;
  uniform float uIntensidade;

  varying float vBrilho;

  void main() {
    // Cada listra corre pelo tubo em direção à câmera e volta ao início — o
    // módulo faz o túnel ser infinito sem nenhuma listra ser recriada.
    // Invertido (1 - ...) para o movimento vir DE FRENTE PARA TRÁS, que é o
    // sentido de quem avança.
    float t = 1.0 - mod(aOffset + uTempo * aVelocidade * (0.25 + uIntensidade * 1.5), 1.0);

    // -------------------------------------------------------------------
    // RAIO PROPORCIONAL À PROFUNDIDADE.
    //
    // A primeira versão fazia o oposto — raio GRANDE junto da câmera — e o
    // resultado foi um túnel inteiramente fora do campo de visão: a 1 unidade
    // de distância, o meio-campo de uma lente de 55° tem 0,52 de altura, e as
    // listras nasciam a até 9,8 do eixo. A viagem acontecia fora da tela.
    //
    // Amarrando o raio à distância, o ângulo que cada listra ocupa fica
    // constante e o tubo preenche a tela em toda a sua extensão.
    // -------------------------------------------------------------------
    float profundidade = 1.6 + t * 52.0;
    float raio = aRaio * profundidade * 0.13;

    vec3 p = vec3(cos(aAngulo) * raio, sin(aAngulo) * raio, -profundidade);

    // A listra ESTICA com a velocidade: é o traço que o olho lê como "rápido
    // demais para ver". Sem isso o túnel parece uma chuva de pontos.
    p.z += position.y * (0.6 + uIntensidade * 9.0) * (0.4 + t * 2.0);

    // Desvanece nas duas pontas para as listras não surgirem nem sumirem de
    // forma abrupta no meio do quadro.
    vBrilho = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.7, 1.0, t)) * uIntensidade;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = `
  precision mediump float;
  uniform vec3 uCor;
  varying float vBrilho;

  void main() {
    if (vBrilho <= 0.002) discard;
    gl_FragColor = vec4(uCor * (0.55 + vBrilho * 1.9), vBrilho);
  }
`;

export class WarpJump {
  constructor() {
    this.grupo = new THREE.Group();
    this.fase = FASE.PARADO;
    this.t = 0;
    this.intensidade = 0;
    this._cruzeiro = 0;
    /** Preenchido no `iniciar`; consultado para saber se já pode chegar. */
    this._pronto = null;
    this._aoTrocar = null;
    this._trocou = false;

    this.uniforms = {
      uTempo: { value: 0 },
      uIntensidade: { value: 0 },
      uCor: { value: new THREE.Color(0x9bd8ff) },
    };

    this.tunel = this._criarTunel();
    this.grupo.add(this.tunel);

    // Clarão: um plano que cobre a tela inteira, à frente de tudo.
    this.clarao = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false, fog: false,
      })
    );
    this.clarao.frustumCulled = false;
    this.clarao.renderOrder = 999;
    // -----------------------------------------------------------------------
    // À FRENTE DA CÂMERA, NÃO EM CIMA DELA.
    //
    // O plano nasce na origem do grupo, que é a própria câmera — ou seja, em
    // z = 0, EXATAMENTE no olho e portanto atrás do plano próximo. Ele era
    // recortado por inteiro e o clarão simplesmente não existia (verificado
    // lendo o pixel central com opacidade 1: preto).
    //
    // A 5 cm, com lente de 55°, o meio-campo tem 2,6 cm — um plano de 2×2
    // cobre a tela com folga larga em qualquer proporção de janela.
    // -----------------------------------------------------------------------
    this.clarao.position.z = -0.05;
    this.grupo.add(this.clarao);

    this.grupo.visible = false;
  }

  _criarTunel() {
    // Um quad minúsculo por listra, esticado no shader. `InstancedMesh` seria a
    // outra saída; com atributos por instância num `BufferGeometry` único o
    // resultado é o mesmo em uma chamada de desenho e sem matriz por listra.
    const base = new THREE.PlaneGeometry(0.012, 1);
    const geometria = new THREE.InstancedBufferGeometry();
    geometria.index = base.index;
    geometria.attributes.position = base.attributes.position;
    geometria.attributes.uv = base.attributes.uv;

    const offset = new Float32Array(LISTRAS);
    const raio = new Float32Array(LISTRAS);
    const angulo = new Float32Array(LISTRAS);
    const velocidade = new Float32Array(LISTRAS);

    for (let i = 0; i < LISTRAS; i++) {
      offset[i] = Math.random();
      // Raiz quadrada: distribui as listras por ÁREA e não por raio, senão
      // elas se amontoam no centro do túnel e deixam a borda vazia.
      //
      // A faixa vai até ~4: com `raio = aRaio * profundidade * 0.13`, isso dá
      // um ângulo de 0,52 rad, que é exatamente o meio-campo da lente de 55°.
      // Acima disso a listra nasceria fora da tela em toda a sua extensão.
      raio[i] = 0.25 + Math.sqrt(Math.random()) * 3.8;
      angulo[i] = Math.random() * Math.PI * 2;
      velocidade[i] = 0.55 + Math.random() * 0.9;
    }

    geometria.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offset, 1));
    geometria.setAttribute('aRaio', new THREE.InstancedBufferAttribute(raio, 1));
    geometria.setAttribute('aAngulo', new THREE.InstancedBufferAttribute(angulo, 1));
    geometria.setAttribute('aVelocidade', new THREE.InstancedBufferAttribute(velocidade, 1));
    geometria.instanceCount = LISTRAS;

    const malha = new THREE.Mesh(
      geometria,
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    malha.frustumCulled = false;
    malha.renderOrder = 998;
    return malha;
  }

  get ativo() {
    return this.fase !== FASE.PARADO;
  }

  /**
   * Dispara o salto.
   *
   * @param {object} opcoes
   * @param {number} opcoes.cor cor da estrela de destino
   * @param {() => void} opcoes.aoTrocar troca o mundo; chamado no auge do clarão
   * @param {() => boolean} opcoes.pronto o mundo novo já pode ser mostrado?
   */
  iniciar({ cor, aoTrocar, pronto }) {
    if (this.ativo) return false;
    this.fase = FASE.ACELERANDO;
    this.t = 0;
    this._cruzeiro = 0;
    this._trocou = false;
    this._aoTrocar = aoTrocar;
    this._pronto = pronto ?? (() => true);
    this.uniforms.uCor.value.setHex(cor ?? 0x9bd8ff);
    this.grupo.visible = true;
    return true;
  }

  atualizar(dt) {
    if (!this.ativo) return;
    this.t += dt;
    this.uniforms.uTempo.value += dt;

    let clarao = 0;

    if (this.fase === FASE.ACELERANDO) {
      const k = Math.min(1, this.t / DUR_ACELERA);
      // Cúbica: a partida é lenta e o fim é violento, que é como uma aceleração
      // real se parece. Linear soaria mecânico.
      this.intensidade = k * k * k;

      // O mundo é trocado no AUGE do clarão, não no fim da animação: é o único
      // instante em que a tela está branca o suficiente para a substituição
      // passar despercebida.
      if (k >= 0.92 && !this._trocou) {
        this._trocou = true;
        clarao = 1;
        this._aoTrocar?.();
      }
      if (k >= 0.85) clarao = Math.max(clarao, (k - 0.85) / 0.15);

      if (k >= 1) {
        this.fase = FASE.CRUZEIRO;
        this.t = 0;
      }
    } else if (this.fase === FASE.CRUZEIRO) {
      this.intensidade = 1;
      this._cruzeiro += dt;
      // Fica aqui o tempo que o mundo novo precisar. Ver o cabeçalho.
      if (this._cruzeiro >= CRUZEIRO_MINIMO && this._pronto()) {
        this.fase = FASE.DESACELERANDO;
        this.t = 0;
      }
    } else if (this.fase === FASE.DESACELERANDO) {
      const k = Math.min(1, this.t / DUR_DESACELERA);
      this.intensidade = Math.pow(1 - k, 2.2);
      clarao = Math.max(0, 0.55 - k * 1.6);
      if (k >= 1) {
        this.fase = FASE.PARADO;
        this.intensidade = 0;
        this.grupo.visible = false;
      }
    }

    this.uniforms.uIntensidade.value = this.intensidade;
    this.clarao.material.opacity = clarao;
    this.clarao.visible = clarao > 0.002;
  }

  /**
   * Deslocamento de campo de visão para a câmera do jogo.
   *
   * O túnel sozinho não convence; o que vende a velocidade é a lente abrindo.
   * Devolvido em vez de aplicado para que quem manda na câmera continue sendo
   * o `Engine` — dois donos do mesmo FOV é receita para ele ficar preso num
   * valor errado quando algo interrompe o salto.
   */
  get deslocamentoFov() {
    return this.intensidade * 26;
  }

  /** Posiciona o túnel à frente da câmera de sobreposição. */
  acoplar(camera) {
    if (this.grupo.parent !== camera) camera.add(this.grupo);
  }

  dispose() {
    this.tunel.geometry.dispose();
    this.tunel.material.dispose();
    this.clarao.geometry.dispose();
    this.clarao.material.dispose();
  }
}
