/**
 * Perspectiva aérea: a atmosfera desenhada SOBRE o terreno, lendo o depth
 * buffer num pass de tela cheia.
 *
 * ---------------------------------------------------------------------------
 * O QUE ISTO SUBSTITUI
 * ---------------------------------------------------------------------------
 * A casca de atmosfera (AtmosphereShader.js) resolve o céu: ela integra o
 * espalhamento no trecho do raio que NÃO tem geometria. O que estava entre a
 * câmera e uma montanha a 5 km continuava sendo aproximado por um FogExp2
 * pintado com a cor média do céu — uma névoa cinza uniforme, que não escurece
 * com a distância do jeito certo, não avermelha no poente e não sabe que o ar
 * rareia com a altitude.
 *
 * Este pass fecha o buraco: para cada pixel COM geometria, reconstrói a posição
 * de mundo a partir da profundidade e integra o mesmo espalhamento da casca no
 * trecho câmera -> superfície. O resultado é
 *
 *     cor_final = cor_do_terreno * transmitância + inscatter
 *
 * que é a equação de transporte de verdade, não um lerp para uma cor de névoa.
 * Montanha distante fica azulada de dia e alaranjada no poente **porque a luz
 * atravessou mais ar**, e não porque alguém escolheu a cor.
 *
 * ---------------------------------------------------------------------------
 * SÓ VALE DENTRO DA ATMOSFERA — E O MOTIVO NÃO É PERFORMANCE
 * ---------------------------------------------------------------------------
 * É para não contar o mesmo espalhamento duas vezes.
 *
 *   - Câmera DENTRO da casca: ela é desenhada com BackSide, e suas faces
 *     ficam atrás do terreno — o depth test as descarta em cima de qualquer
 *     pixel com geometria. Logo, nesses pixels não há espalhamento nenhum, e
 *     este pass é quem o fornece.
 *   - Câmera FORA: a casca vira FrontSide e passa a cobrir o disco do
 *     planeta, inscatter incluso. Aplicar o pass ali somaria a mesma luz de
 *     novo, e o planeta lavaria.
 *
 * uStrength faz a transição em rampa dentro da metade superior da atmosfera,
 * em vez de um liga-desliga no exato raio da casca.
 *
 * ---------------------------------------------------------------------------
 * A ARMADILHA: DEPTH LOGARÍTMICO
 * ---------------------------------------------------------------------------
 * O projeto usa logarithmicDepthBuffer: true, então o valor gravado NÃO é o
 * z/w clássico e a reconstrução padrão devolve lixo. O Three grava
 *
 *     d = log2(1 + w) * FC * 0.5,   com  FC = 2 / log2(far + 1)
 *
 * onde w é o próprio gl_Position.w — que, numa câmera perspectiva, é a
 * distância ao longo do eixo de visão. Invertendo:
 *
 *     w = exp2(2d / FC) - 1
 *
 * Daí a posição de vista sai sem precisar da inversa da projeção: basta
 * multiplicar a direção do pixel (com z = -1) por w. Menos operações e sem o
 * cancelamento catastrófico que a inversa produz perto do plano far.
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { SCATTERING_GLSL } from './scattering.glsl.js';

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;

  #include <common>

  varying vec2 vUv;

  uniform sampler2D tColor;
  uniform sampler2D tDepth;

  uniform float uLogDepthFC;     // 2 / log2(far + 1)
  uniform float uTanHalfFov;
  uniform float uAspect;
  uniform mat4  uCameraMatrix;   // matrixWorld da câmera (vista -> mundo)
  uniform vec3  uCameraPosition;

  uniform vec3  uPlanetCenter;
  uniform float uPlanetRadius;
  uniform float uAtmosphereRadius;
  uniform vec3  uSunDirection;
  uniform vec3  uRayleigh;
  uniform vec3  uMie;
  uniform float uDensity;
  uniform float uScaleHeight;
  uniform float uSunIntensity;
  uniform float uMieG;

  uniform float uStrength;       // 0 = fora da atmosfera, 1 = bem dentro
  uniform float uExposure;
  uniform float uSaidaLinear;  // 1 = entrega radiancia crua para o pos-processamento
  uniform int   uDebug;          // 1 = mostra a distância reconstruída
  uniform float uDebugScale;     // unidades por branco total, no modo acima
  uniform float uBoost;          // escala de jogo da profundidade óptica

  ${SCATTERING_GLSL}

  const int STEPS = 10;
  const int SUN_STEPS = 2;

  /**
   * Khronos PBR Neutral, reimplementado aqui.
   *
   * O Three aplica tone mapping DENTRO de cada material, mas a cena agora é
   * renderizada para um alvo linear com o tone mapping desligado — senão o
   * espalhamento seria somado a cores já comprimidas, e o poente estouraria em
   * branco justamente onde ele é mais bonito. Comprimir é a última coisa que
   * acontece, aqui.
   */
  vec3 neutralToneMapping(vec3 color) {
    const float StartCompression = 0.8 - 0.04;
    const float Desaturation = 0.15;
    float x = min(color.r, min(color.g, color.b));
    float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
    color -= offset;
    float peak = max(color.r, max(color.g, color.b));
    if (peak < StartCompression) return color;
    float d = 1.0 - StartCompression;
    float newPeak = 1.0 - d * d / (peak + d - StartCompression);
    color *= newPeak / peak;
    float g = 1.0 - 1.0 / (Desaturation * (peak - newPeak) + 1.0);
    return mix(color, vec3(newPeak), g);
  }

  void main() {
    vec3 color = texture2D(tColor, vUv).rgb;
    float depth = texture2D(tDepth, vUv).x;

    // 1.0 = nada gravou profundidade ali: é céu, e a casca de atmosfera já fez
    // o trabalho. Sair cedo economiza a marcha inteira na maior parte da tela
    // quando se olha para cima.
    bool hasGeometry = depth < 1.0;

    // Nos modos de conferência, pixel SEM geometria sai preto. Sem esta
    // sentinela o céu passa direto pela composição e vira um valor qualquer no
    // meio do mapa de debug — foi assim que uma medição minha "achou" um
    // terreno a 341 unidades que era, na verdade, a cor do horizonte.
    if (uDebug > 0 && !hasGeometry) {
      gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
      return;
    }

    if (hasGeometry && uStrength > 0.001) {
      // --- Reconstrução da posição ---------------------------------------
      float w = exp2(2.0 * depth / uLogDepthFC) - 1.0;

      vec2 ndc = vUv * 2.0 - 1.0;
      vec3 viewDir = vec3(ndc.x * uTanHalfFov * uAspect, ndc.y * uTanHalfFov, -1.0);
      vec3 viewPos = viewDir * w;
      vec3 worldPos = (uCameraMatrix * vec4(viewPos, 1.0)).xyz;

      // Modo de conferência: a distância reconstruída sai como tom de cinza.
      // É o único jeito de provar que a inversão do depth logarítmico está
      // certa — basta comparar o pixel central com uma distância que o jogo
      // já conhece (a altitude, olhando para baixo).
      if (uDebug == 1) {
        float d = length(worldPos - uCameraPosition);
        gl_FragColor = vec4(vec3(d / uDebugScale), 1.0);
        return;
      }

      // --- Integração câmera -> superfície --------------------------------
      vec3 ro = uCameraPosition - uPlanetCenter;
      vec3 segment = worldPos - uCameraPosition;
      float distance = length(segment);
      vec3 rd = segment / max(distance, 1e-5);

      float thickness = uAtmosphereRadius - uPlanetRadius;

      // O trecho a integrar é o pedaço do raio que está DENTRO da casca. Da
      // superfície olhando para o horizonte ele é o raio inteiro; de dentro de
      // um vale olhando para cima, quase nada.
      vec2 hit = raySphere(ro, rd, uAtmosphereRadius);
      float tNear = max(hit.x, 0.0);
      float tFar = min(hit.y, distance);

      if (tFar > tNear) {
        float step = (tFar - tNear) / float(STEPS);
        // ---------------------------------------------------------------
        // O FATOR DE ESCALA DE JOGO.
        //
        // Aqui a física estava certa e o resultado, invisível. Medido a 60 u
        // do solo, olhando o horizonte: a extinção tirava 37% do azul a
        // 1 km... e o inscatter repunha quase o mesmo tanto, deixando 3
        // níveis de diferença em 255. Correto e inútil.
        //
        // O motivo não é o modelo, é a ESCALA: este planeta tem 2,5 km de
        // raio contra os 6 371 km da Terra. Um vale inteiro aqui cabe num
        // quarteirão de lá, e perspectiva aérea a 500 m de distância é
        // genuinamente imperceptível no mundo real também.
        //
        // uBoost multiplica a profundidade óptica do trecho — é o mesmo que
        // dizer que o ar deste planeta é várias vezes mais denso do que a
        // altura da atmosfera sugere. Extinção e inscatter crescem JUNTOS,
        // então a relação entre eles (que é o que dá a cor) continua a da
        // física; o que muda é só a distância em que o efeito aparece.
        // ---------------------------------------------------------------
        float stepNorm = step / thickness * uBoost;

        vec3 betaR = uRayleigh * uDensity;
        vec3 betaM = uMie * uDensity * 0.12;

        vec3 accumR = vec3(0.0);
        vec3 accumM = vec3(0.0);
        float opticalDepthView = 0.0;

        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * (tNear + (float(i) + 0.5) * step);
          float density = airDensity(p, uPlanetRadius, thickness, uScaleHeight) * stepNorm;
          opticalDepthView += density;

          vec2 sunExit = raySphere(p, uSunDirection, uAtmosphereRadius);
          float sunStep = max(sunExit.y, 0.0) / float(SUN_STEPS);
          float opticalDepthSun = 0.0;
          for (int j = 0; j < SUN_STEPS; j++) {
            vec3 sp = p + uSunDirection * ((float(j) + 0.5) * sunStep);
            opticalDepthSun += airDensity(sp, uPlanetRadius, thickness, uScaleHeight) * (sunStep / thickness);
          }

          vec3 transmittance = exp(-(betaR + betaM) * (opticalDepthSun + opticalDepthView));
          float shadow = planetShadow(p, uSunDirection, uPlanetRadius);

          accumR += transmittance * density * shadow;
          accumM += transmittance * density * shadow;
        }

        float mu = dot(rd, uSunDirection);
        vec3 inscatter = (accumR * betaR * phaseRayleigh(mu) +
                          accumM * betaM * phaseMie(mu, uMieG)) * uSunIntensity;

        // A EQUAÇÃO. viewTransmittance é quanto da luz do terreno sobreviveu
        // ao caminho até o olho; o inscatter é a luz do sol que entrou no
        // caminho pelo meio. Somar sem atenuar (o que a névoa aditiva faz)
        // deixa a montanha distante mais BRILHANTE que a próxima.
        vec3 viewTransmittance = exp(-(betaR + betaM) * opticalDepthView);

        if (uDebug == 2) { gl_FragColor = vec4(viewTransmittance, 1.0); return; }
        if (uDebug == 3) { gl_FragColor = vec4(inscatter * 4.0, 1.0); return; }

        color = color * mix(vec3(1.0), viewTransmittance, uStrength)
              + inscatter * uStrength;
      }
    }

    // Modo 4: radiancia linear CRUA, sem exposicao, tone mapping ou sRGB.
    // E a unica forma de comparar o que entra no tone mapping com o que o
    // Three produzia quando ele morava dentro de cada material.
    if (uDebug == 4) { gl_FragColor = vec4(color, 1.0); return; }

    // -----------------------------------------------------------------------
    // SAÍDA LINEAR quando há pós-processamento depois daqui.
    //
    // O bloom precisa de radiância CRUA: somar um halo a um pixel já comprimido
    // para [0,1] não tem para onde crescer, e o brilho vira uma mancha
    // acinzentada. Com uSaidaLinear ligado, este passe entrega a cena como ela
    // é e quem expõe, comprime e converte para sRGB é o PostProcess.
    //
    // Sem pós-processamento (WebGL1, ?post=off), o caminho antigo continua
    // valendo — este passe é o último da fila e fecha a conta aqui mesmo.
    // -----------------------------------------------------------------------
    if (uSaidaLinear > 0.5) {
      gl_FragColor = vec4(color, 1.0);
      return;
    }

    color *= uExposure;
    color = neutralToneMapping(color);
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

export class AerialPerspective {
  constructor() {
    this.uniforms = {
      tColor: { value: null },
      tDepth: { value: null },
      uLogDepthFC: { value: 1 },
      uTanHalfFov: { value: 1 },
      uAspect: { value: 1 },
      uCameraMatrix: { value: new THREE.Matrix4() },
      uCameraPosition: { value: new THREE.Vector3() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uPlanetRadius: { value: 1 },
      uAtmosphereRadius: { value: 2 },
      uSunDirection: { value: new THREE.Vector3(1, 0, 0) },
      uRayleigh: { value: new THREE.Vector3() },
      uMie: { value: new THREE.Vector3() },
      uDensity: { value: 1 },
      uScaleHeight: { value: 0.22 },
      uSunIntensity: { value: 4 },
      uMieG: { value: 0.76 },
      uStrength: { value: 0 },
      uExposure: { value: 1 },
      uSaidaLinear: { value: 0 },
      uDebug: { value: 0 },
      uDebugScale: { value: 4000 },
      // Calibrado por medição: ver a tabela de transmitância no README.
      uBoost: { value: 4.5 },
    };

    // ShaderMaterial, nunca RawShaderMaterial. O material cru não recebe o
    // prefixo que o Three gera, e o prefixo é justamente quem declara os
    // atributos position/uv do quad e a função linearToOutputTexel() que
    // o <colorspace_fragment> usa. Com Raw, este shader não compila.
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new FullScreenQuad(this.material);
  }

  /**
   * Parâmetros que dependem da câmera. far entra na constante do depth
   * logarítmico e PRECISA ser o mesmo valor com que a cena foi desenhada —
   * o near dinâmico do Engine não afeta, mas trocar o far sim.
   *
   * @param {THREE.PerspectiveCamera} camera
   */
  setCamera(camera) {
    const u = this.uniforms;
    u.uLogDepthFC.value = 2 / (Math.log(camera.far + 1) / Math.LN2);
    u.uTanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5));
    u.uAspect.value = camera.aspect;
    u.uCameraMatrix.value.copy(camera.matrixWorld);
    u.uCameraPosition.value.copy(camera.position);
  }

  /**
   * Parâmetros do corpo sob a câmera.
   *
   * @param {object} config saída de createPlanetConfig()
   * @param {THREE.Vector3} center posição do planeta na cena
   * @param {THREE.Vector3} sunDirection
   * @param {number} distance distância da câmera ao centro do planeta
   */
  setPlanet(config, center, sunDirection, distance) {
    const u = this.uniforms;
    const atmosphereRadius = config.radius + config.atmosphere.height;

    u.uPlanetCenter.value.copy(center);
    u.uPlanetRadius.value = config.radius;
    u.uAtmosphereRadius.value = atmosphereRadius;
    u.uSunDirection.value.copy(sunDirection);
    // As MESMAS escalas calibradas da casca (ver AtmosphereShader.js): os dois
    // integram trechos vizinhos do mesmo raio e precisam do mesmo coeficiente,
    // senão aparece uma emenda de cor na silhueta do relevo.
    u.uRayleigh.value.fromArray(config.atmosphere.rayleigh).multiplyScalar(0.45);
    u.uMie.value.fromArray(config.atmosphere.mie).multiplyScalar(0.4);
    u.uDensity.value = config.atmosphere.density;
    u.uScaleHeight.value = config.atmosphere.scaleHeight;

    // Rampa: 0 no raio da casca, 1 na metade de baixo da atmosfera. Evita o
    // "pop" na fronteira e cobre a faixa em que a casca ainda desenha um
    // pouco por cima do terreno.
    u.uStrength.value = THREE.MathUtils.clamp(
      (atmosphereRadius - distance) / (config.atmosphere.height * 0.5),
      0,
      1
    );
  }

  render(renderer, colorTexture, depthTexture, exposure) {
    this.uniforms.tColor.value = colorTexture;
    this.uniforms.tDepth.value = depthTexture;
    this.uniforms.uExposure.value = exposure;
    this.quad.render(renderer);
  }

  dispose() {
    this.quad.dispose();
    this.material.dispose();
  }
}
