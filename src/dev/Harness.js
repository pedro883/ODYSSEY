/**
 * Bancada de inspeção visual — só existe em desenvolvimento.
 *
 * Ativada por `?dev=1`, e o módulo inteiro é descartado no build de produção
 * (`import.meta.env.DEV` é constante e o bundler elimina o ramo morto).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ISTO EXISTE
 * ---------------------------------------------------------------------------
 * Julgar uma mudança visual — cor de folhagem, densidade de nuvem, névoa —
 * exige VER o quadro certo, e chegar nele à mão significa decolar, achar um
 * bioma, pousar e enquadrar, toda vez. Pior: qualquer edição de shader
 * recarrega a página e joga tudo fora.
 *
 * Com esta bancada, montar a cena e capturar viram duas chamadas, e as duas
 * sobrevivem ao recarregamento porque moram no próprio projeto.
 *
 *   __dev.achar(3, 'Floresta')   procura um ponto do bioma no lado iluminado
 *   __dev.por(3, alvo, 18)       põe a nave lá, orientada pelo "para cima" local
 *   __dev.segurar(3, alvo, 18, 400)  roda N frames PRENDENDO a nave no ponto
 *   __dev.enviar('nome')         grava o JPEG via o receptor local
 *
 * `segurar` não é preciosismo: enquanto o terreno carrega, a nave escorrega
 * pelo relevo e sai do bioma que se queria fotografar.
 */

const RECEPTOR = 'http://localhost:5199/';

export function installHarness(context) {
  const { engine, starSystem, ship, shipController, THREE } = context;
  const gl = engine.renderer.getContext();

  /** Cede o laço de eventos sem `setTimeout` — que aba oculta estrangula. */
  const tick = () =>
    new Promise((resolve) => {
      const canal = new MessageChannel();
      canal.port1.onmessage = () => resolve();
      canal.port2.postMessage(0);
    });

  let elapsed = 0;

  const harness = {
    /**
     * Captura o framebuffer como JPEG em base64.
     *
     * Lê os pixels do WebGL em vez de usar `toDataURL`: o canvas só tem
     * conteúdo válido no mesmo task do render, e `readPixels` funciona mesmo
     * quando a aba não está compondo frames na tela.
     */
    capturar(largura = 760, altura = 460, qualidade = 0.6) {
      engine.renderer.setSize(largura, altura, false);
      engine.camera.aspect = largura / altura;
      engine.camera.updateProjectionMatrix();
      engine.renderTarget?.setSize(largura, altura);
      engine.render();

      const pixels = new Uint8Array(largura * altura * 4);
      gl.readPixels(0, 0, largura, altura, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

      const canvas = document.createElement('canvas');
      canvas.width = largura;
      canvas.height = altura;
      const ctx = canvas.getContext('2d');
      const imagem = ctx.createImageData(largura, altura);
      // O WebGL entrega a primeira linha embaixo; o canvas espera em cima.
      for (let y = 0; y < altura; y++) {
        for (let x = 0; x < largura; x++) {
          const origem = ((altura - 1 - y) * largura + x) * 4;
          const destino = (y * largura + x) * 4;
          imagem.data[destino] = pixels[origem];
          imagem.data[destino + 1] = pixels[origem + 1];
          imagem.data[destino + 2] = pixels[origem + 2];
          imagem.data[destino + 3] = 255;
        }
      }
      ctx.putImageData(imagem, 0, 0);
      return canvas.toDataURL('image/jpeg', qualidade).split(',')[1];
    },

    async enviar(nome, largura, altura, qualidade) {
      const dados = this.capturar(largura, altura, qualidade);
      await fetch(RECEPTOR + nome, { method: 'POST', body: dados });
      return dados.length;
    },

    /**
     * Procura um ponto do bioma pedido, no lado iluminado, com VIZINHANÇA do
     * mesmo bioma — senão a foto sai de uma ilha isolada de floresta cercada
     * de deserto, que não representa nada.
     */
    achar(indice, bioma, tentativas = 900) {
      const planeta = starSystem.planets[indice];
      const sol = starSystem.sunDirection;
      const eixo = new THREE.Vector3();

      for (let i = 0; i < tentativas; i++) {
        const dir = new THREE.Vector3(
          Math.random() * 2 - 1,
          Math.random() * 2 - 1,
          Math.random() * 2 - 1
        ).normalize();

        if (dir.dot(sol) < 0) dir.negate();
        if (dir.dot(sol) < 0.45) continue;

        const ponto = planeta.group.position.clone().addScaledVector(dir, planeta.radius * 2);
        if (bioma && planeta.biomeAt(ponto) !== bioma) continue;

        eixo.set(-dir.y, dir.x, 0);
        if (eixo.lengthSq() < 1e-6) eixo.set(1, 0, 0);
        eixo.normalize();
        const outro = new THREE.Vector3().crossVectors(dir, eixo);

        let acertos = 0;
        for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const vizinho = dir
            .clone()
            .addScaledVector(eixo, a * 0.016)
            .addScaledVector(outro, b * 0.016)
            .normalize();
          const mundo = planeta.group.position.clone().addScaledVector(vizinho, planeta.radius * 2);
          if (!bioma || planeta.biomeAt(mundo) === bioma) acertos++;
        }
        if (acertos >= 3) {
          return { dir, surface: planeta.sampleAt(ponto).surfaceRadius, acertos };
        }
      }
      return null;
    },

    /** Põe a nave no alvo, com a câmera nivelada pelo "para cima" local. */
    por(indice, alvo, altura = 16) {
      const planeta = starSystem.planets[indice];
      ship.group.position.copy(planeta.group.position).addScaledVector(alvo.dir, alvo.surface + altura);
      // Sem isto a câmera nasce rolada: `lookAt` usa `object.up`, que continua
      // sendo o +Y global enquanto o "para cima" de verdade é radial.
      ship.group.up.copy(alvo.dir);

      const tangente = new THREE.Vector3(0, 1, 0).cross(alvo.dir);
      if (tangente.lengthSq() < 1e-6) tangente.set(1, 0, 0);
      tangente.normalize();
      ship.group.lookAt(ship.group.position.clone().add(tangente));
      ship.group.rotateY(Math.PI);

      shipController.velocity.set(0, 0, 0);
      shipController.throttle = 0;
    },

    /**
     * Põe o sol a pino sobre um alvo.
     *
     * O ciclo dia/noite gira a estrela por `elapsed * 0.012` (ver
     * `StarField.js`), então a hora do dia é função do tempo acumulado — e
     * fotografar sempre "quando calhar" mistura poente com meio-dia e
     * inviabiliza comparar duas versões da mesma cena.
     */
    aoMeioDia(alvo) {
      elapsed = Math.atan2(alvo.dir.z, alvo.dir.x) / 0.012;
      return elapsed;
    },

    async rodar(frames) {
      for (let i = 0; i < frames; i++) {
        elapsed += 0.016;
        engine._update(0.016, elapsed);
        engine.render();
        await tick();
      }
    },

    async segurar(indice, alvo, altura, frames) {
      for (let i = 0; i < frames; i++) {
        this.por(indice, alvo, altura);
        elapsed += 0.016;
        engine._update(0.016, elapsed);
        engine.render();
        await tick();
      }
    },
  };

  window.__dev = harness;
  console.info('[NMS] bancada de desenvolvimento em window.__dev');
  return harness;
}
