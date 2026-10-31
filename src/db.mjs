// Banco SQLite local (node:sqlite). Datas em ISO 8601 UTC; durações em segundos.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

const ESQUEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Pessoas que entram no painel (não confundir com os técnicos do Digisac).
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nome TEXT NOT NULL,
  perfil TEXT NOT NULL CHECK (perfil IN ('admin','coordenador','tecnico')),
  tecnico_id TEXT,                 -- vínculo com o usuário Digisac, para o perfil técnico
  senha_hash TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  expira_em TEXT NOT NULL
);

-- Trilha de auditoria: quem fez o quê, inclusive leitura de conversas (LGPD).
CREATE TABLE IF NOT EXISTS auditoria (
  id INTEGER PRIMARY KEY,
  quando TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  usuario_id INTEGER,
  acao TEXT NOT NULL,
  alvo TEXT,
  detalhe TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS ix_auditoria_quando ON auditoria(quando);

-- Espelho do Digisac ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS tecnicos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  bruto TEXT
);

CREATE TABLE IF NOT EXISTS departamentos (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  monitorado INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS contatos (
  id TEXT PRIMARY KEY,
  nome TEXT,
  numero TEXT,
  empresa TEXT
);

CREATE TABLE IF NOT EXISTS chamados (
  id TEXT PRIMARY KEY,
  protocolo TEXT,
  aberto INTEGER NOT NULL,
  contato_id TEXT,
  departamento_id TEXT,
  tecnico_id TEXT,
  assunto TEXT,
  iniciado_em TEXT,
  encerrado_em TEXT,
  atualizado_em TEXT,
  -- Métricas calculadas a partir das mensagens (ver indicadores.mjs)
  primeira_resposta_seg INTEGER,
  duracao_seg INTEGER,
  msgs_cliente INTEGER NOT NULL DEFAULT 0,
  msgs_tecnico INTEGER NOT NULL DEFAULT 0,
  msgs_bot INTEGER NOT NULL DEFAULT 0,
  transferencias INTEGER NOT NULL DEFAULT 0,
  mensagens_sincronizadas_em TEXT,
  bruto TEXT
);
CREATE INDEX IF NOT EXISTS ix_chamados_iniciado ON chamados(iniciado_em);
CREATE INDEX IF NOT EXISTS ix_chamados_tecnico ON chamados(tecnico_id);

CREATE TABLE IF NOT EXISTS mensagens (
  id TEXT PRIMARY KEY,
  chamado_id TEXT NOT NULL REFERENCES chamados(id) ON DELETE CASCADE,
  quando TEXT NOT NULL,
  autor TEXT NOT NULL CHECK (autor IN ('cliente','tecnico','bot','comentario','sistema')),
  tecnico_id TEXT,
  tipo TEXT,
  texto TEXT
);
CREATE INDEX IF NOT EXISTS ix_mensagens_chamado ON mensagens(chamado_id, quando);

-- Respostas de pesquisa de satisfação (CSAT/NPS) do próprio Digisac.
CREATE TABLE IF NOT EXISTS avaliacoes (
  id TEXT PRIMARY KEY,
  chamado_id TEXT,
  tecnico_id TEXT,
  tipo TEXT,
  nota REAL,
  comentario TEXT,
  respondido_em TEXT,
  bruto TEXT
);
CREATE INDEX IF NOT EXISTS ix_avaliacoes_chamado ON avaliacoes(chamado_id);

-- Inteligência Artificial ----------------------------------------------------
-- Uma análise por chamado (a mais recente). Nada aqui conta como definitivo
-- até a coordenação revisar: status 'pendente' -> 'aprovada' | 'ajustada' | 'descartada'.
CREATE TABLE IF NOT EXISTS analises_ia (
  chamado_id TEXT PRIMARY KEY REFERENCES chamados(id) ON DELETE CASCADE,
  sentimento TEXT NOT NULL,
  intensidade REAL,
  insatisfacao INTEGER NOT NULL,
  motivos TEXT,                    -- JSON
  nota_qualidade REAL,
  criterios TEXT,                  -- JSON
  resumo TEXT,
  pontos_melhoria TEXT,            -- JSON
  evidencias TEXT,                 -- JSON
  confianca REAL,
  modelo TEXT,
  versao_prompt TEXT,
  analisado_em TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovada','ajustada','descartada')),
  revisado_por INTEGER REFERENCES usuarios(id),
  revisado_em TEXT,
  sentimento_revisado TEXT,
  nota_revisada REAL,
  observacao_revisao TEXT
);

CREATE TABLE IF NOT EXISTS erros_ia (
  chamado_id TEXT PRIMARY KEY,
  quando TEXT NOT NULL,
  motivo TEXT
);

-- Sincronização e conferência -------------------------------------------------
CREATE TABLE IF NOT EXISTS estado (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

CREATE TABLE IF NOT EXISTS execucoes_sync (
  id INTEGER PRIMARY KEY,
  inicio TEXT NOT NULL,
  fim TEXT,
  status TEXT NOT NULL,
  chamados INTEGER DEFAULT 0,
  mensagens INTEGER DEFAULT 0,
  avaliacoes INTEGER DEFAULT 0,
  analises INTEGER DEFAULT 0,
  erro TEXT
);

-- Fotografia dos números oficiais do Digisac para comparar com os nossos.
CREATE TABLE IF NOT EXISTS conferencias (
  id INTEGER PRIMARY KEY,
  quando TEXT NOT NULL,
  de TEXT NOT NULL,
  ate TEXT NOT NULL,
  local TEXT NOT NULL,             -- JSON
  digisac TEXT                     -- JSON (resposta de /dashboard/general)
);

-- --- Gestão da equipe (modelo trazido da Base Bruno) ----------------------------
-- Ligações da fila "Ponto Eletrônico" da GoTo. O técnico é ligado na consulta, pelo
-- tecnicos.goto_agente, para que corrigir o vínculo não exija reimportar.
CREATE TABLE IF NOT EXISTS ligacoes (
  id TEXT PRIMARY KEY,             -- contact_id da GoTo
  fila TEXT NOT NULL,
  agente TEXT NOT NULL,            -- nome do atendente na GoTo
  inicio TEXT NOT NULL,            -- ISO (UTC)
  dia TEXT NOT NULL,               -- YYYY-MM-DD, horário de Brasília
  hora INTEGER,                    -- 0-23, horário de Brasília
  espera_seg REAL,                 -- tempo na fila (TME)
  conversa_seg REAL,
  pos_seg REAL,                    -- pós-atendimento (wrap)
  total_seg REAL,                  -- TMA = conversa + pós
  resultado TEXT
);
CREATE INDEX IF NOT EXISTS ix_ligacoes_dia ON ligacoes(dia, agente);

CREATE TABLE IF NOT EXISTS pausas (
  id INTEGER PRIMARY KEY,
  agente TEXT NOT NULL,
  dia TEXT NOT NULL,
  motivo TEXT NOT NULL,
  duracao_seg REAL NOT NULL DEFAULT 0,
  quantidade INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_pausas_dia ON pausas(dia, agente);

CREATE TABLE IF NOT EXISTS escalas (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL UNIQUE,
  hora_inicio TEXT NOT NULL,       -- HH:MM
  hora_fim TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1
);

-- Escala de cada técnico com vigência (histórico): a vigente é a de maior "desde" <= dia.
CREATE TABLE IF NOT EXISTS tecnico_escalas (
  id INTEGER PRIMARY KEY,
  tecnico_id TEXT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  escala_id INTEGER NOT NULL REFERENCES escalas(id),
  desde TEXT NOT NULL,
  ate TEXT,
  motivo TEXT,
  UNIQUE(tecnico_id, desde)
);

-- Meta diária de atendimentos a partir de uma data (vale até a próxima).
CREATE TABLE IF NOT EXISTS metas_periodo (
  id INTEGER PRIMARY KEY,
  tecnico_id TEXT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  desde TEXT NOT NULL,
  meta REAL NOT NULL,
  observacao TEXT,
  UNIQUE(tecnico_id, desde)
);

CREATE TABLE IF NOT EXISTS feriados (
  dia TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'nacional' CHECK (tipo IN ('nacional','estadual','municipal','facultativo','empresa')),
  ativo INTEGER NOT NULL DEFAULT 1
);

-- Sem registro no dia = Presente (100%). fracao = parte do dia disponível (0 a 1).
CREATE TABLE IF NOT EXISTS disponibilidade (
  tecnico_id TEXT NOT NULL REFERENCES tecnicos(id) ON DELETE CASCADE,
  dia TEXT NOT NULL,
  status TEXT NOT NULL,
  fracao REAL NOT NULL,
  hora_inicio_ausencia TEXT,
  hora_fim_ausencia TEXT,
  meta_do_dia REAL,                -- substitui a meta só neste dia (opcional)
  observacao TEXT,
  PRIMARY KEY (tecnico_id, dia)
);
`;

mkdirSync(path.dirname(config.arquivoBanco), { recursive: true });
export const db = new DatabaseSync(config.arquivoBanco);
db.exec(ESQUEMA);

// Migrações simples (colunas adicionadas depois da primeira versão).
for (const [tabela, coluna, tipo] of [['avaliacoes', 'origem', 'TEXT'], ['avaliacoes', 'texto_ia', 'TEXT'],
  ['mensagens', 'transcricao', 'TEXT'], ['mensagens', 'transcricao_erro', 'TEXT'],
  // Cadastro de gestão do técnico (o resto vem do Digisac).
  ['tecnicos', 'na_equipe', 'INTEGER NOT NULL DEFAULT 0'], ['tecnicos', 'matricula', 'TEXT'],
  ['tecnicos', 'data_admissao', 'TEXT'], ['tecnicos', 'funcao', 'TEXT'], ['tecnicos', 'jornada_min', 'INTEGER'],
  ['tecnicos', 'meta_padrao', 'REAL'], ['tecnicos', 'goto_agente', 'TEXT'], ['tecnicos', 'situacao', "TEXT NOT NULL DEFAULT 'Ativo'"]]) {
  const existe = db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
  if (!existe) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
}

export const agora = () => new Date().toISOString();

export function lerEstado(chave, padrao = null) {
  const linha = db.prepare('SELECT valor FROM estado WHERE chave = ?').get(chave);
  return linha ? linha.valor : padrao;
}

export function gravarEstado(chave, valor) {
  db.prepare('INSERT INTO estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor')
    .run(chave, valor == null ? null : String(valor));
}

export function transacao(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function auditar(usuarioId, acao, alvo = null, detalhe = null, ip = null) {
  db.prepare('INSERT INTO auditoria (usuario_id, acao, alvo, detalhe, ip) VALUES (?, ?, ?, ?, ?)')
    .run(usuarioId ?? null, acao, alvo, detalhe == null ? null : (typeof detalhe === 'string' ? detalhe : JSON.stringify(detalhe)), ip);
}
