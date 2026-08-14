/**
 * Bancada de CAPTURA — só desenvolvimento.
 *
 * Existe porque avaliar uma mudança de shader exige OLHAR para a tela, e o
 * canvas WebGL não pode ser lido de fora do navegador. Este módulo posiciona a
 * nave em pontos escolhidos do planeta, deixa a cena assentar e manda o quadro
 * para o endpoint `/__captura` (ver `vite.config.js`), que grava o arquivo em
 * `capturas/`.
 *
 * Uso, no console (ou por automação):
 *   const c = await import('/src/dev/Capturas.js'); await c.ensaio();
 *
 * Nada disto entra no build: o módulo só é importado sob demanda.
 */

const passo = () => new Promise((r) => setTimeout(r, 0));

/**
 * Instante do dia usado em TODA captura.
 *
 * Precisa ser fixo: `elapsed` governa o ciclo dia/noite (ver
 * `StarSystem.updateBackdrop`), então passar o relógio real fazia o sol andar
 * entre a escolha do ponto e o disparo da foto — o ponto era escolhido no lado
 * iluminado e fotografado à meia-noite. Perdi duas capturas com isso.
 */
export const HORA = 0;

/** Roda o laço do jogo N vezes sem depender do requestAnimationFrame. */
async function rodar(quadros, aoRodar, aoRodarDepois) {
  const n = window.__nms;
  for (let i = 0; i < quadros; i++) {
    aoRodar?.(i);
    // O `elapsed` fica parado; só o `dt` avança, para que ondas, nuvens e
    // animações continuem correndo sem mexer na posição do sol.
    n.engine._update(1 / 60, HORA);
    // -------------------------------------------------------------------
    // O SEGUNDO GANCHO RODA DEPOIS DA FÍSICA, e é o que permite enquadrar.
    //
    // `_update` chama `shipController.update`, que AUTO-NIVELA a nave em
    // direção ao horizonte. Definir a orientação antes dele funciona para
    // panorâmicas — o auto-nível concorda com elas — e é apagado em qualquer
    // enquadramento mergulhado. Foi o que fez quatro tentativas de fotografar
    // uma boca de caverna saírem apontadas para o céu, sem erro nenhum: a
    // orientação era aplicada e desfeita no mesmo quadro.
    // -------------------------------------------------------------------
    aoRodarDepois?.(i);
    await passo();
  }
}

/**
 * Garante um tamanho de canvas para a foto.
 *
 * O painel do navegador pode estar oculto, e aí `innerWidth/innerHeight` valem
 * ZERO: o `resize` do Engine dimensiona o canvas para 0×0 e `toDataURL` devolve
 * `data:,` — um arquivo vazio, sem erro nenhum no console. Perdi um ensaio
 * inteiro nisso.
 */
export function enquadrar(largura = 1280, altura = 720) {
  const e = window.__nms.engine;
  const cv = e.renderer.domElement;
  if (cv.width === largura && cv.height === altura) return;

  e.renderer.setSize(largura, altura, false);
  e.camera.aspect = largura / altura;
  e.camera.updateProjectionMatrix();

  const ratio = e.renderer.getPixelRatio();
  const l = Math.round(largura * ratio);
  const a = Math.round(altura * ratio);
  e.renderTarget?.setSize(l, a);
  e.alvoComposto?.setSize(l, a);
  e.post?.redimensionar(l, a);
  window.__nms.galaxyMap.redimensionar(largura / altura);
}

async function enviar(nome) {
  const n = window.__nms;
  enquadrar();
  n.engine.render();
  const url = n.engine.renderer.domElement.toDataURL('image/jpeg', 0.82);
  await fetch('/__captura/' + nome, { method: 'POST', body: url });
  return nome;
}

/**
 * Um ponto de terra no lado iluminado, o mais alto que encontrar.
 * @param {object} opcoes
 */
export function acharPonto({ elevacaoMinima = 30, elevacaoMaxima = Infinity, exigirSol = true, agua = false } = {}) {
  const n = window.__nms;
  const p = n.activePlanet;
  const V = n.engine.camera.position.constructor;
  const sol = n.starSystem.sunDirection;

  let melhor = null;
  for (let k = 0; k < 9000; k++) {
    const d = new V(Math.sin(k * 1.7), Math.cos(k * 2.3) * 0.7, Math.cos(k * 1.1)).normalize();
    // Sol bem alto: rasante o terreno vira silhueta e não dá para julgar cor.
    if (exigirSol && d.dot(sol) < 0.72) continue;
    const s = p.sampleAt(p.group.position.clone().addScaledVector(d, p.config.radius + 5));
    if (agua) {
      // Beira-mar: fundo raso, para pegar a faixa de espuma e o gradiente.
      if (s.elevation > -12 && s.elevation < -1 && (!melhor || s.elevation > melhor.s.elevation)) {
        melhor = { d, s };
      }
    } else if (
      s.elevation > elevacaoMinima &&
      s.elevation < elevacaoMaxima &&
      (!melhor || s.elevation > melhor.s.elevation)
    ) {
      melhor = { d, s };
    }
  }
  return melhor;
}

/**
 * Fixa a nave num ponto, mirando outro, e captura.
 *
 * A posição é reafirmada A CADA QUADRO porque a física continua rodando: sem
 * isso a nave despenca durante os segundos que a cena leva para carregar os
 * chunks, e a captura sai de um lugar diferente do pedido.
 */
export async function capturar(nome, { ponto, altura = 60, distanciaAlvo = 200, alturaAlvo = 0, quadros = 240 }) {
  const n = window.__nms;
  const p = n.activePlanet;
  const V = n.engine.camera.position.constructor;
  const M4 = n.engine.camera.matrixWorld.constructor;

  const tang = new V(-ponto.d.y, ponto.d.x, 0).normalize();
  const dirAlvo = ponto.d.clone().addScaledVector(tang, distanciaAlvo / p.config.radius).normalize();
  const sAlvo = p.sampleAt(p.group.position.clone().addScaledVector(dirAlvo, p.config.radius + 5));
  const alvo = p.group.position
    .clone()
    .addScaledVector(dirAlvo, Math.max(sAlvo.surfaceRadius, p.config.radius) + alturaAlvo);

  const olho = new V();
  const paraAlvo = new V();
  const cima = new V();

  const fixar = () => {
    olho
      .copy(p.group.position)
      .addScaledVector(ponto.d, Math.max(ponto.s.surfaceRadius, p.config.radius) + altura);
    n.ship.group.position.copy(olho);
    n.shipController.velocity.set(0, 0, 0);
    n.shipController.throttle = 0;
    n.ship.group.quaternion.setFromRotationMatrix(
      new M4().lookAt(olho, alvo, escolherCima(paraAlvo.copy(alvo).sub(olho), ponto.d, cima))
    );
  };

  // Antes E depois: antes para que a física deste quadro parta do lugar certo,
  // depois para desfazer o auto-nível. A câmera é reposicionada em seguida,
  // porque `updateCamera` já rodou dentro de `_update` com a pose antiga.
  await rodar(quadros, fixar, () => {
    fixar();
    n.shipController.updateCamera(n.engine.camera, 1);
  });

  return enviar(nome);
}

/**
 * Um "para cima" que nunca é paralelo à direção do olhar.
 *
 * ===========================================================================
 * POR QUE ISTO PRECISOU EXISTIR
 * ===========================================================================
 * A bancada sempre usou a direção RADIAL como `up`, o que é certo para
 * panorâmicas: o horizonte fica nivelado. Mas ao mirar quase para baixo — que é
 * o enquadramento de uma boca de caverna — a direção do olhar fica paralela ao
 * radial, `lookAt` degenera e a câmera aponta para qualquer lugar.
 *
 * Perdi quatro tentativas de fotografar uma caverna com isso, todas terminando
 * com a câmera virada para o céu. O sintoma engana porque não há erro nenhum:
 * a matriz sai válida, só que arbitrária.
 *
 * A saída é trocar o `up` por uma tangente quando o olhar se aproxima do
 * radial. O horizonte deixa de estar nivelado, o que não faz falta numa foto
 * que aponta para dentro de um buraco.
 *
 * @param {THREE.Vector3} olhar direção do olhar (não precisa ser unitária)
 * @param {THREE.Vector3} radial direção "para cima" preferida
 * @param {THREE.Vector3} saida
 */
function escolherCima(olhar, radial, saida) {
  const len = olhar.length() || 1;
  const alinhamento = Math.abs(olhar.dot(radial) / len);

  // Até ~70 graus do horizonte o radial serve e mantém o horizonte nivelado.
  if (alinhamento < 0.94) return saida.copy(radial);

  // Perto da vertical: qualquer tangente serve como referência de rolagem.
  saida.set(-radial.y, radial.x, 0);
  if (saida.lengthSq() < 1e-8) saida.set(1, 0, 0);
  return saida.normalize();
}

/**
 * Captura com a CÂMERA posta à mão, sem passar pela nave.
 *
 * ===========================================================================
 * POR QUE EXISTE, DEPOIS DE DUAS CORREÇÕES QUE NÃO BASTARAM
 * ===========================================================================
 * `capturar` enquadra movendo a NAVE e deixando a câmera de terceira pessoa
 * segui-la. Isso serve para panorâmicas e falha em qualquer enquadramento
 * mergulhado, por dois motivos empilhados:
 *
 *   1. a física auto-nivela a nave em direção ao horizonte, apagando o
 *      mergulho no mesmo quadro em que ele é aplicado;
 *   2. `updateCamera` rederiva a orientação do estado do CONTROLADOR, não do
 *      quaternion da nave — então reaplicá-lo depois da física também não
 *      resolve.
 *
 * Tentei corrigir os dois e continuei fotografando o céu. Para uma foto, a
 * nave é um intermediário que não acrescenta nada: esta função põe a câmera
 * onde se quer, aponta para onde se quer, e desenha. O laço do jogo nem roda.
 *
 * @param {string} nome arquivo de saída
 * @param {THREE.Vector3} de posição da câmera, em espaço de cena
 * @param {THREE.Vector3} para ponto observado
 * @param {THREE.Vector3} [radial] "para cima" preferido (ver `escolherCima`)
 */
export async function capturarCamera(nome, de, para, radial) {
  const n = window.__nms;
  const cam = n.engine.camera;
  const V = cam.position.constructor;
  const M4 = cam.matrixWorld.constructor;

  enquadrar();
  const cima = escolherCima(
    new V().copy(para).sub(de),
    radial ?? new V().copy(de).normalize(),
    new V()
  );

  cam.position.copy(de);
  cam.quaternion.setFromRotationMatrix(new M4().lookAt(de, para, cima));
  cam.updateMatrixWorld(true);

  // Sem `_update`: qualquer passo do jogo devolveria a câmera ao controlador.
  n.engine.render();
  const url = n.engine.renderer.domElement.toDataURL('image/jpeg', 0.9);
  await fetch('/__captura/' + nome, { method: 'POST', body: url });
  return nome;
}

/** Sequência padrão: terreno de perto, panorâmica e beira-mar. */
export async function ensaio(prefixo = '') {
  const n = window.__nms;
  // Boot: deixa o mundo carregar E o sol assumir a posição da HORA fixa antes
  // de escolher qualquer ponto.
  await rodar(n.starSystem.activeChunks < 200 ? 420 : 30);

  const terra = acharPonto({ elevacaoMinima: 10, elevacaoMaxima: 60 });
  const mar = acharPonto({ agua: true });
  const feitas = [];

  if (terra) {
    feitas.push(await capturar(`${prefixo}chao.jpg`, { ponto: terra, altura: 12, distanciaAlvo: 110 }));
    feitas.push(await capturar(`${prefixo}vale.jpg`, { ponto: terra, altura: 120, distanciaAlvo: 800, alturaAlvo: 40 }));
  }
  if (mar) {
    feitas.push(await capturar(`${prefixo}mar.jpg`, { ponto: mar, altura: 12, distanciaAlvo: 120, alturaAlvo: 0 }));
    feitas.push(await capturar(`${prefixo}mar_alto.jpg`, { ponto: mar, altura: 200, distanciaAlvo: 900, alturaAlvo: 0 }));
  }
  return feitas;
}
