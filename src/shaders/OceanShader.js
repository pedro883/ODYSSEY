/**
 * Oceano planetário.
 *
 * ===========================================================================
 * O QUE ESTAVA AQUI ANTES, E POR QUE NÃO BASTAVA
 * ===========================================================================
 * O oceano era uma esfera com `MeshStandardMaterial` translúcido. Da órbita
 * funcionava; ao nível dos olhos era uma superfície de plástico azul, sem
 * movimento, sem horizonte e — o pior — com a mesma cor em cima de um banco de
 * areia e sobre uma fossa de mil unidades. Água que não muda de cor com a
 * profundidade não lê como água: lê como um plano pintado atravessando a
 * paisagem, e a linha da praia vira um corte reto.
 *
 * ===========================================================================
 * PROFUNDIDADE VEM DA GEOMETRIA, NÃO DO DEPTH BUFFER
 * ===========================================================================
 * O caminho usual para água é ler o depth buffer da cena e comparar com a
 * superfície. Aqui isso seria caro e frágil: o terreno é desenhado num alvo
 * separado quando a perspectiva aérea está ligada (ver `Engine.render`), e o
 * oceano teria de conhecer esse arranjo.
 *
 * Em compensação, este projeto tem uma vantagem que jogo nenhum com terreno
 * autorado tem: a profundidade é uma FUNÇÃO, conhecida na CPU antes de o
 * primeiro frame existir. Amostrar o relevo uma vez por vértice da esfera e
 * gravar isso num atributo dá o gradiente de praia, a espuma na arrebentação e
 * a cor por profundidade de graça, sem nenhum passe extra e sem depender de
 * como o resto da cena é renderizado.
 *
 * ===========================================================================
 * ONDAS
 * ===========================================================================
 * Três camadas de ruído de gradiente rolando em direções diferentes,
 * perturbando a NORMAL (não a posição). Deslocar vértices numa esfera de 128×96
 * daria ondas de centenas de unidades de crista — visíveis da órbita como uma
 * bola amassada. O que se quer ver do convés é o brilho quebrando, e isso é
 * função da normal.
 */

import * as THREE from 'three';

/**
 * @param {object} cfg configuração do planeta
 * @param {(x:number,y:number,z:number)=>number} heightAt amostrador de relevo
 */
export function criarOceano(cfg, heightAt) {
  // ---------------------------------------------------------------------------
  // A RESOLUÇÃO É DITADA PELA COSTA, NÃO PELA SILHUETA.
  //
  // Com 160×112 num planeta de 4 600 de raio, cada quadrilátero tem ~180
  // unidades de lado — quase dois campos de futebol. A silhueta do horizonte
  // ficava lisa (era o critério antigo, e estava errado), mas a PROFUNDIDADE,
  // que é amostrada por vértice, virava um mapa grosseiro demais para saber
  // onde está a linha da praia: quadrantes inteiros de mar raso eram
  // classificados como terra e recortados, e o oceano aparecia como um
  // xadrez de manchas em vez de uma superfície.
  //
  // 320×224 (72 mil vértices) põe o quadrilátero em ~90 unidades e custa uma
  // única passada de ~70 ms no nascimento do planeta — pago uma vez, e só em
  // mundos que têm água.
  // ---------------------------------------------------------------------------
  const geometria = new THREE.SphereGeometry(cfg.radius, 320, 224);

  // -------------------------------------------------------------------------
  // Profundidade por vértice, em unidades de mundo.
  //
  // Positiva = há água ali (o fundo está abaixo do nível do mar). Negativa =
  // o "fundo" está acima da linha d'água, ou seja, é terra seca — e o shader
  // usa isso para sumir com a casca em vez de deixá-la cortando o continente.
  // -------------------------------------------------------------------------
  const posicoes = geometria.attributes.position;
  const profundidade = new Float32Array(posicoes.count);
  const inv = 1 / cfg.radius;

  for (let i = 0; i < posicoes.count; i++) {
    const x = posicoes.getX(i) * inv;
    const y = posicoes.getY(i) * inv;
    const z = posicoes.getZ(i) * inv;
    profundidade[i] = -heightAt(x, y, z);
  }
  geometria.setAttribute('profundidade', new THREE.BufferAttribute(profundidade, 1));

  // ---------------------------------------------------------------------------
  // AS CORES SÃO DE ÁGUA, NÃO DA PALETA DO PLANETA.
  //
  // A primeira versão misturava as cores do fundo do mar com o `waterColor` do
  // planeta em partes quase iguais. Num mundo de paleta quente o resultado era
  // um caldo amarelo-esverdeado que não lê como água — e "não parece água" é o
  // pior defeito possível numa superfície que ocupa metade do planeta.
  //
  // Agora a base é sempre água (ciano raso, azul-petróleo fundo) e o tom do
  // planeta entra como TEMPERO (25% no raso, 15% no fundo): o suficiente para
  // dois mundos terem mares distinguíveis, longe do bastante para nenhum deles
  // deixar de ser mar.
  // ---------------------------------------------------------------------------
  const tom = new THREE.Color().fromArray(cfg.waterColor);
  // O fundo era 0x06263f, escuro demais para sobreviver à perspectiva aérea:
  // medido, a névoa a algumas centenas de unidades domina qualquer superfície
  // escura e o mar chegava à tela como uma mancha cáqui da cor da atmosfera. A
  // água precisa ter brilho comparável ao do terreno para continuar sendo água
  // depois do passe de névoa.
  const raso = new THREE.Color(0x4fd0d6).lerp(tom, 0.2);
  const fundo = new THREE.Color(0x0d3f66).lerp(tom, 0.15);

  const uniforms = {
    uTempo: { value: 0 },
    uSol: { value: new THREE.Vector3(0, 1, 0) },
    uCamera: { value: new THREE.Vector3() },
    uRaso: { value: raso },
    uFundo: { value: fundo },
    uEspuma: { value: new THREE.Color(0xeaf6ff) },
    uCeu: { value: new THREE.Color().fromArray(cfg.atmosphere.tint) },
    // Escala das ondas, em ciclos por unidade de mundo. 0.06 põe a ondulação
    // maior em ~16 unidades e a menor em ~2 — ondas de mar, na escala de uma
    // nave de 4 unidades. Fixa em unidades de MUNDO e não em fração do raio: a
    // água de uma lua e a de um gigante têm o mesmo tamanho de onda, porque o
    // que dá a escala é o observador, não o corpo celeste.
    uEscalaOnda: { value: 0.06 },
    // 1 quando a câmera está submersa. Muda a face desenhada e a cor.
    uSubmerso: { value: 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    // -------------------------------------------------------------------------
    // A ÁGUA ESCREVE PROFUNDIDADE — E ISSO NÃO É DETALHE DE ORDENAÇÃO.
    //
    // Com `depthWrite: false` a superfície do mar não aparecia no depth buffer,
    // e a perspectiva aérea (ver `Engine.render`) trabalha lendo esse buffer.
    // O resultado é que cada pixel de água era enevoado pela distância do FUNDO
    // atrás dele — centenas ou milhares de unidades — em vez da distância da
    // própria lâmina d'água, a vinte metros do observador.
    //
    // Foi isso que apagou o mar. A névoa de longa distância lavava a superfície
    // inteira até a cor da atmosfera, e o que sobrava era uma chapa de uma cor
    // só, sem horizonte e sem ondulação: exatamente o defeito relatado. O teste
    // que mostrou isso foi esconder o terreno — o oceano sumia JUNTO, o que só
    // faz sentido se o que estava sendo desenhado ali era névoa sobre o fundo.
    //
    // Escrever profundidade é seguro aqui porque a água é uma casca única e
    // fechada: não há duas camadas transparentes para ordenar entre si.
    // -------------------------------------------------------------------------
    depthWrite: true,
    // DUAS FACES: com `FrontSide`, mergulhar fazia a água simplesmente sumir —
    // o nadador via o céu por dentro do mar. A face de dentro é o teto de água
    // sobre a cabeça de quem está submerso.
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      // -----------------------------------------------------------------------
      // ESTAS TRÊS LINHAS DE "#include" SÃO A RAZÃO DE O MAR NÃO APARECER.
      //
      // O renderizador roda com "logarithmicDepthBuffer: true" (ver "Engine.js"),
      // e isso não é uma opção de contexto: é uma CONVENÇÃO DE SHADER. Cada
      // material precisa codificar a profundidade da mesma forma, através dos
      // chunks que o próprio three.js injeta. Os materiais nativos e os shaders
      // da atmosfera e das nuvens fazem isso; este não fazia.
      //
      // O resultado é que a água escrevia e comparava profundidade numa ESCALA
      // DIFERENTE da do resto da cena. O teste de profundidade então reprovava
      // quase todos os fragmentos do oceano, e sobrava a faixa estreita perto do
      // horizonte onde as duas escalas por acaso concordavam — literalmente
      // "apenas uma linha nas bordas", que foi como o defeito chegou.
      //
      // Foi por isso que as tentativas anteriores de mexer em cor, opacidade e
      // ordem de desenho não mudaram nada: o fragmento morria antes de chegar
      // ao blend. O que fechou o diagnóstico foi um material de depuração opaco
      // e sem "discard" — ele TAMBÉM não apareceu, embora "onBeforeRender" do
      // oceano estivesse sendo chamado e o raycast acertasse a casca à frente
      // do fundo do mar. Só sobra o teste de profundidade.
      // -----------------------------------------------------------------------
      #include <common>
      #include <logdepthbuf_pars_vertex>

      attribute float profundidade;
      varying float vProf;
      varying vec3 vLocal;
      varying vec3 vNormal;

      void main() {
        vProf = profundidade;
        vLocal = position;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;

      // Ver a explicação no vertex shader: sem este par a água é reprovada no
      // teste de profundidade e não chega à tela.
      #include <common>
      #include <logdepthbuf_pars_fragment>

      uniform float uTempo;
      uniform vec3 uSol;
      uniform vec3 uCamera;
      uniform vec3 uRaso;
      uniform vec3 uFundo;
      uniform vec3 uEspuma;
      uniform vec3 uCeu;
      uniform float uEscalaOnda;
      uniform float uSubmerso;

      varying float vProf;
      varying vec3 vLocal;
      varying vec3 vNormal;

      // Ruído de gradiente 3D. Barato e sem textura — o oceano precisa
      // funcionar num planeta gerado em tempo de execução, onde não há atlas
      // de normal map para carregar.
      vec3 hash3(vec3 p) {
        p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
                 dot(p, vec3(269.5, 183.3, 246.1)),
                 dot(p, vec3(113.5, 271.9, 124.6)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      float ruido(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(dot(hash3(i + vec3(0,0,0)), f - vec3(0,0,0)),
                  dot(hash3(i + vec3(1,0,0)), f - vec3(1,0,0)), u.x),
              mix(dot(hash3(i + vec3(0,1,0)), f - vec3(0,1,0)),
                  dot(hash3(i + vec3(1,1,0)), f - vec3(1,1,0)), u.x), u.y),
          mix(mix(dot(hash3(i + vec3(0,0,1)), f - vec3(0,0,1)),
                  dot(hash3(i + vec3(1,0,1)), f - vec3(1,0,1)), u.x),
              mix(dot(hash3(i + vec3(0,1,1)), f - vec3(0,1,1)),
                  dot(hash3(i + vec3(1,1,1)), f - vec3(1,1,1)), u.x), u.y),
          u.z);
      }

      /**
       * O céu na direção "d", aproximado.
       *
       * Não reaproveita o shader da atmosfera de propósito: rodar o
       * espalhamento inteiro por fragmento de água custaria caro para responder
       * uma pergunta simples. O que a água precisa do céu é a FORMA dele —
       * lavado e claro junto ao horizonte, escuro e saturado no alto — e isso
       * são duas cores e um expoente.
       */
      vec3 corDoCeu(vec3 d, vec3 radial, vec3 sol, vec3 tint, float dia) {
        float alto = clamp(dot(d, radial), 0.0, 1.0);
        // ------------------------------------------------------------------
        // O CLAREAMENTO PARA O HORIZONTE É REAL, MAS PEQUENO.
        //
        // A primeira tentativa empurrava o horizonte 55% na direção do branco e
        // o resultado foi uma FAIXA BRANCA ESTOURADA na linha do horizonte: ali
        // o fresnel satura em 1, então o que se via era essa cor pura, sem nada
        // do corpo da água por baixo. E ela mentia sobre a cena — este céu é
        // verde-escuro, e um mar espelhando branco não pertence a ele.
        //
        // O reflexo tem de ficar ANCORADO no tom do céu: o mar de um mundo de
        // céu escuro é escuro. Só o gradiente precisa sobreviver.
        // ------------------------------------------------------------------
        vec3 horizonte = mix(tint, vec3(1.0), 0.28);
        vec3 zenite = tint * 0.45;
        vec3 c = mix(horizonte, zenite, pow(alto, 0.55));
        // O halo em volta do sol: na água ele vira o clarão do lado iluminado.
        c += tint * pow(max(dot(d, sol), 0.0), 8.0) * 0.35;
        return c * 0.62 * (0.12 + 0.88 * dia);
      }

      void main() {
        // ---------------------------------------------------------------
        // QUEM ESCONDE A ÁGUA SOB O CONTINENTE É O TESTE DE PROFUNDIDADE.
        //
        // O recorte por vértice (descartar onde a profundidade fosse
        // negativa) parecia a solução óbvia e era a
        // fonte do xadrez descrito acima: a profundidade interpolada entre
        // vértices a 90 unidades não sabe onde a praia começa. O terreno já é
        // desenhado ANTES e opaco, então todo pixel de água atrás de terra
        // alta é descartado pelo z-buffer — de graça e com precisão de pixel.
        //
        // O corte aqui sobra só para o interior do continente, onde a casca
        // do nível do mar corre dezenas de unidades abaixo do chão e não tem
        // como ser vista: pular esses fragmentos economiza mistura à toa.
        // ---------------------------------------------------------------
        if (vProf < -40.0) discard;

        #include <logdepthbuf_fragment>

        vec3 radial = normalize(vLocal);
        vec3 paraCamera = normalize(uCamera - vLocal);

        // -------------------------------------------------------------------
        // ONDAS
        //
        // Quatro escalas de ruído rolando em direções e velocidades
        // diferentes. O que mudou em relação à primeira versão não foi a
        // quantidade de camadas e sim a AMPLITUDE: o gradiente entrava na
        // normal multiplicado por ~3, o que girava a normal quase 90° entre
        // pixels vizinhos e produzia um mosaico de manchas claras e escuras —
        // a água ficava com aspecto de camuflagem, não de água.
        //
        // Onda de mar mexe pouco com a normal e muito com o BRILHO: a leitura
        // de "superfície líquida em movimento" vem do especular deslizando
        // sobre a ondulação, não de a superfície mudar de cor.
        // -------------------------------------------------------------------
        vec3 p = vLocal * uEscalaOnda;
        float t = uTempo;
        float e = 0.6;

        vec3 d1 = vec3(t * 0.09, t * 0.05, 0.0);
        vec3 d2 = vec3(-t * 0.13, 0.0, t * 0.11);
        vec3 d3 = vec3(t * 0.21, -t * 0.17, t * 0.05);
        vec3 d4 = vec3(-t * 0.31, t * 0.23, 0.0);

        float a0 = ruido(p * 0.35 + d1);
        float ax = ruido((p + vec3(e, 0, 0)) * 0.35 + d1);
        float az = ruido((p + vec3(0, 0, e)) * 0.35 + d1);

        float b0 = ruido(p * 1.0 + d2);
        float bx = ruido((p + vec3(e, 0, 0)) * 1.0 + d2);
        float bz = ruido((p + vec3(0, 0, e)) * 1.0 + d2);

        float c0 = ruido(p * 2.7 + d3);
        float cx = ruido((p + vec3(e, 0, 0)) * 2.7 + d3);
        float cz = ruido((p + vec3(0, 0, e)) * 2.7 + d3);

        float f0 = ruido(p * 6.5 + d4);
        float fx = ruido((p + vec3(e, 0, 0)) * 6.5 + d4);
        float fz = ruido((p + vec3(0, 0, e)) * 6.5 + d4);

        // A ondulação grande morre no raso — perto da praia a água é agitada
        // por dentro, não ondulada.
        float aguaAberta = smoothstep(1.0, 25.0, vProf);
        // A oitava mais fina entra com metade do peso de antes (0.08 e não
        // 0.16): no primeiro plano ela tem período de ~2,5 unidades, e com peso
        // cheio o mar perto da câmera virava CHUVISCO — grão de areia, não
        // ondulação. Ela continua ali para o brilho não ficar liso demais.
        float gx = (ax - a0) * 0.5 * aguaAberta + (bx - b0) * 0.32 + (cx - c0) * 0.22 + (fx - f0) * 0.08;
        float gz = (az - a0) * 0.5 * aguaAberta + (bz - b0) * 0.32 + (cz - c0) * 0.22 + (fz - f0) * 0.08;

        // -------------------------------------------------------------------
        // A ONDULAÇÃO PRECISA MORRER COM A DISTÂNCIA.
        //
        // Uma normal ruidosa a mil unidades tem período menor que um pixel:
        // cada pixel sorteia uma inclinação diferente, e depois que o antialias
        // mistura tudo sobra a MÉDIA — uma chapa de cor única. Parte da
        // sensação de "chapa pintada" vinha daí. Amortecendo com a distância, o
        // longe fica liso e espelhado, que é como o mar se comporta mesmo: a
        // ondulação só se distingue perto do observador.
        // -------------------------------------------------------------------
        float dist = length(uCamera - vLocal);
        float nitidez = 1.0 - smoothstep(70.0, 700.0, dist);
        gx *= nitidez;
        gz *= nitidez;

        vec3 tangente = normalize(cross(radial, vec3(0.0, 1.0, 0.0)) + vec3(1e-5));
        vec3 bitangente = cross(radial, tangente);
        vec3 normal = normalize(radial + (tangente * gx + bitangente * gz) * 0.95);
        float crista = (b0 + c0) * 0.5;

        // Quanto o sol está alto NESTE ponto do planeta — e não em relação à
        // normal da onda. Separar as duas coisas é o que impede o mar do lado
        // noturno de continuar cintilando.
        float diaLocal = smoothstep(-0.08, 0.25, dot(radial, uSol));

        // --- O corpo da água --------------------------------------------------
        // Cor por profundidade. A água não é uma superfície difusa: ela espalha
        // luz por dentro, então a variação com o sol é suave e nunca chega a
        // zero — o mar ao entardecer escurece, não apaga.
        float mistura = smoothstep(0.5, 45.0, vProf);
        vec3 corpo = mix(uRaso, uFundo, mistura);
        float difusa = max(dot(normal, uSol), 0.0);
        corpo *= (0.55 + 0.45 * diaLocal) * (0.85 + 0.30 * difusa);

        // --- Espuma ----------------------------------------------------------
        // Duas fontes: a arrebentação (onde o fundo sobe) e as cristas das
        // ondas em mar aberto. Sem a segunda, o mar longe da costa fica liso
        // demais e denuncia que a "onda" é só iluminação.
        float borda = 1.0 - smoothstep(0.0, 4.5, vProf);
        float renda = ruido(vLocal * uEscalaOnda * 7.0 + vec3(uTempo * 0.5)) * 0.5 + 0.5;
        float espuma = smoothstep(0.4, 0.95, borda * (0.5 + renda));
        // O limiar da crista é ALTO (0.55) de propósito. Com 0.34, um quarto do
        // ruído passava e o mar aberto ficava salpicado de manchas claras — mais
        // parecido com uma praia de areia vista de longe do que com carneirinhos.
        // Espuma de crista cobre uma fração pequena da superfície; é a raridade
        // dela que faz a onda parecer alta quando aparece.
        espuma = max(espuma, smoothstep(0.55, 0.78, crista) * aguaAberta * nitidez * 0.30);
        corpo = mix(corpo, uEspuma * (0.35 + 0.65 * diaLocal), espuma);

        // ---------------------------------------------------------------------
        // O CÉU REFLETIDO É O QUE FAZ AQUILO LER COMO ÁGUA.
        //
        // Era isto que faltava. A versão anterior misturava um pouco da cor do
        // céu com peso fixo de 0.35, e o efeito prático era quase nenhum: no mar
        // aberto a profundidade satura, a cor do corpo vira constante, e o
        // resultado é uma chapa azul-marinho de uma cor só, sem horizonte —
        // exatamente o defeito relatado.
        //
        // Água tem índice de refração 1.33: reflete 2% de frente e quase 100%
        // de raspão. Como QUASE TODO o mar visível é visto de raspão, o que se
        // vê do mar é o céu. E é a variação do céu refletido — claro perto do
        // horizonte, escuro no alto — que desenha o horizonte, dá volume à
        // superfície e distingue "olhar para o mar" de "olhar para uma chapa".
        //
        // Por isso o fresnel aqui é o de Schlick de verdade, com F0 = 0.02, e
        // entra como peso da mistura inteira — não como um tempero de 35%.
        // ---------------------------------------------------------------------
        vec3 refl = reflect(-paraCamera, normal);
        float cosT = max(dot(normal, paraCamera), 0.0);
        float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

        vec3 ceu = corDoCeu(refl, radial, uSol, uCeu, diaLocal);
        vec3 cor = mix(corpo, ceu, fresnel);

        // --- O sol na água ----------------------------------------------------
        // O caminho de luz, em duas larguras: o núcleo (o reflexo do disco) e o
        // halo que se espalha pelas cristas e desenha a estrada brilhante até o
        // horizonte. Os dois multiplicados pelo fresnel — reflexo é reflexo.
        vec3 meio = normalize(uSol + paraCamera);
        float ndoth = max(dot(normal, meio), 0.0);
        float brilho = pow(ndoth, 260.0) * 3.0 + pow(ndoth, 24.0) * 0.35;
        cor += vec3(1.0, 0.95, 0.86) * brilho * fresnel * 2.5 * diaLocal;

        // Espuma é matéria, não espelho: ela não reflete o céu. Sem esta linha
        // a arrebentação desaparecia sob o reflexo em ângulo rasante — que é
        // justamente o ângulo de quem olha a praia de pé.
        cor = mix(cor, uEspuma * (0.4 + 0.6 * diaLocal), espuma * 0.6);

        // --- Submerso ---------------------------------------------------------
        // Visto de baixo, o que se vê é a massa de água entre o olho e o céu:
        // azul profundo, praticamente opaco, com a luz vindo de cima.
        cor = mix(cor, uFundo * (0.35 + 0.65 * diaLocal), uSubmerso);

        // --- Transparência -----------------------------------------------------
        // O raso PRECISA deixar ver o fundo. O degradê do fundo aparecendo sob
        // um véu que vai fechando com a profundidade é o sinal mais barato e
        // mais forte de que aquilo é líquido, e não uma superfície pintada — e
        // é ele que faz a linha da praia parecer molhada em vez de recortada.
        //
        // A versão anterior abria em 0.86 e fechava em cinco unidades: como
        // quase todo litoral tem menos que isso, na prática a água era opaca do
        // primeiro metro em diante e o gradiente nunca era visto.
        // A rampa fecha em SETE unidades, e não em vinte e duas. O oceano deste
        // planeta tem 35 de profundidade máxima e a maior parte fica entre 3 e
        // 10: com a rampa longa, quase todo o mar ficava meio transparente e o
        // que se via era o FUNDO MARROM por baixo de um véu azul. Água de
        // verdade esconde o fundo em poucos metros — é por isso que só a franja
        // da praia deixa ver areia.
        float alfa = mix(0.35, 0.97, smoothstep(0.0, 7.0, vProf));
        alfa = max(alfa, espuma);
        alfa = max(alfa, fresnel);
        alfa = clamp(alfa, 0.0, 1.0);
        alfa = mix(alfa, 0.96, uSubmerso);

        gl_FragColor = vec4(cor, alfa);
      }
    `,
  });

  const mesh = new THREE.Mesh(geometria, material);
  // Depois do terreno (0) e antes das nuvens (5) e da atmosfera (10).
  mesh.renderOrder = 1;

  return {
    mesh,
    uniforms,
    /**
     * @param {THREE.Vector3} cameraLocal câmera no espaço do planeta
     * @param {THREE.Vector3} sunDirection direção até o sol, em mundo
     * @param {number} elapsed segundos desde o boot
     */
    atualizar(cameraLocal, sunDirection, elapsed) {
      uniforms.uTempo.value = elapsed;
      uniforms.uCamera.value.copy(cameraLocal);
      uniforms.uSol.value.copy(sunDirection);
      // Submerso quando a câmera está dentro da esfera do nível do mar.
      uniforms.uSubmerso.value = cameraLocal.length() < cfg.radius ? 1 : 0;
    },
    dispose() {
      geometria.dispose();
      material.dispose();
    },
  };
}
