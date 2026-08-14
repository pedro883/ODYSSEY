/**
 * Mãos e ferramenta em primeira pessoa.
 *
 * ===========================================================================
 * POR QUE UMA CENA SEPARADA
 * ===========================================================================
 * A ferramenta fica a ~40 cm do olho. Numa câmera com plano próximo ajustado
 * para escala planetária (o `tuneCameraPlanes` do Engine chega a empurrar o
 * near para dezenas de unidades em órbita), qualquer objeto a 40 cm é cortado
 * antes de existir. E mesmo com near pequeno, a ferramenta atravessaria
 * paredes: ela está sempre mais perto do que qualquer geometria do mundo, mas o
 * depth buffer é compartilhado e o terreno logo à frente venceria o teste.
 *
 * A saída é o que todo jogo em primeira pessoa faz: uma SEGUNDA cena, com
 * câmera própria de plano próximo curto, desenhada por cima da primeira com o
 * depth buffer limpo. O custo é um `render()` a mais de meia dúzia de objetos.
 *
 * ===========================================================================
 * AS MÃOS SÃO GEOMETRIA, NÃO MODELO
 * ===========================================================================
 * O pacote Kenney não tem um par de mãos em primeira pessoa — os personagens
 * dele são bonecos inteiros, e recortar as mãos de um deles exigiria rig e
 * animação. Duas cápsulas com a cor do traje resolvem o mesmo problema: em
 * primeira pessoa, o que comunica "isto é seu" não é a anatomia do dedo, é ter
 * dois volumes segurando a ferramenta e acompanhando o movimento.
 */

import * as THREE from 'three';
import { assets } from '../assets/AssetLibrary.js';

/**
 * Posição de repouso da ferramenta, em espaço de câmera.
 *
 * Os números vieram de olhar o resultado, não de teoria: a primeira tentativa
 * (x = 0,26) jogava metade da arma para fora da tela no canto direito. O que
 * funciona é a ferramenta ocupar o quadrante inferior direito SEM encostar na
 * borda, com o cano cruzando em direção ao centro do retículo.
 */
const REPOUSO = new THREE.Vector3(0.15, -0.155, -0.46);

/** Deslocamento adicional enquanto a ferramenta está guardada. */
const GUARDADO = new THREE.Vector3(0.1, -0.34, 0.12);

const _alvo = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _eixo = new THREE.Vector3();

export class ViewModel {
  constructor() {
    this.scene = new THREE.Scene();

    // Plano próximo curtíssimo e campo um pouco mais fechado que o do jogo: é o
    // que impede a ferramenta de parecer uma escultura gigante colada na lente.
    //
    // O plano DISTANTE é 240 e não 12 por causa do túnel do salto, que vive
    // nesta mesma cena e se estende a ~59 unidades à frente da câmera. Com o
    // valor antigo ele era inteiramente descartado pelo frustum: o campo de
    // visão abria, o clarão acontecia, e a viagem inteira passava sem uma
    // listra na tela. Esticar o alcance não custa precisão onde importa — ela é
    // governada pelo plano PRÓXIMO, e aqui não há nada para disputar
    // profundidade com a ferramenta.
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.01, 240);
    this.scene.add(this.camera);

    // Luz própria. A do mundo é direcional e gira com o sol — de costas para
    // ele, a ferramenta ficaria uma silhueta preta no meio da tela.
    const chave = new THREE.DirectionalLight(0xffffff, 2.2);
    chave.position.set(0.6, 1.0, 0.8);
    this.scene.add(chave);
    this.scene.add(new THREE.AmbientLight(0x8fb6c8, 1.1));

    /** Nó que carrega mãos + ferramenta; tudo balança junto. */
    this.suporte = new THREE.Group();
    this.camera.add(this.suporte);

    this.maos = this._criarMaos();
    this.suporte.add(this.maos);

    /** @type {Map<string, THREE.Object3D>} */
    this._modelos = new Map();
    /** @type {THREE.Object3D|null} */
    this.ferramenta = null;

    this.visivel = true;
    this._balanco = 0;
    this._recuo = 0;
    this._troca = 0;
    this._posicao = REPOUSO.clone();
  }

  /**
   * Cria o par de mãos.
   *
   * A direita fica atrás e à direita (empunhadura), a esquerda à frente e mais
   * baixa (apoio no cano) — a pose de duas mãos que qualquer pessoa reconhece
   * como "segurando com firmeza", e que também esconde o fato de a ferramenta
   * não ter cabo modelado.
   */
  _criarMaos() {
    const grupo = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({
      color: 0xe0b58a,
      roughness: 0.85,
      metalness: 0.0,
    });
    const punho = new THREE.MeshStandardMaterial({
      color: 0x2f4a5c,
      roughness: 0.7,
      metalness: 0.2,
    });

    // As proporções vieram de olhar a tela: a primeira tentativa usava cápsulas
    // de 3,5 cm de raio numa arma de 22 cm, e o resultado eram dois cilindros
    // escuros do tamanho do próprio receiver — mais parecidos com obstáculos na
    // lente do que com mãos.
    const criar = (x, y, z, rot) => {
      const mao = new THREE.Group();

      const palma = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.03, 4, 8), material);
      palma.rotation.z = Math.PI / 2;
      mao.add(palma);

      // Luva: cobre o punho e dá a leitura de traje pressurizado sem precisar
      // de textura nenhuma.
      const luva = new THREE.Mesh(new THREE.CylinderGeometry(0.023, 0.028, 0.042, 10), punho);
      luva.rotation.z = Math.PI / 2;
      luva.position.x = 0.035;
      mao.add(luva);

      mao.position.set(x, y, z);
      mao.rotation.y = rot;
      return mao;
    };

    grupo.add(criar(0.028, -0.045, 0.03, 0.25));   // direita, na empunhadura
    grupo.add(criar(-0.005, -0.04, -0.07, 0.5));   // esquerda, adiante no cano
    return grupo;
  }

  /** Carrega os modelos das ferramentas. Chamado uma vez, no boot. */
  async preparar(caminhos) {
    await assets.preload(caminhos);

    for (const caminho of caminhos) {
      const cena = assets.getSceneSync(caminho);
      if (!cena) continue;

      const modelo = cena.clone(true);

      // Normaliza para um comprimento fixo. Os blasters do pacote variam de
      // tamanho, e sem isto trocar de ferramenta mudaria a escala aparente das
      // mãos — que são as mesmas.
      const caixa = new THREE.Box3().setFromObject(modelo);
      const tamanho = caixa.getSize(new THREE.Vector3());
      // 0,22 e não 0,34: com a câmera a 55° e a ferramenta a 46 cm do olho, o
      // valor antigo fazia a arma ocupar três quartos da altura da tela. O que
      // se quer é um objeto no canto, não um obstáculo no meio da vista.
      const escala = 0.22 / (Math.max(tamanho.x, tamanho.y, tamanho.z) || 1);
      modelo.scale.setScalar(escala);

      // Centra na empunhadura e aponta o cano para -Z (o mesmo eixo da câmera).
      const centro = caixa.getCenter(new THREE.Vector3()).multiplyScalar(escala);
      modelo.position.set(-centro.x, -centro.y, -centro.z);

      // -------------------------------------------------------------------
      // ORIENTAÇÃO: NENHUMA VOLTA EM Y.
      //
      // O eixo longo dos blasters é Z (medido: 0,16 × 0,34 × 0,91) e o cano
      // aponta para −Z, que é exatamente para onde a câmera olha. O modelo já
      // nasce certo.
      //
      // Este campo errou duas vezes antes de chegar aqui, e as duas por
      // dedução em vez de observação: primeiro um quarto de volta (supondo que
      // o pacote exporta ao longo de X, e a arma ficou atravessada na tela);
      // depois meia volta, deduzida de uma captura em que confundi as mãos com
      // o cano — e a arma passou a apontar para o próprio jogador. A caixa
      // envolvente é simétrica em Z e NÃO diz para que lado o cano aponta;
      // só olhar a tela diz.
      //
      // O desvio de 0,17 rad é a única correção real: apontando reto para
      // dentro da tela, a arma tapa justamente o ponto que se está mirando.
      // -------------------------------------------------------------------
      const eixo = new THREE.Group();
      eixo.add(modelo);
      eixo.rotation.set(0.05, 0.17, 0.03);
      eixo.visible = false;
      this.suporte.add(eixo);
      this._modelos.set(caminho, eixo);
    }
  }

  /** Troca a ferramenta na mão, com o gesto de guardar e sacar. */
  equipar(caminho) {
    const novo = this._modelos.get(caminho) ?? null;
    if (novo === this.ferramenta) return;
    if (this.ferramenta) this.ferramenta.visible = false;
    this.ferramenta = novo;
    if (novo) novo.visible = true;
    // Reinicia a animação de saque: a ferramenta sobe de baixo da tela.
    this._troca = 1;
  }

  /** Coice ao usar (mineração, construção, escavação). */
  coice(forca = 1) {
    this._recuo = Math.min(1, this._recuo + forca);
  }

  /**
   * @param {number} dt
   * @param {object} estado
   * @param {boolean} estado.visivel a pé e sem menus abertos
   * @param {number} estado.velocidade para o balanço do passo
   * @param {boolean} estado.usando botão pressionado
   */
  atualizar(dt, estado) {
    // `visivel` manda a CENA de sobreposição ser desenhada; `suporte` é só as
    // mãos. São coisas diferentes desde que o túnel do salto passou a morar
    // aqui: durante a viagem a cena precisa ser desenhada e a ferramenta, não.
    this.suporte.visible = estado.visivel;
    this.visivel = estado.visivel || estado.cenaAtiva === true;
    if (!estado.visivel) return;

    // --- Balanço do passo --------------------------------------------------
    // Amarrado à VELOCIDADE, não a um relógio: parar no meio de uma passada
    // congela o balanço em vez de continuar gingando com o jogador imóvel.
    const andando = Math.min(1, estado.velocidade / 9);
    this._balanco += dt * (2.4 + andando * 7.5);
    const balancoX = Math.sin(this._balanco) * 0.013 * andando;
    const balancoY = Math.abs(Math.cos(this._balanco)) * 0.011 * andando;

    // --- Coice e troca -----------------------------------------------------
    this._recuo = Math.max(0, this._recuo - dt * 5.5);
    this._troca = Math.max(0, this._troca - dt * 3.6);

    const recuo = this._recuo * this._recuo; // quadrático: pico curto, volta macia
    const guardado = this._troca * this._troca;

    _alvo.copy(REPOUSO);
    _alvo.x += balancoX;
    _alvo.y += balancoY - recuo * 0.02;
    _alvo.z += recuo * 0.06;
    _alvo.addScaledVector(GUARDADO, guardado);

    // Persegue exponencialmente em vez de saltar: é o mesmo amortecimento da
    // câmera de perseguição da nave, e o que dá peso ao objeto.
    this._posicao.lerp(_alvo, 1 - Math.exp(-16 * dt));
    this.suporte.position.copy(this._posicao);

    // Inclinação: sobe o cano no coice e gira ao guardar.
    _eixo.set(1, 0, 0);
    _q.setFromAxisAngle(_eixo, recuo * 0.22);
    this.suporte.quaternion.copy(_q);
    _eixo.set(0, 0, 1);
    _q.setFromAxisAngle(_eixo, guardado * 0.9);
    this.suporte.quaternion.multiply(_q);
  }

  /** Redimensiona a câmera própria junto com a do jogo. */
  redimensionar(aspecto) {
    this.camera.aspect = aspecto;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this.scene.clear();
  }
}
