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
    shader.uniforms.uForcaGrao = { value: cfg.type === 'exótico' ? 0.36 : 0.26 };
    shader.uniforms.uForcaRelevo = { value: 2.2 };

    // -----------------------------------------------------------------------
    // AS DUAS ESCALAS GRANDES, E POR QUE ELAS SÃO O QUE FALTAVA.
    //
    // O grão acima resolve o pixel a dois metros do olho e some a 700 unidades
    // — que é o certo, senão vira chiado. Só que a paisagem VISTA DE CIMA é
    // quase toda feita do que está além disso, e ali não sobrava variação
    // nenhuma: uma encosta inteira saía com a mesma cor de bioma, chapada,
    // exatamente o aspecto de "mapa pintado" que se via voando baixo.
    //
    //   MACRO (~450 unidades): manchas do tamanho de um vale. É o que dá a
    //   impressão de solo com história — regiões mais secas, mais úmidas, mais
    //   pedregosas. NÃO desvanece com a distância, porque a esta escala uma
    //   feição continua tendo dezenas de pixels mesmo do alto da atmosfera.
    //
    //   MESO (~50 unidades): a ponte entre as duas. Sem ela a transição do
    //   grão para o macro tem um vão visível — o chão fica detalhado até uns
    //   500 metros e liso logo depois, e a fronteira acompanha a câmera.
    // -----------------------------------------------------------------------
    // Calibrado na tela. Estes números só valem lidos junto com `_var` no
    // fragmento: é ela que leva a excursão do ruído a [-1, 1] e faz "0,26"
    // significar 26% do efeito no pico. Antes dela os mesmos 0,26 valiam menos
    // de um décimo disso — ver o comentário longo em `_var`.
    shader.uniforms.uFreqMacro = { value: 0.0022 };
    shader.uniforms.uForcaMacro = { value: 0.26 };
    shader.uniforms.uFreqMeso = { value: 0.02 };
    shader.uniforms.uForcaMeso = { value: 0.16 };

    // Variação de RUGOSIDADE. É o parâmetro mais subestimado de um material
    // procedural: duas manchas com a mesma cor e rugosidades diferentes se
    // separam sozinhas quando o sol rasa, porque uma devolve brilho e a outra
    // não. É o que distingue pedra polida de terra batida sem trocar a cor de
    // nenhuma das duas.
    shader.uniforms.uVarRugosidade = { value: 0.22 };

    // Exposto para calibração ao vivo: sem isto, ajustar qualquer um destes
    // números exige recarregar a página e esperar o mundo inteiro reaparecer, o
    // que na prática significa calibrar no escuro.
    material.userData.detalhe = shader.uniforms;

    // Cópia dos valores de projeto, para quem os desliga saber ao que voltar.
    // Guardada AQUI e não em quem desliga: ler o valor corrente para "lembrar"
    // dele grava zero se o desligamento acontecer duas vezes seguidas, e o
    // detalhe nunca mais volta.
    material.userData.detalhePadrao = {
      grao: shader.uniforms.uForcaGrao.value,
      relevo: shader.uniforms.uForcaRelevo.value,
      macro: shader.uniforms.uForcaMacro.value,
      meso: shader.uniforms.uForcaMeso.value,
    };

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
        uniform float uFreqMacro;
        uniform float uForcaMacro;
        uniform float uFreqMeso;
        uniform float uForcaMeso;
        uniform float uVarRugosidade;
        // Compartilhado entre o bloco de cor e o de rugosidade, que são dois
        // pontos de injeção separados no shader do three.
        float _campoLento;

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

        // ---------------------------------------------------------------
        // NORMALIZAÇÃO, E O ERRO QUE ELA CONSERTA.
        //
        // Todo ajuste deste arquivo escalava (_fbm - 0.5) direto por uma
        // "força", e eu tratava esse termo como se cobrisse [-0.5, 0.5]. Não
        // cobre. Cada oitava é ruído de valor, que já se concentra perto de
        // 0.5, e a soma ponderada de três delas concentra mais ainda — na
        // prática a excursão fica em torno de +/- 0.17.
        //
        // O efeito era um multiplicador silencioso de UM TERÇO em cima de cada
        // número calibrado: a força 0.06 do grão valia 0.02, e nenhuma delas
        // aparecia na tela. Passei três rodadas de captura convencido de que o
        // problema era a fórmula de cor.
        //
        // Com a excursão levada a [-1, 1] aqui, cada "força" abaixo passa a
        // significar de fato a fração do efeito no seu pico.
        // ---------------------------------------------------------------
        float _var(vec3 p) {
          return clamp((_fbm(p) - 0.5) * 3.0, -1.0, 1.0);
        }
        `
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>

        // --- Escalas que sobrevivem à distância --------------------------
        float _macro = _var(vPosMundo * uFreqMacro);
        // O meso desvanece, mas MUITO mais longe que o grão: a 6 km uma feição
        // de 50 unidades já é subpixel e voltaria a cintilar.
        float _longe = 1.0 - smoothstep(2500.0, 6000.0, vDistCam);
        float _meso = _var(vPosMundo * uFreqMeso) * _longe;
        _campoLento = _macro * uForcaMacro + _meso * uForcaMeso;

        {
          // Mesmo princípio do grão fino: a maior parte vai para a saturação.
          // Aqui, porém, entra também um deslocamento de MATIZ — na escala do
          // vale, terreno real não muda só de intensidade, muda de cor (verde
          // que puxa para o oliva, areia que puxa para o ocre). Um giro
          // pequeno, feito trocando a proporção entre os canais, custa três
          // multiplicações e faz mais pela paisagem que qualquer outra linha
          // deste arquivo.
          float _cinza = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(vec3(_cinza), diffuseColor.rgb, 1.0 + _campoLento * 0.55);
          diffuseColor.rgb *= 1.0 + _campoLento * 0.22;
          diffuseColor.rgb *= vec3(
            1.0 + _campoLento * 0.10,
            1.0 + _campoLento * 0.02,
            1.0 - _campoLento * 0.09
          );
        }

        // Some com a distância: ruído de alta frequência a quilômetros de
        // distância é menor que um pixel e vira cintilação.
        float _perto = 1.0 - smoothstep(120.0, 700.0, vDistCam);
        if (_perto > 0.001) {
          vec3 _p = vPosMundo * uFreqGrao;
          float _manchas = _var(_p);                        // ~12 unidades
          float _fino = clamp((_ruido(_p * 4.0) - 0.5) * 2.4, -1.0, 1.0); // ~3

          // A variação vai quase toda para a SATURAÇÃO e um pouco para o
          // brilho, e não o contrário: escurecer e clarear em alta frequência
          // é o que produzia aspecto de sujeira. Empobrecer/enriquecer a cor
          // lê como terra batida, musgo e pedra — material, não poeira.
          // O peso migrou de 0,75/0,25 para cá depois de ver o resultado: com a
          // mancha grande dominando, o chão ganhava manchas suaves de dois
          // dígitos de metros e lia como NÓDOA — terra molhada, sombra de nuvem
          // mal feita — em vez de material. É a escala de ~3 unidades que o olho
          // interpreta como grão de solo, e ela precisava de peso comparável.
          float _v = _manchas * 0.55 + _fino * 0.45;
          float _cinza = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          float _g = _v * uForcaGrao * _perto;
          diffuseColor.rgb = mix(vec3(_cinza), diffuseColor.rgb, 1.0 + _g * 1.6);
          diffuseColor.rgb *= 1.0 + _g * 0.45;
          // Um empurrão de matiz também aqui: musgo puxa para o verde-azulado,
          // terra exposta para o ocre. Sem ele a grama fica com uma cor só,
          // apenas mais clara em alguns pontos — que é como se lê um lençol
          // amassado, não um campo.
          diffuseColor.rgb *= vec3(1.0 + _g * 0.22, 1.0, 1.0 - _g * 0.18);
        }
`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        // Depende de _campoLento, que o bloco de cor já preencheu — a ordem dos
        // includes do three garante isso (color_fragment vem antes deste).
        // Preso ao intervalo válido: rugosidade fora de [0,1] devolve NaN no
        // termo especular e o pixel sai preto.
        roughnessFactor = clamp(roughnessFactor + _campoLento * uVarRugosidade, 0.08, 1.0);
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
