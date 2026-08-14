/**
 * Iluminação ambiente por imagem (IBL) derivada do céu do planeta.
 *
 * ===========================================================================
 * O QUE FALTAVA
 * ===========================================================================
 * A cena tinha duas fontes: a direcional do sol e uma hemisférica. A
 * hemisférica é uma aproximação grosseira do ambiente — devolve UMA cor para
 * tudo que aponta para cima e outra para tudo que aponta para baixo, sem
 * nenhuma noção de direção no meio. Para um material rugoso passa; para
 * qualquer coisa lisa é desastroso, porque `MeshStandardMaterial` sem
 * `envMap` simplesmente NÃO TEM reflexo especular do ambiente.
 *
 * Era exatamente o que se via: o casco da nave com `metalness: 0.85` aparecia
 * como um cinza morto. Um metal não tem cor difusa nenhuma — ele é feito só de
 * reflexo — então um metal sem ambiente para refletir é, literalmente, preto
 * com um ponto de brilho do sol. O mesmo vale, em menor grau, para o vidro do
 * cockpit, os minerais e a água.
 *
 * ===========================================================================
 * COMO
 * ===========================================================================
 * Um céu procedural (gradiente zênite → horizonte → chão, mais o disco solar) é
 * desenhado numa cena minúscula e passado pelo `PMREMGenerator`, que devolve o
 * mapa pré-filtrado por rugosidade que o three espera em `scene.environment`.
 * A partir daí TODO material padrão da cena — terreno, props, nave, peças de
 * construção — recebe ambiente direcional de graça, sem nenhuma alteração nos
 * materiais.
 *
 * ===========================================================================
 * POR QUE NÃO TODO FRAME
 * ===========================================================================
 * A pré-filtragem custa alguns milissegundos: fazê-la a 60 Hz gastaria mais que
 * a cena inteira. Mas o céu quase não muda — o ciclo dia/noite completo leva
 * minutos. Então o mapa é refeito só quando as entradas se afastam do que
 * gerou o mapa atual (`_mudou`), o que na prática dá algumas regerações por
 * minuto, e nenhuma enquanto a nave voa com o sol parado.
 */

import * as THREE from 'three';

/** Intervalo mínimo entre duas regerações, em segundos. */
const INTERVALO = 0.5;

/** Quanto as cores precisam andar para valer uma regeração. */
const LIMIAR = 0.02;

const _ceu = new THREE.Color();
const _chao = new THREE.Color();
const _sol = new THREE.Color();

export class CeuAmbiente {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} cena
   */
  constructor(renderer, cena) {
    this.renderer = renderer;
    this.cena = cena;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    // Compila os shaders de pré-filtragem agora, e não na primeira geração:
    // fazê-lo no meio do jogo custa um engasgo de dezenas de milissegundos
    // exatamente quando o jogador entra na atmosfera.
    this.pmrem.compileEquirectangularShader();

    this.alvo = null;
    this._relogio = 0;
    this._ultimo = null;

    this.uniforms = {
      uCeu: { value: new THREE.Color(0x3d78b8) },
      uHorizonte: { value: new THREE.Color(0xbcd2e8) },
      uChao: { value: new THREE.Color(0x4a4234) },
      uSolDir: { value: new THREE.Vector3(0, 1, 0) },
      uSolCor: { value: new THREE.Color(0xfff2dd) },
      uSolForca: { value: 8 },
    };

    // Uma caixa vista por dentro. Poderia ser uma esfera; a caixa tem 12
    // triângulos e o resultado é idêntico, porque a cor é função da DIREÇÃO do
    // fragmento, não da geometria.
    this._malha = new THREE.Mesh(
      new THREE.BoxGeometry(10, 10, 10),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: this.uniforms,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec3 vDir;
          uniform vec3 uCeu;
          uniform vec3 uHorizonte;
          uniform vec3 uChao;
          uniform vec3 uSolDir;
          uniform vec3 uSolCor;
          uniform float uSolForca;

          void main() {
            vec3 d = normalize(vDir);

            // Duas rampas separadas no horizonte, e não uma só do topo ao chão:
            // o clareamento perto do horizonte é curto e abrupto (o ar fica
            // opticamente espesso de repente), e uma rampa única o espalharia
            // pelo céu inteiro, deixando o zenite lavado.
            float h = d.y;
            vec3 cor = mix(uHorizonte, uCeu, smoothstep(0.0, 0.42, h));
            cor = mix(cor, uChao, smoothstep(0.0, -0.22, h));

            // O sol entra como um disco largo e MUITO brilhante. A largura
            // importa: um disco pequeno some na pré-filtragem por rugosidade e
            // o reflexo especular do casco desaparece; largo demais e o metal
            // vira um borrão claro sem direção.
            float cos_ = dot(d, normalize(uSolDir));
            cor += uSolCor * uSolForca * pow(max(cos_, 0.0), 320.0);
            // Halo: é ele que dá ao metal a impressão de estar sob um céu, e
            // não sob uma lâmpada isolada.
            cor += uSolCor * uSolForca * 0.06 * pow(max(cos_, 0.0), 8.0);

            gl_FragColor = vec4(cor, 1.0);
          }
        `,
      })
    );

    this._cena = new THREE.Scene();
    this._cena.add(this._malha);
  }

  /**
   * Reavalia o céu e regenera o mapa se valer a pena.
   *
   * @param {object} config config do planeta ativo
   * @param {import('../core/GameState.js').GameState} estado
   * @param {THREE.Vector3} direcaoSol
   * @param {THREE.Vector3} cima normal do terreno sob o jogador
   * @param {number} dt
   */
  atualizar(config, estado, direcaoSol, cima, dt) {
    this._relogio -= dt;
    if (this._relogio > 0) return;
    this._relogio = INTERVALO;

    const atmo = estado.atmosphere;
    const dia = estado.dayFactor;

    _ceu.fromArray(config.atmosphere.tint);
    _chao.fromArray(config.palette.dry);
    _sol.copy(estado.starSystem.sunLight.color);

    // No vácuo não há céu: o ambiente é o preto do espaço mais o sol. Interpolar
    // até quase zero (e não até zero) evita que o casco fique absolutamente
    // preto no lado escuro, o que lê como buraco na tela e não como metal.
    const forcaCeu = atmo * dia;
    const u = this.uniforms;
    u.uCeu.value.copy(_ceu).multiplyScalar(0.10 + forcaCeu * 0.85);
    u.uHorizonte.value.copy(_ceu).lerp(_sol, 0.45 * dia).multiplyScalar(0.14 + forcaCeu * 1.25);
    u.uChao.value.copy(_chao).multiplyScalar(0.05 + forcaCeu * 0.55);
    u.uSolCor.value.copy(_sol);
    u.uSolForca.value = 6 + (1 - atmo) * 8;

    // A direção do sol vai em espaço LOCAL do observador: o `y` do gradiente é
    // "para cima" na superfície do planeta, e para cima é a normal do terreno,
    // não o eixo Y do mundo. Sem esta conversão o céu do IBL estaria de lado em
    // qualquer ponto que não fosse o polo norte do planeta.
    const cimaSeguro = cima && cima.lengthSq() > 0.5 ? cima : _ALTO;
    const elev = direcaoSol.dot(cimaSeguro);
    // Só a elevação é preservada; o azimute é arbitrário porque o gradiente tem
    // simetria de revolução e o disco solar é a única coisa que o quebraria.
    u.uSolDir.value.set(Math.sqrt(Math.max(0, 1 - elev * elev)), elev, 0);

    if (!this._mudou()) return;
    this._gerar();
  }

  /** As entradas se afastaram o bastante do mapa atual? */
  _mudou() {
    const u = this.uniforms;
    const agora = [
      ...u.uCeu.value.toArray(),
      ...u.uHorizonte.value.toArray(),
      ...u.uChao.value.toArray(),
      u.uSolDir.value.y,
      u.uSolForca.value * 0.05,
    ];
    if (!this._ultimo) {
      this._ultimo = agora;
      return true;
    }
    let dif = 0;
    for (let i = 0; i < agora.length; i++) dif = Math.max(dif, Math.abs(agora[i] - this._ultimo[i]));
    if (dif < LIMIAR) return false;
    this._ultimo = agora;
    return true;
  }

  _gerar() {
    const anterior = this.alvo;
    this.alvo = this.pmrem.fromScene(this._cena);
    this.cena.environment = this.alvo.texture;
    // Descartado DEPOIS de a cena já apontar para o novo: liberar antes deixaria
    // um frame com `environment` apontando para uma textura morta, e o WebGL
    // reclama disso em vermelho no console.
    anterior?.dispose();
  }

  dispose() {
    this.cena.environment = null;
    this.alvo?.dispose();
    this.pmrem.dispose();
    this._malha.geometry.dispose();
    this._malha.material.dispose();
  }
}

const _ALTO = new THREE.Vector3(0, 1, 0);
