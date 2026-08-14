import { defineConfig } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Recebe capturas de tela do jogo e as grava em `capturas/`.
 *
 * SÓ EM DESENVOLVIMENTO (`apply: 'serve'`), e existe por um motivo prático: o
 * canvas WebGL não pode ser lido de fora do navegador, então avaliar uma
 * mudança de shader exigia descrever a tela em palavras ou copiar a imagem em
 * base64 pelo console — caro e ruim. Com este endpoint, a página manda o PNG e
 * o arquivo aparece no projeto, onde qualquer ferramenta o abre.
 *
 * Da página:
 *   fetch('/__captura/nome.jpg', { method: 'POST', body: <dataURL ou base64> })
 */
function plugincapturas() {
  return {
    name: 'nms-capturas',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__captura', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let corpo = '';
        req.on('data', (p) => (corpo += p));
        req.on('end', () => {
          try {
            const nome = (req.url || '/captura.jpg').replace(/[^\w.-]/g, '').slice(0, 64) || 'captura.jpg';
            const base64 = corpo.includes(',') ? corpo.slice(corpo.indexOf(',') + 1) : corpo;
            const pasta = resolve(process.cwd(), 'capturas');
            mkdirSync(pasta, { recursive: true });
            writeFileSync(resolve(pasta, nome), Buffer.from(base64, 'base64'));
            res.statusCode = 200;
            res.end(nome);
          } catch (erro) {
            res.statusCode = 500;
            res.end(String(erro));
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [plugincapturas()],

  /**
   * Caminhos RELATIVOS nos assets gerados.
   *
   * Com o padrão (`base: '/'`) o index.html aponta para `/assets/index-xxx.js`,
   * ou seja, a RAIZ do domínio. Se o projeto for hospedado numa subpasta
   * (`seudominio.com/nms/`) ou num subdomínio apontando para um diretório,
   * o navegador procura os arquivos no lugar errado e a página fica em branco
   * — com 404 nos assets no console.
   *
   * Com './' o mesmo build funciona tanto na raiz quanto em qualquer subpasta,
   * sem precisar saber o caminho final na hora de compilar.
   */
  base: './',

  server: {
    port: 5173,
    /**
     * Escuta em TODAS as interfaces, não só em localhost.
     *
     * O padrão do Vite é `localhost`, e nesta máquina ele nem sequer abria em
     * IPv4: a porta ficava presa em `::1`. Do próprio PC funciona e de qualquer
     * outro a conexão é recusada sem explicação nenhuma — o navegador só diz
     * que o site não respondeu. É o primeiro obstáculo de quem tenta jogar em
     * rede local, e não há motivo para ele existir num projeto cujo sentido é
     * duas pessoas no mesmo universo.
     *
     * `true` equivale a `0.0.0.0` + `::`, e faz o Vite imprimir a URL de rede
     * no boot — que é justamente o endereço a passar para o outro computador.
     */
    host: true,
  },

  worker: {
    // Workers como ES modules: permite `import` dentro do terrain.worker.js
    // e compartilhar o codigo de ruido entre main thread e worker.
    format: 'es',
  },

  build: {
    target: 'esnext',
    /**
     * Sem source maps em produção: o arquivo .map tem ~3 MB (5x o bundle),
     * consome banda da hospedagem e publica o código-fonte inteiro.
     * Para depurar um problema só reproduzível em produção, ligue
     * temporariamente com `sourcemap: true` e refaça o build.
     */
    sourcemap: false,
  },
});
