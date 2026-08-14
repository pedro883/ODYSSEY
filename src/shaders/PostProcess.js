/**
 * Pós-processamento: bloom, exposição, tone mapping, vinheta e grão.
 *
 * ===========================================================================
 * ONDE ISTO ENTRA NO PIPELINE
 * ===========================================================================
 * A cena já era desenhada num alvo LINEAR de meia precisão, com o tone mapping
 * desligado nos materiais, para que a perspectiva aérea (§3.6.3) pudesse somar
 * espalhamento a radiância crua em vez de a cores já comprimidas. Esta etapa
 * aproveita o mesmo arranjo: o bloom precisa exatamente da mesma coisa.
 *
 *   cena  ->  alvo HDR linear
 *         ->  perspectiva aérea (soma espalhamento, SEM comprimir)
 *         ->  extração de brilho + borrão em cascata
 *         ->  composição: soma o bloom, expõe, comprime, vinheta, grão
 *         ->  tela
 *
 * O tone mapping SAIU da perspectiva aérea e passou a ser a última coisa que
 * acontece. A ordem não é detalhe: somar um halo a um pixel já comprimido para
 * [0,1] não tem para onde crescer, e o brilho aparece como uma mancha
 * acinzentada em vez de luz.
 *
 * ===========================================================================
 * POR QUE UMA CASCATA, E NÃO UM BORRÃO SÓ
 * ===========================================================================
 * Um Gaussiano largo o bastante para o halo de um sol custa dezenas de
 * amostras por pixel. Borrar em RESOLUÇÕES decrescentes e somar de volta dá o
 * mesmo alcance com um punhado de amostras: cada nível cobre o dobro da
 * distância do anterior porque o pixel dele é o dobro do tamanho. É o que
 * praticamente todo motor faz, e o motivo é aritmético, não estético.
 *
 * ===========================================================================
 * O QUE ESTE MÓDULO NÃO FAZ
 * ===========================================================================
 * Não há correção de cor por LUT nem profundidade de campo. O primeiro exigiria
 * uma textura de referência que este projeto não tem (todo o visual é gerado);
 * o segundo pediria o depth buffer aqui dentro e um passe a mais, e desfoque de
 * fundo num jogo em primeira pessoa a 60 Hz costuma atrapalhar mais do que
 * embelezar.
 */

import * as THREE from 'three';

/** Quantos níveis de borrão. 4 cobre ~64 px de halo numa tela de 1080p. */
const NIVEIS = 4;

const VERTICE = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/**
 * Extração de brilho com JOELHO.
 *
 * Um corte duro no limiar (`if (luz > limiar)`) produz cintilação: um pixel que
 * oscila em torno do limiar entra e sai do bloom inteiro a cada quadro, e o
 * resultado pisca em movimento. O joelho faz a passagem em rampa — é a mesma
 * solução do filmic bloom do Unreal e do Godot.
 */
const BRILHO = /* glsl */ `
  precision highp float;
  uniform sampler2D tCena;
  uniform float uLimiar;
  uniform float uJoelho;
  varying vec2 vUv;

  void main() {
    vec3 cor = texture2D(tCena, vUv).rgb;
    float luz = max(cor.r, max(cor.g, cor.b));
    float suave = clamp(luz - uLimiar + uJoelho, 0.0, 2.0 * uJoelho);
    suave = suave * suave / (4.0 * uJoelho + 1e-5);
    float peso = max(suave, luz - uLimiar) / max(luz, 1e-5);
    gl_FragColor = vec4(cor * peso, 1.0);
  }
`;

/**
 * Borrão separável de 9 toques com amostragem bilinear.
 *
 * Cinco leituras de textura cobrem nove texels porque cada leitura cai ENTRE
 * dois deles e o hardware faz a média de graça. É o truque clássico do
 * Gaussiano com pesos de Sigma≈2, e corta quase metade do custo do passe.
 */
const BORRAO = /* glsl */ `
  precision highp float;
  uniform sampler2D tCena;
  uniform vec2 uDirecao;    // (1/largura, 0) ou (0, 1/altura)
  varying vec2 vUv;

  void main() {
    vec3 soma = texture2D(tCena, vUv).rgb * 0.227027;
    vec2 d1 = uDirecao * 1.3846153846;
    vec2 d2 = uDirecao * 3.2307692308;
    soma += (texture2D(tCena, vUv + d1).rgb + texture2D(tCena, vUv - d1).rgb) * 0.3162162162;
    soma += (texture2D(tCena, vUv + d2).rgb + texture2D(tCena, vUv - d2).rgb) * 0.0702702703;
    gl_FragColor = vec4(soma, 1.0);
  }
`;

/** Soma um nível menor de volta ao maior, no caminho de subida da cascata. */
const SOMA = /* glsl */ `
  precision highp float;
  uniform sampler2D tCena;
  uniform sampler2D tMenor;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(texture2D(tCena, vUv).rgb + texture2D(tMenor, vUv).rgb, 1.0);
  }
`;

const COMPOSICAO = /* glsl */ `
  precision highp float;
  uniform sampler2D tCena;
  uniform sampler2D tBloom;
  uniform float uBloom;
  uniform float uExposicao;
  uniform float uVinheta;
  uniform float uSaturacao;
  uniform float uContraste;
  uniform float uGrao;
  uniform float uTempo;
  varying vec2 vUv;

  // Khronos PBR Neutral — o mesmo da perspectiva aérea, movido para cá porque
  // comprimir tem de ser a ÚLTIMA coisa que acontece.
  vec3 toneMapping(vec3 cor) {
    const float inicio = 0.8 - 0.04;
    const float dessat = 0.15;
    float x = min(cor.r, min(cor.g, cor.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    cor -= offset;
    float pico = max(cor.r, max(cor.g, cor.b));
    if (pico < inicio) return cor;
    float d = 1.0 - inicio;
    float novoPico = 1.0 - d * d / (pico + d - inicio);
    cor *= novoPico / pico;
    float g = 1.0 - 1.0 / (dessat * (pico - novoPico) + 1.0);
    return mix(cor, vec3(novoPico), g);
  }

  void main() {
    vec3 cor = texture2D(tCena, vUv).rgb;
    cor += texture2D(tBloom, vUv).rgb * uBloom;

    cor *= uExposicao;
    cor = toneMapping(cor);

    // --- Cor ---------------------------------------------------------------
    // Saturação e contraste ficam DEPOIS do tone mapping, em [0,1]: aplicá-los
    // na radiância linear muda o quanto cada canal satura e desloca a
    // calibração do espalhamento atmosférico, que foi medida no valor cru.
    float cinza = dot(cor, vec3(0.2126, 0.7152, 0.0722));
    cor = mix(vec3(cinza), cor, uSaturacao);

    // O contraste PIVOTA em 0.42, não em 0.5, e vem com um levantamento mínimo
    // das sombras. Com pivô no meio e sem esse levante, uma floresta densa perde a
    // folhagem escura inteira para o preto — a imagem fica mais dramática numa
    // captura parada e ilegível em movimento, que é onde o jogo acontece.
    cor = (cor - 0.42) * uContraste + 0.42;
    cor = max(cor, vec3(0.0)) + 0.006;

    // --- Vinheta ------------------------------------------------------------
    // Suave e larga: escurecer a borda concentra o olho no centro sem que
    // ninguém perceba que existe um efeito. A queda começa longe do centro
    // (0.62 do raio) porque uma vinheta que morde o meio da tela deixa de ser
    // enquadramento e vira um anel visível.
    vec2 p = vUv - 0.5;
    float r = length(p) * 1.414;
    cor *= mix(1.0, smoothstep(1.25, 0.62, r), uVinheta);
    cor = clamp(cor, 0.0, 1.0);

    // --- Grão ---------------------------------------------------------------
    // Ruído de amplitude minúscula, com papel técnico e não estético: quebra o
    // BANDING dos degradês grandes (céu, névoa, água profunda) que aparece
    // quando 8 bits por canal não bastam para uma rampa suave.
    //
    // A máscara por luminância é o que separa isso de "ruído de sensor": no
    // preto do espaço não há banding para quebrar, e um grão uniforme deixava o
    // fundo do mapa galáctico chuviscando. O ruído entra onde há sinal.
    float luz = dot(cor, vec3(0.2126, 0.7152, 0.0722));
    float mascara = smoothstep(0.02, 0.22, luz);
    float n = fract(sin(dot(vUv * uTempo, vec2(12.9898, 78.233))) * 43758.5453);
    cor += (n - 0.5) * uGrao * mascara;

    gl_FragColor = vec4(cor, 1.0);
    #include <colorspace_fragment>
  }
`;

/** Um quad de tela cheia reaproveitado por todos os passes. */
function criarQuad() {
  const geometria = new THREE.BufferGeometry();
  geometria.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)
  );
  geometria.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return geometria;
}

export class PostProcess {
  constructor() {
    this.geometria = criarQuad();
    this.cena = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    const material = (fragmentShader, uniforms) =>
      new THREE.ShaderMaterial({ vertexShader: VERTICE, fragmentShader, uniforms, depthTest: false, depthWrite: false });

    this.matBrilho = material(BRILHO, {
      tCena: { value: null },
      // 1.0 = só o que já estoura o branco entra no bloom. Abaixo disso o
      // terreno inteiro começa a brilhar e a cena perde contraste.
      uLimiar: { value: 1.05 },
      uJoelho: { value: 0.6 },
    });

    this.matBorrao = material(BORRAO, {
      tCena: { value: null },
      uDirecao: { value: new THREE.Vector2() },
    });

    this.matSoma = material(SOMA, { tCena: { value: null }, tMenor: { value: null } });

    this.matComposicao = material(COMPOSICAO, {
      tCena: { value: null },
      tBloom: { value: null },
      uBloom: { value: 0.55 },
      uExposicao: { value: 1 },
      uVinheta: { value: 0.26 },
      uSaturacao: { value: 1.05 },
      uContraste: { value: 1.03 },
      uGrao: { value: 0.008 },
      uTempo: { value: 1 },
    });

    this.malha = new THREE.Mesh(this.geometria, this.matComposicao);
    this.malha.frustumCulled = false;
    this.cena.add(this.malha);

    /** Pares de alvos por nível (o borrão separável precisa de ida e volta). */
    this.niveis = [];
    for (let i = 0; i < NIVEIS; i++) {
      this.niveis.push({
        a: this._alvo(),
        b: this._alvo(),
      });
    }
  }

  _alvo() {
    // HalfFloat: o bloom trabalha em radiância, e valores acima de 1 são
    // justamente o que ele existe para capturar.
    return new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
  }

  /** @param {number} largura pixels de DISPOSITIVO */
  redimensionar(largura, altura) {
    for (let i = 0; i < NIVEIS; i++) {
      // Metade da resolução já no primeiro nível: o bloom é, por definição, um
      // sinal de baixa frequência, e ninguém distingue um halo em resolução
      // plena de um em meia.
      const escala = 2 ** (i + 1);
      const l = Math.max(1, Math.round(largura / escala));
      const a = Math.max(1, Math.round(altura / escala));
      this.niveis[i].a.setSize(l, a);
      this.niveis[i].b.setSize(l, a);
    }
  }

  _desenhar(renderer, material, alvo) {
    this.malha.material = material;
    renderer.setRenderTarget(alvo);
    renderer.render(this.cena, this.camera);
  }

  /**
   * Roda a cadeia inteira e escreve na tela.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} textura cena em radiância LINEAR, já com atmosfera
   * @param {number} exposicao
   */
  render(renderer, textura, exposicao) {
    const alvoAntes = renderer.getRenderTarget();

    // 1. Extrai o que brilha, já em meia resolução.
    this.matBrilho.uniforms.tCena.value = textura;
    this._desenhar(renderer, this.matBrilho, this.niveis[0].a);

    // 2. Descida: cada nível borra o anterior numa resolução menor.
    for (let i = 0; i < NIVEIS; i++) {
      const nivel = this.niveis[i];
      if (i > 0) {
        this.matBorrao.uniforms.tCena.value = this.niveis[i - 1].a.texture;
        this.matBorrao.uniforms.uDirecao.value.set(1 / nivel.a.width, 0);
        this._desenhar(renderer, this.matBorrao, nivel.b);
      } else {
        this.matBorrao.uniforms.tCena.value = nivel.a.texture;
        this.matBorrao.uniforms.uDirecao.value.set(1 / nivel.a.width, 0);
        this._desenhar(renderer, this.matBorrao, nivel.b);
      }
      this.matBorrao.uniforms.tCena.value = nivel.b.texture;
      this.matBorrao.uniforms.uDirecao.value.set(0, 1 / nivel.a.height);
      this._desenhar(renderer, this.matBorrao, nivel.a);
    }

    // 3. Subida: soma cada nível pequeno no de cima. O upsample é o próprio
    //    filtro bilinear da GPU, que já suaviza o degrau de resolução.
    for (let i = NIVEIS - 1; i > 0; i--) {
      this.matSoma.uniforms.tCena.value = this.niveis[i - 1].a.texture;
      this.matSoma.uniforms.tMenor.value = this.niveis[i].a.texture;
      this._desenhar(renderer, this.matSoma, this.niveis[i - 1].b);
      // O resultado passa a ser o `b` deste nível; troca as referências para o
      // próximo passo ler do lugar certo sem copiar textura.
      const t = this.niveis[i - 1].a;
      this.niveis[i - 1].a = this.niveis[i - 1].b;
      this.niveis[i - 1].b = t;
    }

    // 4. Composição na tela.
    this.matComposicao.uniforms.tCena.value = textura;
    this.matComposicao.uniforms.tBloom.value = this.niveis[0].a.texture;
    this.matComposicao.uniforms.uExposicao.value = exposicao;
    this._desenhar(renderer, this.matComposicao, null);

    renderer.setRenderTarget(alvoAntes);
  }

  dispose() {
    this.geometria.dispose();
    for (const m of [this.matBrilho, this.matBorrao, this.matSoma, this.matComposicao]) m.dispose();
    for (const n of this.niveis) {
      n.a.dispose();
      n.b.dispose();
    }
  }
}
