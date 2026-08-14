/**
 * Sombras projetadas pelo sol.
 *
 * ===========================================================================
 * POR QUE UMA CLASSE, E NÃO `sunLight.castShadow = true`
 * ===========================================================================
 * A luz do sol é uma direcional cujo mapa de sombra é uma câmera ORTOGRÁFICA:
 * ela cobre uma caixa, e a resolução da sombra é o tamanho dessa caixa dividido
 * pelo tamanho do mapa. Aqui a caixa teria de conter o planeta — 30 mil unidades
 * de diâmetro — e num mapa de 2048 cada texel valeria QUINZE METROS. Nenhuma
 * árvore projetaria nada; sobraria uma mancha serrilhada do relevo inteiro.
 *
 * A saída é a de sempre em mundos abertos: a caixa não segue o planeta, segue o
 * JOGADOR. Um volume de ~340 unidades ao redor da câmera dá ~0,17 unidade por
 * texel — sombra de galho. O que está fora da caixa simplesmente não projeta, e
 * ninguém percebe, porque a três quilômetros de distância uma sombra de árvore
 * tem menos de um pixel.
 *
 * ===========================================================================
 * OS DOIS PROBLEMAS QUE ISSO CRIA
 * ===========================================================================
 *  1. A CAIXA SE MOVE, E A SOMBRA FERVE. Deslocar a câmera de sombra por uma
 *     fração de texel remapeia a que texel cada ponto do mundo pertence: a borda
 *     de toda sombra da tela reamostra a cada frame e cintila. Por isso o centro
 *     é ENCAIXADO na grade de texels da própria luz (`_encaixar`) — a caixa anda
 *     aos saltos de um texel inteiro e a sombra fica parada em relação ao mundo.
 *
 *  2. A DIREÇÃO DA LUZ MUDA (ciclo dia/noite), e ao rasante o comprimento das
 *     sombras tende ao infinito. Perto do horizonte elas são desligadas por
 *     desvanecimento em vez de corte seco: `_intensidade` vai a zero antes de o
 *     sol se pôr, senão a cena inteira pisca no instante da troca.
 *
 * O custo é um segundo desenho da geometria que estiver dentro da caixa. Como a
 * caixa é pequena e o three faz culling contra a câmera de sombra, isso é uma
 * fração dos chunks ativos — medido em §3.16.2 do README.
 */

import * as THREE from 'three';

/** Meia-aresta da caixa de sombra, em unidades de mundo. */
const RAIO = 170;

/**
 * Distância da luz virtual ao centro da caixa.
 *
 * Não é a distância real do sol (60 000): a câmera ortográfica precisa de
 * `near`/`far` que a contenham, e um intervalo de 60 mil unidades num depth
 * buffer de sombra devolve precisão suficiente apenas para... nada. Como a
 * projeção é ortográfica, a DIREÇÃO é tudo que importa — aproximar a luz não
 * muda uma única sombra, e recupera toda a precisão.
 */
const DISTANCIA = 900;

/** Altitude acima da qual a sombra some (nada a projetar, e a caixa não cobre). */
const ALTITUDE_MAXIMA = 900;

export class SombrasDoSol {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.DirectionalLight} sol
   */
  constructor(renderer, sol) {
    this.renderer = renderer;
    this.ligado = new URLSearchParams(location.search).get('sombras') !== 'off';

    renderer.shadowMap.enabled = this.ligado;
    // PCF suave: o degrau duro do mapa de sombra num terreno de cor chapada é
    // exatamente o tipo de serrilhado que denuncia a técnica. VSM daria borda
    // mais macia e vaza luz (light bleeding) sob copas densas, que é o caso mais
    // comum desta cena.
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = this.ligado;

    this.sol = null;
    this._centro = new THREE.Vector3();
    this._eixoX = new THREE.Vector3();
    this._eixoY = new THREE.Vector3();
    this._frente = new THREE.Vector3();
    this._acima = new THREE.Vector3();

    this.adotar(sol);
  }

  /**
   * Liga ou desliga em tempo de execução (menu de opções).
   *
   * `autoUpdate` acompanha `enabled` porque desligar só o `castShadow` da luz
   * deixaria o mapa de sombra congelado em memória e ainda amostrado pelos
   * shaders — que continuariam compilados com `USE_SHADOWMAP` e pagando a
   * amostragem por fragmento sem sombra nenhuma na tela.
   */
  definir(ligado) {
    if (this.ligado === !!ligado) return;
    this.ligado = !!ligado;

    this.renderer.shadowMap.enabled = this.ligado;
    this.renderer.shadowMap.autoUpdate = this.ligado;
    if (this.sol) this.sol.castShadow = this.ligado;
    if (this.ligado) this.adotar(this.sol);

    // Os materiais JÁ COMPILADOS carregam `USE_SHADOWMAP` nas suas opções e não
    // reagem sozinhos à troca: sem invalidá-los, desligar as sombras não
    // devolve o desempenho (os shaders continuam amostrando o mapa) e ligá-las
    // não mostra sombra nenhuma. A cena é alcançada pelo pai da própria luz,
    // que é onde ela foi anexada.
    const cena = this.sol?.parent;
    cena?.traverse((o) => {
      if (o.material) {
        const lista = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of lista) m.needsUpdate = true;
      }
    });
  }

  /**
   * Configura a luz de um sistema estelar.
   *
   * Existe separado do construtor porque o salto reconstrói o `StarSystem`
   * inteiro (ver `StarSystem.recriar`) e a direcional do sistema novo é outro
   * objeto — sem esta chamada as sombras continuariam anexadas a uma luz que
   * não está mais na cena.
   *
   * @param {THREE.DirectionalLight} sol
   */
  adotar(sol) {
    this.sol = sol;
    if (!this.ligado) return;

    sol.castShadow = true;
    sol.shadow.mapSize.set(2048, 2048);

    const c = sol.shadow.camera;
    c.left = -RAIO;
    c.right = RAIO;
    c.top = RAIO;
    c.bottom = -RAIO;
    c.near = 1;
    c.far = DISTANCIA * 2;
    c.updateProjectionMatrix();

    // ---------------------------------------------------------------------
    // ACNE E PETER-PANNING
    //
    // `bias` desloca a comparação de profundidade para trás e mata a acne (as
    // listras de auto-sombra em superfícies quase paralelas à luz). Ele sozinho,
    // grande o bastante para o terreno rasante, descolaria a sombra do pé da
    // árvore — o "peter-panning".
    //
    // `normalBias` faz o trabalho pesado: empurra o ponto amostrado ao longo da
    // NORMAL, que é proporcional ao erro real de um texel de sombra e não cria
    // descolamento visível. Daí o bias comum ficar quase zerado.
    // ---------------------------------------------------------------------
    sol.shadow.bias = -0.0006;
    sol.shadow.normalBias = 0.65;
  }

  /**
   * Reposiciona a caixa em torno da câmera e ajusta a intensidade.
   *
   * @param {THREE.Camera} camera
   * @param {THREE.Vector3} direcaoSol normalizada, da cena até o sol
   * @param {number} altitude unidades acima da superfície
   * @param {THREE.Vector3} cima normal do terreno sob o jogador
   */
  atualizar(camera, direcaoSol, altitude, cima) {
    if (!this.ligado || !this.sol) return;

    const forca = this._intensidade(direcaoSol, altitude, cima);
    // Desligar o `castShadow` (em vez de só zerar a opacidade) é o que devolve o
    // custo: com ele falso o three nem sequer percorre a cena pela câmera de
    // sombra. No espaço isso é o frame inteiro de volta.
    if (forca <= 0) {
      if (this.sol.castShadow) this.sol.castShadow = false;
      return;
    }
    if (!this.sol.castShadow) this.sol.castShadow = true;
    this.sol.shadow.intensity = forca;

    // O centro vai ADIANTE da câmera, não sobre ela: metade da caixa atrás do
    // observador é volume gasto com o que ele não vê. Empurrando 40% do raio na
    // direção do olhar, a mesma caixa cobre bem mais tela.
    camera.getWorldDirection(this._frente);
    this._centro.copy(camera.position).addScaledVector(this._frente, RAIO * 0.4);

    this._encaixar(direcaoSol);

    this.sol.position.copy(this._centro).addScaledVector(direcaoSol, DISTANCIA);
    this.sol.target.position.copy(this._centro);
    this.sol.target.updateMatrixWorld();
  }

  /**
   * Desvanecimento nas duas pontas: sol rasante e altitude.
   *
   * Ao rasante as sombras ficariam mais longas que a caixa e entrariam e sairiam
   * dela conforme o jogador anda — pior que não ter sombra. Em altitude não há o
   * que projetar dentro do volume, e o custo seria pago à toa.
   */
  _intensidade(direcaoSol, altitude, cima) {
    const elevacao = cima ? cima.dot(direcaoSol) : 1;
    const porSol = THREE.MathUtils.smoothstep(elevacao, 0.05, 0.22);
    const porAltitude = 1 - THREE.MathUtils.smoothstep(altitude, ALTITUDE_MAXIMA * 0.6, ALTITUDE_MAXIMA);
    return porSol * porAltitude;
  }

  /**
   * Encaixa o centro na grade de texels da luz.
   *
   * Sem isto a sombra FERVE ao andar: o centro se move continuamente, cada texel
   * do mapa passa a cobrir um pedaço ligeiramente diferente do mundo e toda
   * borda de sombra reamostra a cada frame. Andar devagar, que deveria ser o
   * caso mais tranquilo, é o pior — a cintilação fica bem visível.
   *
   * O encaixe é feito nos eixos da CÂMERA DE SOMBRA (não nos do mundo): é ali
   * que a grade de texels existe.
   */
  _encaixar(direcaoSol) {
    const unidade = (RAIO * 2) / this.sol.shadow.mapSize.x;

    // Base ortonormal do plano perpendicular à luz. O vetor auxiliar troca perto
    // do polo para não degenerar quando a luz fica paralela a ele.
    this._acima.set(0, 1, 0);
    if (Math.abs(direcaoSol.y) > 0.95) this._acima.set(1, 0, 0);
    this._eixoX.crossVectors(this._acima, direcaoSol).normalize();
    this._eixoY.crossVectors(direcaoSol, this._eixoX).normalize();

    const x = this._centro.dot(this._eixoX);
    const y = this._centro.dot(this._eixoY);
    const dx = Math.round(x / unidade) * unidade - x;
    const dy = Math.round(y / unidade) * unidade - y;
    this._centro.addScaledVector(this._eixoX, dx).addScaledVector(this._eixoY, dy);
  }
}
