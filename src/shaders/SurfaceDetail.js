/**
 * Detalhe de superfície do terreno.
 *
 * ===========================================================================
 * O PROBLEMA: "MUITO LOW POLY, SEM TEXTURA"
 * ===========================================================================
 * O terreno é uma malha com cor por vértice. Os vértices estão a ~4 unidades um
 * do outro no nível mais fino, então a cor varia numa escala de metros e, entre
 * eles, o rasterizador só interpola: ao nível dos olhos, cada triângulo é uma
 * mancha lisa de cor chapada. É exatamente a aparência que se descreve como
 * "sem textura" — não falta resolução de malha, falta variação DENTRO do
 * triângulo.
 *
 * ===========================================================================
 * POR QUE NÃO UM BITMAP
 * ===========================================================================
 * O caminho comum seria um atlas de texturas de terreno em projeção triplanar.
 * O pacote Kenney que este projeto usa não tem esse material — a arte dele é
 * deliberadamente sem textura, com a cor vindo do material — e qualquer
 * conjunto PBR decente pesa dezenas de megabytes, num projeto cujo mundo
 * inteiro cabe em algumas centenas de quilobytes de código.
 *
 * Ruído procedural resolve o mesmo problema sem baixar nada, sem tiling
 * visível (não há tile) e com uma vantagem que bitmap não tem: a escala do grão
 * acompanha o mundo, então o chão é granulado a um metro de distância e liso a
 * dois quilômetros, sem mipmap nem LOD de textura.
 *
 * ===========================================================================
 * O QUE ENTRA NO SHADER
 * ===========================================================================
 *   1. GRÃO DE COR em três oitavas — quebra a chapa de cor plana.
 *   2. RELEVO NA NORMAL, por diferenças finitas do mesmo ruído. É o que faz a
 *      luz raspar em cascalho e o chão deixar de ser uma folha de papel. Sem
 *      isto o item 1 sozinho parece sujeira pintada.
 *   3. ATENUAÇÃO POR DISTÂNCIA: acima de algumas centenas de unidades o grão
 *      some. Não é economia — é anti-aliasing: ruído de alta frequência visto
 *      de longe vira chiado que cintila a cada frame da câmera.
 *
 * Tudo isso entra por `onBeforeCompile` no `MeshStandardMaterial` em vez de um
 * shader próprio, para não reimplementar iluminação, névoa e tone mapping — que
 * é onde uma superfície "artesanal" costuma destoar do resto da cena.
 */

/**
 * @param {import('three').MeshStandardMaterial} material material dos chunks
 * @param {object} cfg configuração do planeta
 */
export function aplicarDetalheDeSuperficie(material, cfg) {
  material.onBeforeCompile = (shader) => {
    // -----------------------------------------------------------------------
    // OS NÚMEROS APANHARAM UMA VEZ, E VALE REGISTRAR POR QUÊ.
    //
    // A primeira versão usava frequência 0.35 (feições de ~3 unidades) com
    // força 0.11 no albedo e um empurrão de 12x na normal. Na tela isso não
    // virou textura: virou CHUVISCO — pontinhos escuros espalhados por toda a
    // encosta, como poeira na lente. Dois erros somados:
    //
    //   - a variação estava quase toda no BRILHO, e mancha clara/escura em
    //     alta frequência o olho lê como sujeira, não como material;
    //   - a normal girava tanto que pixels vizinhos pegavam luz oposta, o que
    //     transforma qualquer ruído em sal-e-pimenta.
    //
    // Agora são duas escalas — uma de ~12 unidades, que dá as manchas grandes
    // de solo, e outra de ~3, que só quebra a chapa — com metade da amplitude
    // e um décimo do empurrão na normal.
    // -----------------------------------------------------------------------
    shader.uniforms.uFreqGrao = { value: 0.085 };
    shader.uniforms.uForcaGrao = { value: cfg.type === 'exótico' ? 0.085 : 0.06 };
    shader.uniforms.uForcaRelevo = { value: 1.1 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vPosMundo;
        varying float vDistCam;
        `
      )
      .replace(
        '#include <fog_vertex>',
        /* glsl */ `
        #include <fog_vertex>
        // Posição de MUNDO, e não a local do chunk: o grão precisa ser contínuo
        // na costura entre dois chunks. Com a posição local, cada chunk teria
        // seu próprio campo de ruído começando do zero e a emenda apareceria
        // como uma linha reta de textura trocada.
        vec4 _mundo = modelMatrix * vec4(transformed, 1.0);
        vPosMundo = _mundo.xyz;
        vDistCam = -mvPosition.z;
        `
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vPosMundo;
        varying float vDistCam;
        uniform float uFreqGrao;
        uniform float uForcaGrao;
        uniform float uForcaRelevo;

        float _hash(vec3 p) {
          p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }

        float _ruido(vec3 x) {
          vec3 i = floor(x);
          vec3 f = fract(x);
          f = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(mix(_hash(i + vec3(0,0,0)), _hash(i + vec3(1,0,0)), f.x),
                mix(_hash(i + vec3(0,1,0)), _hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(_hash(i + vec3(0,0,1)), _hash(i + vec3(1,0,1)), f.x),
                mix(_hash(i + vec3(0,1,1)), _hash(i + vec3(1,1,1)), f.x), f.y),
            f.z);
        }

        float _fbm(vec3 p) {
          return _ruido(p) * 0.55 + _ruido(p * 2.7) * 0.28 + _ruido(p * 6.1) * 0.17;
        }
        `
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        // Some com a distância: ruído de alta frequência a quilômetros de
        // distância é menor que um pixel e vira cintilação.
        float _perto = 1.0 - smoothstep(120.0, 700.0, vDistCam);
        if (_perto > 0.001) {
          vec3 _p = vPosMundo * uFreqGrao;
          float _manchas = _fbm(_p) - 0.5;          // ~12 unidades
          float _fino = _ruido(_p * 4.0) - 0.5;     // ~3 unidades

          // A variação vai quase toda para a SATURAÇÃO e um pouco para o
          // brilho, e não o contrário: escurecer e clarear em alta frequência
          // é o que produzia aspecto de sujeira. Empobrecer/enriquecer a cor
          // lê como terra batida, musgo e pedra — material, não poeira.
          float _v = _manchas * 0.75 + _fino * 0.25;
          float _cinza = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(vec3(_cinza), diffuseColor.rgb, 1.0 + _v * uForcaGrao * 3.0 * _perto);
          diffuseColor.rgb *= 1.0 + _v * uForcaGrao * 0.7 * _perto;
        }
`
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        #include <normal_fragment_maps>
        // Relevo na normal por diferenças finitas do mesmo campo. Equivale a um
        // normal map gerado na hora, sem textura e sem tangentes: o gradiente é
        // projetado nos eixos da tela via derivadas da posição de mundo.
        if (_perto > 0.001) {
          vec3 _q = vPosMundo * uFreqGrao * 3.0;
          float _e = 0.6;
          float _n0 = _fbm(_q);
          vec3 _grad = vec3(
            _fbm(_q + vec3(_e, 0.0, 0.0)) - _n0,
            _fbm(_q + vec3(0.0, _e, 0.0)) - _n0,
            _fbm(_q + vec3(0.0, 0.0, _e)) - _n0
          );
          // Só a componente TANGENTE ao chão: a parte radial do gradiente
          // apenas empurraria a normal para dentro ou para fora da superfície,
          // clareando e escurecendo o terreno inteiro em vez de dar relevo.
          _grad -= normal * dot(_grad, normal);
          normal = normalize(normal + _grad * uForcaRelevo * _perto);
        }
        `
      );
  };

  // Sem isto o three reaproveita o programa já compilado de outro material com
  // as mesmas opções e o detalhe não aparece em um dos planetas.
  material.customProgramCacheKey = () => `detalhe-superficie-${cfg.type}`;
}
