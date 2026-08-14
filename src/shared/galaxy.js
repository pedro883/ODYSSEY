/**
 * Endereçamento e geração da galáxia.
 *
 * ===========================================================================
 * NADA DISTO É ARMAZENADO
 * ===========================================================================
 * A galáxia é uma grade 3D de voxels. Cada voxel pode conter alguns sistemas
 * estelares, e a existência, a posição, a cor e o conteúdo de cada um saem de
 * uma FUNÇÃO do endereço do voxel — não de um banco de dados.
 *
 * A consequência é a que importa: um mapa com dezenas de milhares de estrelas
 * não custa memória nem carregamento. O que se paga é o hash de alguns voxels
 * por frame, e só dos que a câmera pode ver.
 *
 * É a mesma premissa que já sustenta o terreno deste projeto (`shared/terrain.js`),
 * subindo um nível de escala: lá o seed gera montanhas, aqui gera estrelas.
 *
 * ===========================================================================
 * SOBRE O ENDEREÇO DE 64 BITS
 * ===========================================================================
 * A convenção de referência empacota galáxia, X, Y, Z e índice num inteiro de
 * 64 bits. Em JavaScript isso não é direto: `Number` é float64 e só representa
 * inteiros exatos até 2^53, e os operadores de bit truncam para 32 bits. O
 * `BigInt` resolve, mas é uma ordem de grandeza mais lento — e este código roda
 * para milhares de voxels enquanto a câmera se move.
 *
 * A saída é separar as duas funções que o endereço cumpre:
 *
 *   - IDENTIFICAR (salvar, mostrar na tela, comparar): `enderecoUniversal()`
 *     devolve o inteiro de 64 bits como `BigInt`, formatado em hexadecimal.
 *     Roda raramente — quando o jogador seleciona ou visita um sistema.
 *
 *   - GERAR (posição, cor, quantos planetas): `semente()` mistura os mesmos
 *     componentes num inteiro de 32 bits com aritmética comum. Roda milhões de
 *     vezes e não precisa ser reversível, só bem distribuído e determinístico.
 *
 * Um único valor cumprindo os dois papéis seria mais elegante no papel e
 * pagaria o custo do `BigInt` no laço quente para não ganhar nada.
 */

/* ========================================================================== */
/* Constantes da grade                                                        */
/* ========================================================================== */

/** Lado do voxel, em anos-luz do mapa. */
export const LADO_VOXEL = 1;

/** Raio da galáxia em voxels — o disco tem `2 * RAIO_GALAXIA` de diâmetro. */
export const RAIO_GALAXIA = 96;

/** Meia-espessura do disco, em voxels. */
export const ESPESSURA_DISCO = 7;

/** Máximo de sistemas que um voxel pode conter. */
const MAX_POR_VOXEL = 3;

/**
 * As galáxias disponíveis.
 *
 * Poucas e nomeadas à mão de propósito: o salto entre galáxias é um evento
 * raro, e uma lista fixa dá a elas identidade — o jogador lembra que "Hyliark
 * era a vermelha". Um gerador procedural devolveria mil nomes iguais.
 */
export const GALAXIAS = [
  { id: 0, nome: 'Euclídea', cor: 0x8fd4ff, bracos: 2, giro: 0.9 },
  { id: 1, nome: 'Hilbert',  cor: 0xffb26b, bracos: 3, giro: 1.15 },
  { id: 2, nome: 'Calypso',  cor: 0xb69bff, bracos: 2, giro: 0.7 },
  { id: 3, nome: 'Hesperion', cor: 0x7dffc0, bracos: 4, giro: 1.4 },
  { id: 4, nome: 'Hyliark',  cor: 0xff7d92, bracos: 2, giro: 1.05 },
];

/* ========================================================================== */
/* Hash                                                                       */
/* ========================================================================== */

/**
 * Mistura de 32 bits no estilo do finalizador do MurmurHash3.
 *
 * Precisa ser boa de verdade: se bits vizinhos da entrada produzirem saídas
 * parecidas, as estrelas nascem alinhadas em grade e a galáxia inteira parece
 * um papel quadriculado. Este finalizador é o que dá avalanche — trocar um bit
 * da entrada muda metade dos bits da saída.
 */
function misturar(h) {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Semente de 32 bits de um sistema, para geração.
 *
 * Os multiplicadores são primos grandes e diferentes entre si para que
 * permutar coordenadas não colida: (3,5,7) e (5,3,7) precisam ser sistemas
 * distintos, e uma soma simples os tornaria idênticos.
 */
export function semente(galaxia, x, y, z, indice) {
  let h = Math.imul(galaxia + 1, 0x9e3779b1);
  h = misturar(h ^ Math.imul(x | 0, 0x85ebca77));
  h = misturar(h ^ Math.imul(y | 0, 0xc2b2ae3d));
  h = misturar(h ^ Math.imul(z | 0, 0x27d4eb2f));
  return misturar(h ^ Math.imul(indice | 0, 0x165667b1));
}

/**
 * Endereço universal de 64 bits, no formato da convenção do gênero.
 *
 *   galáxia (8) | X (16) | Y (8) | Z (16) | índice (16)
 *
 * Só para identificar: mostrar na tela e gravar no banco. Nunca no laço de
 * geração — ver o cabeçalho.
 *
 * As coordenadas são deslocadas para positivo antes de entrar, porque um
 * complemento de dois num campo de 16 bits vira lixo ao ser lido de volta.
 */
export function enderecoUniversal(galaxia, x, y, z, indice) {
  const ux = BigInt((x | 0) + 0x8000) & 0xffffn;
  const uy = BigInt((y | 0) + 0x80) & 0xffn;
  const uz = BigInt((z | 0) + 0x8000) & 0xffffn;
  return (
    (BigInt(galaxia & 0xff) << 56n) |
    (ux << 40n) |
    (uy << 32n) |
    (uz << 16n) |
    (BigInt(indice) & 0xffffn)
  );
}

/** O endereço como o jogador vê: `0A:1F3C:8B:2D04`. */
export function formatarEndereco(endereco) {
  const hex = endereco.toString(16).padStart(16, '0').toUpperCase();
  return `${hex.slice(0, 2)}:${hex.slice(2, 6)}${hex.slice(6, 8)}:${hex.slice(8, 12)}:${hex.slice(12)}`;
}

/* ========================================================================== */
/* Forma da galáxia                                                           */
/* ========================================================================== */

/**
 * Densidade de estrelas num ponto do disco, em [0,1].
 *
 * Três termos, e cada um resolve um problema visual distinto:
 *
 *   - o BOJO central concentra estrelas no meio, que é o que faz a galáxia ter
 *     um centro em vez de ser um disco uniforme;
 *   - os BRAÇOS ESPIRAIS vêm de comparar o ângulo do ponto com o ângulo que a
 *     espiral logarítmica teria naquele raio; sem eles o disco lê como um CD;
 *   - o CORTE na borda evita que a galáxia termine num círculo perfeito, que
 *     denuncia a fórmula.
 */
export function densidade(galaxia, x, y, z) {
  const raio = Math.hypot(x, z);
  if (raio > RAIO_GALAXIA) return 0;

  const cfg = GALAXIAS[galaxia] ?? GALAXIAS[0];
  const r = raio / RAIO_GALAXIA;

  // Disco fica mais fino conforme se afasta do centro — como uma galáxia real.
  const meiaEspessura = ESPESSURA_DISCO * (1 - r * 0.65) + 0.6;
  const vertical = Math.max(0, 1 - (y * y) / (meiaEspessura * meiaEspessura));
  if (vertical <= 0) return 0;

  const bojo = Math.exp(-r * r * 9) * 1.4;

  // Espiral logarítmica: o ângulo do braço cresce com o log do raio.
  const angulo = Math.atan2(z, x);
  const espiral = Math.log(Math.max(r, 0.02)) * cfg.giro * 4;
  const fase = (angulo - espiral) * cfg.bracos;
  // `cos` elevado concentra o brilho na crista do braço em vez de espalhá-lo.
  const braco = Math.pow(Math.max(0, Math.cos(fase)) * 0.5 + 0.5, 3.2);

  const disco = braco * Math.exp(-r * 1.9) * (1 - Math.exp(-r * 8));
  const borda = 1 - Math.pow(r, 6);

  return Math.max(0, Math.min(1, (bojo + disco * 1.5) * vertical * borda));
}

/* ========================================================================== */
/* Sistemas                                                                   */
/* ========================================================================== */

/**
 * Classes espectrais, do mais quente ao mais frio.
 *
 * `peso` é a frequência relativa — anãs vermelhas dominam o céu real, e
 * respeitar isso faz as estrelas azuis brilhantes valerem alguma coisa quando
 * aparecem.
 */
export const CLASSES = [
  { letra: 'O', cor: 0x9bb8ff, peso: 0.02, tamanho: 1.6 },
  { letra: 'B', cor: 0xbcd0ff, peso: 0.05, tamanho: 1.35 },
  { letra: 'A', cor: 0xe4ecff, peso: 0.09, tamanho: 1.15 },
  { letra: 'F', cor: 0xfff6e8, peso: 0.13, tamanho: 1.0 },
  { letra: 'G', cor: 0xffe9a8, peso: 0.19, tamanho: 0.92 },
  { letra: 'K', cor: 0xffc078, peso: 0.24, tamanho: 0.82 },
  { letra: 'M', cor: 0xff8a5c, peso: 0.28, tamanho: 0.7 },
];

const CLASSE_ACUMULADA = (() => {
  const out = [];
  let soma = 0;
  for (const c of CLASSES) {
    soma += c.peso;
    out.push(soma);
  }
  // Normaliza para o último ser exatamente 1, senão sobra uma fresta sem classe.
  return out.map((v) => v / soma);
})();

/** Quantos sistemas existem neste voxel. */
export function contagemNoVoxel(galaxia, x, y, z) {
  const d = densidade(galaxia, x, y, z);
  if (d <= 0.02) return 0;

  const h = semente(galaxia, x, y, z, 0xffff);
  // O hash decide se o voxel "ganha" cada uma das vagas, com probabilidade
  // igual à densidade. Arredondar `d * MAX` daria anéis visíveis onde a
  // densidade cruza .5 — o sorteio dissolve a borda.
  let n = 0;
  for (let i = 0; i < MAX_POR_VOXEL; i++) {
    if (((h >>> (i * 7)) & 0x3ff) / 1024 < d) n++;
  }
  return n;
}

/**
 * Descreve um sistema. Chamado sob demanda; nada é guardado.
 *
 * @returns {{galaxia:number, vx:number, vy:number, vz:number, indice:number,
 *   seed:number, x:number, y:number, z:number, classe:object, planetas:number}}
 */
export function sistemaEm(galaxia, vx, vy, vz, indice) {
  const s = semente(galaxia, vx, vy, vz, indice);

  // Três campos independentes a partir da mesma semente. Fatias de bits
  // diferentes, e não três chamadas de PRNG: é uma operação em vez de três, e o
  // hash já garantiu que os bits não são correlacionados.
  const fx = ((s & 0x3ff) / 1024 - 0.5) * LADO_VOXEL;
  const fy = (((s >>> 10) & 0x3ff) / 1024 - 0.5) * LADO_VOXEL;
  const fz = (((s >>> 20) & 0x3ff) / 1024 - 0.5) * LADO_VOXEL;

  const rolo = misturar(s ^ 0x51ed270b) / 0xffffffff;
  let classe = CLASSES[CLASSES.length - 1];
  for (let i = 0; i < CLASSE_ACUMULADA.length; i++) {
    if (rolo <= CLASSE_ACUMULADA[i]) {
      classe = CLASSES[i];
      break;
    }
  }

  return {
    galaxia,
    vx, vy, vz,
    indice,
    // A semente que o `StarSystem` consome. É o elo entre o mapa e o mundo:
    // saltar para uma estrela do mapa gera exatamente o sistema que ela
    // representa, e não um qualquer.
    seed: s,
    x: vx + fx,
    y: vy + fy,
    z: vz + fz,
    classe,
    planetas: 2 + (misturar(s ^ 0x2545f491) % 5),
  };
}

/** Nome pronunciável derivado da semente. */
const PREFIXOS = ['Ael', 'Bor', 'Cyn', 'Dra', 'Eri', 'Fen', 'Gal', 'Hyr', 'Iso', 'Kel', 'Lyr', 'Mor', 'Nax', 'Oph', 'Pra', 'Quel', 'Rho', 'Syl', 'Tor', 'Vex', 'Xan', 'Zeth'];
const MEIOS = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'or', 'un', 'yr'];
const SUFIXOS = ['dor', 'nis', 'tara', 'vex', 'lum', 'kar', 'mira', 'thys', 'nova', 'reon', 'zar', 'phae'];

/**
 * Nome de um sistema — ÚNICO em toda a galáxia.
 *
 * ---------------------------------------------------------------------------
 * POR QUE A PARTE PRONUNCIÁVEL NÃO BASTA
 * ---------------------------------------------------------------------------
 * As três tabelas de sílabas geram 22 × 10 × 12 = 2 640 combinações, para cerca
 * de 178 mil sistemas. Não é um risco de colisão: é a garantia de que dezenas
 * de sistemas dividem o mesmo nome. Enquanto ninguém comparava dois deles isso
 * passava despercebido; a partir do momento em que um sistema tem DONO — quem o
 * descobriu —, dois "Kelaenova" diferentes tornam a informação inútil.
 *
 * ---------------------------------------------------------------------------
 * A DESIGNAÇÃO É UMA BIJEÇÃO DO ENDEREÇO
 * ---------------------------------------------------------------------------
 * O sufixo não é um hash: é o endereço do sistema (galáxia, voxel e índice)
 * empacotado em 31 bits e escrito em base 36. Dois sistemas distintos têm
 * endereços distintos, logo designações distintas — a unicidade é aritmética,
 * não estatística, e continua valendo sem nenhum registro central.
 *
 * O empacotamento assume |x|,|y|,|z| < 128 e no máximo 8 sistemas por voxel.
 * Com `RAIO_GALAXIA` 96, `ESPESSURA_DISCO` 7 e `MAX_POR_VOXEL` 3 sobra folga;
 * quem aumentar esses limites precisa alargar os campos aqui junto.
 *
 * @param {{galaxia:number, vx:number, vy:number, vz:number, indice:number, seed:number}} sistema
 */
export function nomeDoSistema(sistema) {
  const seed = sistema.seed;
  const a = PREFIXOS[misturar(seed ^ 0x1b873593) % PREFIXOS.length];
  const b = MEIOS[misturar(seed ^ 0xcc9e2d51) % MEIOS.length];
  const c = SUFIXOS[misturar(seed ^ 0x38b34ae5) % SUFIXOS.length];

  const empacotado =
    (((sistema.galaxia & 0x0f) << 27) |
      (((sistema.vx + 128) & 0xff) << 19) |
      (((sistema.vy + 128) & 0xff) << 11) |
      (((sistema.vz + 128) & 0xff) << 3) |
      (sistema.indice & 0x07)) >>>
    0;

  // Base 36 preenchida à esquerda: a designação tem sempre o mesmo comprimento,
  // então nomes em lista ficam alinhados e dá para comparar dois de relance.
  const designacao = empacotado.toString(36).toUpperCase().padStart(6, '0');
  return `${a}${b}${c} ${designacao.slice(0, 3)}-${designacao.slice(3)}`;
}

/**
 * Percorre os sistemas dentro de um raio de voxels.
 *
 * Um gerador, e não um array: quem chama quase sempre quer filtrar ou parar
 * cedo, e materializar dezenas de milhares de objetos para descartar a maioria
 * é justamente o que esta arquitetura existe para evitar.
 */
export function* sistemasNoRaio(galaxia, cx, cy, cz, raio, passo = 1) {
  const r = Math.ceil(raio);
  const raioSq = raio * raio;

  for (let z = cz - r; z <= cz + r; z++) {
    // -----------------------------------------------------------------------
    // AMOSTRAGEM ESPARSA ALINHADA A UMA GRADE ABSOLUTA.
    //
    // Com `passo > 1` só um voxel a cada `passo` é visitado — é o LOD do mapa:
    // afastado, vê-se a FORMA da galáxia com uma fração das estrelas; de perto,
    // `passo` volta a 1 e nenhuma some.
    //
    // O resto é calculado sobre a coordenada ABSOLUTA, nunca sobre a distância
    // ao foco. Alinhar ao foco faria o conjunto amostrado mudar a cada passo da
    // câmera, e as estrelas piscariam continuamente enquanto o jogador navega —
    // o defeito clássico de LOD ancorado no observador.
    // -----------------------------------------------------------------------
    if (passo > 1 && ((z % passo) + passo) % passo !== 0) continue;

    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (passo > 1 && ((x % passo) + passo) % passo !== 0) continue;

        const dx = x - cx, dy = y - cy, dz = z - cz;
        if (dx * dx + dy * dy + dz * dz > raioSq) continue;

        const n = contagemNoVoxel(galaxia, x, y, z);
        for (let i = 0; i < n; i++) yield sistemaEm(galaxia, x, y, z, i);
      }
    }
  }
}

/**
 * Onde ancorar uma semente que não nasceu do mapa.
 *
 * O jogo pode começar com um seed qualquer (`?seed=12345`, um universo salvo de
 * antes de existir mapa). Essa semente não corresponde a nenhum sistema gerado,
 * e mesmo assim o mapa precisa de um "você está aqui" — estável entre sessões e,
 * sobretudo, DENTRO da galáxia.
 *
 * A primeira versão derivava as coordenadas direto dos bits da semente e caía
 * fora do disco quase metade das vezes: com raio 103 num disco de 96, a
 * densidade é zero e o mapa abria vazio, sem uma estrela sequer.
 *
 * Aqui as coordenadas nascem em POLARES, o que mantém o ponto dentro do disco
 * por construção, e depois procuram em espiral o primeiro voxel povoado — o
 * jogador é ancorado ao lado de vizinhos reais, que é o que torna o primeiro
 * salto possível.
 */
export function voxelDeAncoragem(galaxia, seed) {
  const h = misturar(seed >>> 0);
  const angulo = ((h & 0xffff) / 0xffff) * Math.PI * 2;
  // Raiz quadrada distribui por área; a faixa evita o bojo lotado e a borda
  // rarefeita, que são os dois lugares onde um começo seria estranho.
  const raio = (0.25 + Math.sqrt(((h >>> 16) & 0xffff) / 0xffff) * 0.55) * RAIO_GALAXIA;

  const alvo = {
    x: Math.round(Math.cos(angulo) * raio),
    y: ((h >>> 8) % 5) - 2,
    z: Math.round(Math.sin(angulo) * raio),
  };

  if (contagemNoVoxel(galaxia, alvo.x, alvo.y, alvo.z) > 0) return alvo;

  // Busca em cascas crescentes até achar companhia. Os braços espirais deixam
  // vazios grandes, e cair num deles é perfeitamente possível.
  for (let r = 1; r <= 24; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          // Só a casca: o interior já foi visto nas iterações anteriores.
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = alvo.x + dx, y = alvo.y + dy, z = alvo.z + dz;
          if (contagemNoVoxel(galaxia, x, y, z) > 0) return { x, y, z };
        }
      }
    }
  }
  return { x: 0, y: 0, z: 0 }; // o centro sempre tem estrelas
}

/**
 * Encontra o voxel/índice que gera uma dada semente, perto de uma referência.
 *
 * Existe por causa de um detalhe do fluxo: o jogo guarda o SEED do sistema
 * atual (é o que reconstrói o mundo), mas o mapa precisa saber ONDE aquela
 * estrela fica. Como a semente é um hash de mão única, o caminho de volta é
 * procurar — e procurar só é viável porque o sistema atual está, por
 * construção, perto de onde o jogador estava.
 *
 * @returns {object|null}
 */
export function acharPorSeed(galaxia, seed, cx, cy, cz, raio = 6) {
  for (const s of sistemasNoRaio(galaxia, cx, cy, cz, raio)) {
    if (s.seed === seed) return s;
  }
  return null;
}
