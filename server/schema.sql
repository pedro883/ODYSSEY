-- =============================================================================
-- Esquema do Odyssey.
--
-- A PREMISSA QUE MANTÉM ISTO PEQUENO
-- O universo inteiro é função de um inteiro (o seed): terreno, biomas, posição
-- de cada arbusto e espécie de cada bicho se recalculam iguais em qualquer
-- máquina. Nada disso entra aqui. O banco guarda só o que o JOGADOR muda —
-- e é por isso que um MMO procedural cabe em quatro tabelas.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS odyssey
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE odyssey;

-- -----------------------------------------------------------------------------
-- Contas
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conta (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- O login é comparado sem diferenciar maiúsculas (collation _ci), então
  -- "Pedro" e "pedro" são a MESMA conta. Sem isso, duas pessoas criam contas
  -- que parecem iguais na tela e ninguém entende por que a senha "não funciona".
  login         VARCHAR(24)  NOT NULL,
  -- scrypt: `salt:hash` em hexadecimal. O algoritmo vem do próprio Node
  -- (`crypto.scrypt`), então não há dependência externa para algo tão sensível.
  senha         VARCHAR(255) NOT NULL,
  criada_em     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ultimo_acesso TIMESTAMP    NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_conta_login (login)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Progresso por conta E por universo
--
-- A chave inclui o seed: o mesmo jogador em outro sistema estelar é outro
-- progresso. Sem isso, trocar de seed traria um inventário coletado num mundo
-- que não existe mais.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS progresso (
  conta_id    INT UNSIGNED NOT NULL,
  seed        INT UNSIGNED NOT NULL,
  unidades    INT UNSIGNED NOT NULL DEFAULT 0,
  -- JSON e não tabelas normalizadas: inventário e catálogo são lidos e escritos
  -- SEMPRE inteiros, nunca consultados por item. Normalizar aqui só criaria
  -- junções para reconstruir o mesmo objeto que o cliente já manda pronto.
  inventario  JSON         NULL,
  descobertas JSON         NULL,
  -- Onde a pessoa parou: corpo, modo (nave/a pé), posição RELATIVA AO CENTRO
  -- do planeta, orientação da nave e direção do olhar. Coordenada de mundo não
  -- serviria: a origem flutuante desloca a cena inteira conforme se anda, então
  -- o mesmo número significa lugares diferentes em duas sessões.
  posicao     JSON         NULL,
  atualizado  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (conta_id, seed),
  CONSTRAINT fk_progresso_conta FOREIGN KEY (conta_id) REFERENCES conta (id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Props colhidos — a única mutação PERMANENTE do mundo
--
-- Não tem dono: um arbusto colhido por qualquer jogador some para todos, e
-- continua sumido depois de reiniciar o servidor. É o estado que hoje vive só
-- na memória da sala.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS colhido (
  seed    INT UNSIGNED NOT NULL,
  planeta SMALLINT UNSIGNED NOT NULL,
  -- A chave do chunk vem da quadtree ("face:u:v:tamanho") e é opaca para o
  -- banco: o cliente devolve a mesma string ao carregar o chunk.
  chunk   VARCHAR(64)  NOT NULL,
  indice  SMALLINT UNSIGNED NOT NULL,
  quando  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (seed, planeta, chunk, indice),
  -- A sala carrega TUDO de um universo ao subir; este índice é o que faz essa
  -- carga ser uma varredura de faixa em vez da tabela inteira.
  KEY idx_colhido_universo (seed)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Bases construídas
--
-- Uma peça por linha. A chave é o SLOT (base + célula + face), o que faz o
-- próprio banco garantir aquilo que a sala também garante em memória: nunca
-- duas peças no mesmo lugar.
--
-- POR QUE O `frame` SE REPETE EM TODA LINHA
-- O referencial da base (origem e rotação da placa tangente à superfície — ver
-- `src/game/BuildSystem.js`) é o mesmo para todas as peças dela, e normalizá-lo
-- numa tabela `base` seria o modelo correto. Não está assim de propósito: são
-- sete números por linha, contra uma junção em toda leitura e uma segunda
-- escrita no caminho quente de cada clique. Se um dia as bases crescerem para
-- milhares de peças, esta é a primeira coisa a normalizar.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS construcao (
  seed    INT UNSIGNED NOT NULL,
  base    CHAR(16)     NOT NULL,
  cx      SMALLINT     NOT NULL,
  cy      SMALLINT     NOT NULL,
  cz      SMALLINT     NOT NULL,
  -- Slot dentro da célula: -1 piso, -2 mobília, 0 e 3 as arestas canônicas.
  face    TINYINT      NOT NULL,
  planeta SMALLINT UNSIGNED NOT NULL,
  peca    VARCHAR(24)  NOT NULL,
  giro    TINYINT UNSIGNED NOT NULL DEFAULT 0,
  frame   JSON         NOT NULL,
  quando  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (seed, base, cx, cy, cz, face),
  KEY idx_construcao_universo (seed)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Terreno escavado
--
-- A OUTRA mutação permanente do mundo, ao lado de `colhido`. O relevo continua
-- sendo função pura do seed; o que esta tabela guarda é a CAMADA de correções
-- que se soma por cima dele (ver `src/shared/edits.js`).
--
-- `id` vem do cliente e é a chave: enquanto o jogador segura o botão, a mesma
-- escavação é reenviada com a profundidade crescendo, e o servidor sobrescreve
-- em vez de empilhar. Uma cratera custa uma linha, não uma por frame.
--
-- O platô sob uma base NÃO entra aqui: ele é função pura das peças da base e
-- cada cliente o recalcula sozinho.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terreno (
  seed    INT UNSIGNED NOT NULL,
  planeta SMALLINT UNSIGNED NOT NULL,
  id      CHAR(16)     NOT NULL,
  -- Direção UNITÁRIA na esfera. Não é latitude/longitude de propósito: o
  -- amostrador trabalha em vetores, e converter nas duas pontas só criaria
  -- oportunidade de erro nos polos.
  x       DOUBLE       NOT NULL,
  y       DOUBLE       NOT NULL,
  z       DOUBLE       NOT NULL,
  r       FLOAT        NOT NULL,
  f       FLOAT        NOT NULL,
  -- 0 = somar (cavar/elevar), 1 = nivelar (platô).
  t       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  quando  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (seed, planeta, id),
  KEY idx_terreno_universo (seed)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Usuário da aplicação
--
-- O servidor NÃO usa root: ele só precisa ler e escrever nestas tabelas. Se um
-- dia a sala for comprometida, o estrago fica dentro do banco do jogo.
-- -----------------------------------------------------------------------------
CREATE USER IF NOT EXISTS 'odyssey'@'localhost' IDENTIFIED BY 'odyssey';
GRANT SELECT, INSERT, UPDATE, DELETE ON odyssey.* TO 'odyssey'@'localhost';
FLUSH PRIVILEGES;
