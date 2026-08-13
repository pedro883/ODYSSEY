/**
 * Balanço de vento para vegetação instanciada.
 *
 * Um `onBeforeCompile` que injeta um deslocamento senoidal no vértice, antes
 * de `project_vertex`. Três decisões merecem nota:
 *
 * 1. NO ESPAÇO DO OBJETO, não no de mundo. A geometria dos props é normalizada
 *    com a base em y=0 e altura 1 (ver `AssetLibrary._flatten()`), e cada
 *    instância é girada para ficar perpendicular à superfície da esfera. No
 *    espaço do objeto, portanto, "para cima" é sempre +Y e "quanto o vértice
 *    balança" é literalmente `transformed.y` — a copa oscila, a base não sai
 *    do lugar. No espaço de mundo seria preciso reconstruir o "para cima"
 *    local por vértice, o que custa uma normalização e ainda erra no polo.
 *
 * 2. A FASE VEM DA MATRIZ DE INSTÂNCIA. Sem isso, todas as árvores do planeta
 *    balançam em uníssono e o efeito lê como terremoto, não como vento. A
 *    coluna de translação de `instanceMatrix` é única por planta e já está
 *    disponível no vertex shader — não custa nem um atributo a mais.
 *
 * 3. DUAS FREQUÊNCIAS SOMADAS. Uma senóide só produz um metrônomo. A segunda,
 *    mais rápida e mais fraca, quebra a periodicidade o suficiente para o olho
 *    parar de contar os ciclos.
 *
 * O uniforme de tempo é COMPARTILHADO por todos os materiais (um objeto só,
 * atualizado uma vez por frame em `main.js`); cada material apenas aponta para
 * ele. Atualizar N materiais por frame seria trabalho proporcional ao número
 * de espécies, por nada.
 */

/** Uniforme global de tempo. Atualizado uma vez por frame. */
export const windTime = { value: 0 };

/**
 * @param {import('three').Material} material
 * @param {number} amplitude deslocamento no topo, em frações da altura
 * @param {number} speed multiplicador de frequência
 */
export function applyWind(material, amplitude = 0.05, speed = 1) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.uniforms.uWindAmplitude = { value: amplitude };
    shader.uniforms.uWindSpeed = { value: speed };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uWindTime;
        uniform float uWindAmplitude;
        uniform float uWindSpeed;
        `
      )
      .replace(
        '#include <project_vertex>',
        /* glsl */ `
        {
          // Fase por instância. Fora do caminho instanciado (fallback de
          // primitivas, se algum dia houver), a fase vira constante e a planta
          // solitária balança sozinha — o que é exatamente o certo.
          #ifdef USE_INSTANCING
            float phase = dot(instanceMatrix[3].xyz, vec3(0.31, 0.17, 0.23));
          #else
            float phase = 0.0;
          #endif

          float t = uWindTime * uWindSpeed;
          // max(transformed.y, 0.0): um vértice abaixo da base (raiz exposta,
          // saia de geometria) não deve ser puxado para o lado oposto.
          float lever = max(transformed.y, 0.0) * uWindAmplitude;
          float sway = sin(t * 1.1 + phase) + 0.35 * sin(t * 2.7 + phase * 1.7);

          transformed.x += sway * lever;
          transformed.z += cos(t * 0.9 + phase * 1.3) * lever * 0.6;
        }
        #include <project_vertex>
        `
      );
  };

  // Sem isso o Three reaproveita o programa já compilado do material anterior
  // (a chave do cache não inclui o corpo do `onBeforeCompile`) e o vento
  // simplesmente não aparece em alguns materiais.
  material.customProgramCacheKey = () => `wind-${amplitude}-${speed}`;
}
