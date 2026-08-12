/**
 * Atmosfera por single scattering (Rayleigh + Mie), aproximada em tempo real.
 *
 * COMO FUNCIONA
 * Renderizamos uma esfera maior que o planeta com `side: BackSide`. Para cada
 * pixel dessa casca, o fragment shader traça o raio câmera->pixel, corta o
 * trecho que está dentro da atmosfera e integra numericamente quanta luz do
 * sol é espalhada em direção à câmera ao longo desse trecho.
 *
 *   - Rayleigh (moléculas): espalha o azul ~5,5x mais que o vermelho.
 *     É o que pinta o céu de azul e o pôr do sol de laranja — no pôr do sol a
 *     luz atravessa muito mais ar, o azul se esgota e sobra o vermelho.
 *   - Mie (aerossóis/poeira): espalhamento para frente, cria o halo branco
 *     ao redor do disco solar.
 *
 * GEOMETRIA: A FACE DA CASCA MUDA COM A POSIÇÃO DA CÂMERA
 * Este é o detalhe que separa "atmosfera" de "anel de neon em volta do
 * planeta". Ver `Planet.setAtmosphereSide()`:
 *
 *   - Câmera FORA da casca  -> `FrontSide`. As faces frontais ficam ENTRE a
 *     câmera e o planeta, passam no depth test e a atmosfera é desenhada
 *     por cima do disco: névoa no limbo, terminador suave, halo. Usar
 *     `BackSide` aqui é o erro clássico — as faces traseiras ficam atrás do
 *     planeta, o depth test as descarta sobre todo o disco e só sobra o anel
 *     que "vaza" pelas bordas.
 *
 *   - Câmera DENTRO da casca -> `BackSide`. As faces frontais ficariam atrás
 *     da câmera e nada seria desenhado; as traseiras pintam o céu acima do
 *     horizonte, e o terreno as oclui corretamente via depth test.
 *
 * A oclusão pelo planeta é resolvida analiticamente no shader (o raio é
 * cortado no ponto onde atinge a esfera sólida), não pelo depth buffer — por
 * isso a troca de face não introduz nenhum artefato de ordenação.
 *
 * O que ainda falta em relação a uma solução definitiva é a névoa atmosférica
 * SOBRE o terreno distante, que exigiria ler o depth buffer num pass de tela
 * cheia. Aproximamos com o `FogExp2` da cena (ver `GameState.js`), pintado com
 * a mesma cor — ver README para o caminho completo.
 */

import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec3 vWorldPosition;

  #include <common>
  #include <logdepthbuf_pars_vertex>

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;

    gl_Position = projectionMatrix * viewMatrix * worldPosition;

    #include <logdepthbuf_vertex>
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  varying vec3 vWorldPosition;

  uniform vec3  uPlanetCenter;
  uniform float uPlanetRadius;
  uniform float uAtmosphereRadius;
  uniform vec3  uSunDirection;   // do planeta em direção ao sol, normalizado
  uniform vec3  uRayleigh;       // coeficientes de espalhamento por canal
  uniform vec3  uMie;
  uniform float uDensity;
  uniform float uScaleHeight;    // fração da espessura em que a densidade cai 1/e
  uniform float uSunIntensity;
  uniform float uMieG;           // anisotropia do Mie (0 = isotrópico, ->1 frontal)

  #include <common>
  #include <logdepthbuf_pars_fragment>
  // Sem os includes "_pars_" de tonemapping/colorspace aqui: o Three.js JÁ
  // injeta essas declarações no prefixo de todo fragment shader, inclusive de
  // ShaderMaterial. Incluí-las de novo dá erro de redefinição de função.
  // O que ele NÃO injeta é a APLICAÇÃO delas — feita no fim do main().

  const int VIEW_STEPS = 12;
  const int SUN_STEPS  = 3;

  /**
   * Interseção raio/esfera centrada na origem.
   * Devolve vec2(tEntrada, tSaida); x > y significa "sem interseção".
   */
  vec2 raySphere(vec3 origin, vec3 dir, float radius) {
    float b = dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
  }

  /** Densidade relativa do ar na altitude do ponto (perfil exponencial). */
  float densityAt(vec3 p, float thickness) {
    float h = (length(p) - uPlanetRadius) / thickness;
    return exp(-clamp(h, 0.0, 1.0) / uScaleHeight);
  }

  /**
   * Sombra do próprio planeta sobre um ponto da atmosfera.
   * É o que cria o terminador (a linha dia/noite) em vez de um planeta
   * uniformemente iluminado. A borda é suavizada de propósito: a penumbra real
   * tem centenas de km e um corte duro parece um recorte de papel.
   */
  float sunShadow(vec3 p) {
    float along = dot(p, uSunDirection);
    if (along > 0.0) return 1.0;                       // ponto no lado iluminado
    float perpendicular = length(p - uSunDirection * along);
    return smoothstep(uPlanetRadius * 0.985, uPlanetRadius * 1.03, perpendicular);
  }

  void main() {
    #include <logdepthbuf_fragment>

    float thickness = uAtmosphereRadius - uPlanetRadius;

    // Trabalhamos com o planeta na origem: menos operações e melhor precisão
    // do que carregar o centro absoluto em cada conta.
    vec3 rayOrigin = cameraPosition - uPlanetCenter;
    vec3 rayDir = normalize(vWorldPosition - cameraPosition);

    vec2 atmoHit = raySphere(rayOrigin, rayDir, uAtmosphereRadius);
    if (atmoHit.x > atmoHit.y) discard;

    float tNear = max(atmoHit.x, 0.0);   // câmera pode já estar dentro da casca
    float tFar  = atmoHit.y;

    // O planeta bloqueia o resto do raio: a atmosfera "atrás" dele não conta.
    vec2 planetHit = raySphere(rayOrigin, rayDir, uPlanetRadius);
    if (planetHit.x <= planetHit.y && planetHit.y > 0.0) {
      tFar = min(tFar, max(planetHit.x, 0.0));
    }

    if (tFar <= tNear) discard;

    // Comprimentos normalizados pela espessura da atmosfera: mantém os números
    // em O(1) e torna os coeficientes independentes da escala do planeta.
    float segment = (tFar - tNear) / float(VIEW_STEPS);
    float segmentNorm = segment / thickness;

    vec3 betaR = uRayleigh * uDensity;
    vec3 betaM = uMie * uDensity * 0.12;

    vec3 accumR = vec3(0.0);
    vec3 accumM = vec3(0.0);
    float opticalDepthView = 0.0;

    for (int i = 0; i < VIEW_STEPS; i++) {
      vec3 p = rayOrigin + rayDir * (tNear + (float(i) + 0.5) * segment);
      float density = densityAt(p, thickness) * segmentNorm;
      opticalDepthView += density;

      // Profundidade óptica do ponto até o sol (por que a luz chega avermelhada
      // ao rasante). 3 amostras bastam: o perfil é suave.
      vec2 sunExit = raySphere(p, uSunDirection, uAtmosphereRadius);
      float sunStep = max(sunExit.y, 0.0) / float(SUN_STEPS);
      float opticalDepthSun = 0.0;
      for (int j = 0; j < SUN_STEPS; j++) {
        vec3 sp = p + uSunDirection * ((float(j) + 0.5) * sunStep);
        opticalDepthSun += densityAt(sp, thickness) * (sunStep / thickness);
      }

      vec3 transmittance = exp(-(betaR + betaM) * (opticalDepthSun + opticalDepthView));
      float shadow = sunShadow(p);

      accumR += transmittance * density * shadow;
      accumM += transmittance * density * shadow;
    }

    // Funções de fase: como o espalhamento se distribui pelo ângulo entre o
    // raio de visão e o raio do sol.
    float mu = dot(rayDir, uSunDirection);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);

    float g = uMieG;
    float g2 = g * g;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) /
                   ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));

    vec3 inscatter = (accumR * betaR * phaseR + accumM * betaM * phaseM) * uSunIntensity;

    // ---------------------------------------------------------------------
    // COMPOSIÇÃO: transmitância, não blending aditivo.
    //
    // Aditivo só SOMA luz e nunca atenua o que está atrás — a atmosfera fica
    // ilimitada e, no pior caso (planeta de face cheia, sol atrás da câmera,
    // retroespalhamento Rayleigh no máximo), o disco inteiro satura em branco.
    //
    // O resultado correto é  cor = inscatter + fundo * transmitância.
    //
    // Emitimos ALFA PRÉ-MULTIPLICADO (material.premultipliedAlpha = true), em
    // que o blending vale  src.rgb + dst.rgb*(1 - src.a).  Basta então:
    //     src.rgb = inscatter          (já é a radiância emitida)
    //     src.a   = 1 - transmitância  (quanto a atmosfera oculta o fundo)
    //
    // Dividir por alfa para usar blending não pré-multiplicado seria pior: o
    // tone mapping é não-linear, então tonemap(inscatter/a)*a ≠ tonemap(...),
    // e regiões de baixa opacidade ficariam claras demais.
    //
    // Com isso o brilho é limitado pela própria física: caminho curto (nadir)
    // => quase transparente, a superfície aparece; caminho longo (limbo) =>
    // opaco, vê-se só o céu. Sem número mágico para segurar o estouro.
    // ---------------------------------------------------------------------
    vec3 transmittanceView = exp(-(betaR + betaM) * opticalDepthView);
    float opacity = clamp(1.0 - dot(transmittanceView, vec3(0.3333)), 0.0, 1.0);

    gl_FragColor = vec4(inscatter, opacity);

    // ---------------------------------------------------------------------
    // Estes dois includes NÃO são opcionais, e a falta deles é uma armadilha
    // silenciosa: o Three.js APLICA tone mapping e conversão para sRGB
    // automaticamente nos materiais nativos, mas nunca num ShaderMaterial.
    // Sem eles a atmosfera despeja valores lineares crus no framebuffer —
    // ignora a exposição da cena, satura os canais e o céu perde o matiz
    // (azul e verde chegam juntos no teto). Com eles, a atmosfera passa pelo
    // mesmo pipeline de cor do terreno ao lado.
    // ---------------------------------------------------------------------
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/**
 * @param {object} config saída de `createPlanetConfig()`
 * @returns {{ mesh: THREE.Mesh, uniforms: object }}
 */
export function createAtmosphere(config) {
  const atmosphereRadius = config.radius + config.atmosphere.height;

  // ---------------------------------------------------------------------
  // CALIBRAÇÃO — valores medidos, não chutados.
  //
  // Estes três números foram ajustados amostrando o framebuffer em dois
  // pontos de vista extremos, porque cada um falha de um jeito diferente:
  //
  //   1) Órbita, planeta de face cheia (sol atrás da câmera). Pior caso de
  //      brilho: o retroespalhamento Rayleigh está no máximo e o caminho até
  //      o sol coincide com o caminho de visão, então quase nada é extinto.
  //      Errar para cima aqui apaga o planeta sob um cobertor ciano.
  //
  //   2) Superfície, olhando o horizonte. Pior caso de profundidade óptica:
  //      o caminho tangencial é ~9x o caminho radial. Errar para baixo aqui
  //      deixa o céu preto de dia.
  //
  // Referência de medição (seed 12345, centro do disco em órbita):
  //   sem atmosfera .............. (132, 56, 22)   -- laranja do solo
  //   escala 1.6 / intensidade 26  (220,254,253)   -- estourado, planeta some
  //   escala 0.45 / intensidade 4  (120,100, 84)   -- névoa sutil, cor preservada
  //
  // A escala BAIXA importa por si só: ela controla quanto a atmosfera ATENUA
  // a superfície por trás. Com escala alta, mesmo compensando o brilho, o
  // vermelho do solo é absorvido e todo planeta vira cinza-azulado.
  const RAYLEIGH_SCALE = 0.45;
  const MIE_SCALE = 0.40;

  const uniforms = {
    uPlanetCenter: { value: new THREE.Vector3() },
    uPlanetRadius: { value: config.radius },
    uAtmosphereRadius: { value: atmosphereRadius },
    uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
    uRayleigh: {
      value: new THREE.Vector3().fromArray(config.atmosphere.rayleigh).multiplyScalar(RAYLEIGH_SCALE),
    },
    uMie: {
      value: new THREE.Vector3().fromArray(config.atmosphere.mie).multiplyScalar(MIE_SCALE),
    },
    uDensity: { value: config.atmosphere.density },
    uScaleHeight: { value: config.atmosphere.scaleHeight },
    uSunIntensity: { value: 4 },
    uMieG: { value: 0.76 },
  };

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms,
    // Alternado em tempo real por `Planet.setAtmosphereSide()`.
    side: THREE.FrontSide,
    transparent: true,
    depthWrite: false,
    // NormalBlending + premultipliedAlpha: o blending vira
    // `src.rgb + dst.rgb * (1 - src.a)`, que é exatamente
    // `inscatter + fundo * transmitância`.
    blending: THREE.NormalBlending,
    premultipliedAlpha: true,
  });

  // A tesselação só precisa cobrir a tela sem "quinas" na silhueta — todo o
  // detalhe vem do ray marching no fragment shader, não da geometria.
  const geometry = new THREE.SphereGeometry(atmosphereRadius, 64, 48);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 10; // depois do terreno opaco

  return { mesh, uniforms };
}
