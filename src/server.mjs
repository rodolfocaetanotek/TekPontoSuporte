// Servidor HTTP do Tek Ponto - Suporte Gestão (API + interface web).
// Uso: node src/server.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, digisacConfigurado, RAIZ } from './config.mjs';
import { db, agora, auditar, lerEstado, gravarEstado, transacao } from './db.mjs';
import * as auth from './auth.mjs';
import { painel, numerosParaConferencia } from './indicadores.mjs';
import { sincronizar, sincronizando, atualizarCadastros, selecaoDeDepartamentos } from './sync.mjs';
import { pedirAnalise, situacaoIa, MOTIVOS } from './ia.mjs';
import { Readable } from 'node:stream';
import { registrarRotasGestao } from './rotas-gestao.mjs';
import { importarSeMudou } from './base-goto.mjs';
import { voz } from './gestao.mjs';
import { estatisticasGerais, arquivoDaMensagem } from './digisac.mjs';

const PASTA_WEB = path.join(RAIZ, 'web');
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const CABECALHOS_SEGURANCA = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

class ErroHttp extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// --- Utilidades ---------------------------------------------------------------

function cookie(req, nome) {
  const m = (req.headers.cookie ?? '').match(new RegExp(`(?:^|;\\s*)${nome}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

async function corpoJson(req) {
  if (!String(req.headers['content-type']).startsWith('application/json')) throw new ErroHttp(415, 'Envie JSON');
  let bruto = '';
  for await (const parte of req) {
    bruto += parte;
    if (bruto.length > 100_000) throw new ErroHttp(413, 'Requisição grande demais');
  }
  try { return bruto ? JSON.parse(bruto) : {}; } catch { throw new ErroHttp(400, 'JSON inválido'); }
}

function responder(res, status, dados, extras = {}) {
  res.writeHead(status, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'application/json; charset=utf-8', ...extras });
  res.end(JSON.stringify(dados));
}

const ipDe = (req) => req.socket.remoteAddress;

// Período padrão: últimos 30 dias. Datas chegam como AAAA-MM-DD (horário de Brasília).
function periodo(q) {
  const paraUtc = (d, fimDoDia) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d ?? '')) return null;
    const base = new Date(`${d}T00:00:00-03:00`);
    if (fimDoDia) base.setUTCDate(base.getUTCDate() + 1);
    return base.toISOString();
  };
  const ate = paraUtc(q.get('ate'), true) ?? new Date().toISOString();
  const de = paraUtc(q.get('de'), false) ?? new Date(Date.parse(ate) - 30 * 86400_000).toISOString();
  return { de, ate };
}

function exigirGestor(u) {
  if (!auth.podeGerir(u)) throw new ErroHttp(403, 'Disponível só para coordenação');
}

function exigirAdmin(u) {
  if (u.perfil !== 'admin') throw new ErroHttp(403, 'Disponível só para administradores');
}

// ?departamento=id1,id2 (vários departamentos)
const listaDepartamentos = (q) => (q.get('departamento') ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const json = (v) => (v ? JSON.parse(v) : null);

function analiseParaTela(a, u) {
  if (!a) return null;
  // Técnico só vê avaliações já revisadas pela coordenação.
  if (u.perfil === 'tecnico' && !['aprovada', 'ajustada'].includes(a.status)) return null;
  return {
    ...a,
    motivos: json(a.motivos), criterios: json(a.criterios),
    pontos_melhoria: json(a.pontos_melhoria), evidencias: json(a.evidencias),
    revisor: a.revisado_por ? db.prepare('SELECT nome FROM usuarios WHERE id = ?').get(a.revisado_por)?.nome : null,
  };
}

function csv(linhas, colunas) {
  const esc = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return '﻿' + [colunas.map((c) => c[1]).join(';'), ...linhas.map((l) => colunas.map((c) => esc(l[c[0]])).join(';'))].join('\r\n');
}

// --- Rotas --------------------------------------------------------------------

const rotas = [];
const rota = (metodo, padrao, fn, publica = false) => rotas.push({ metodo, padrao: new RegExp(`^${padrao}$`), fn, publica });

rota('POST', '/api/entrar', async (req, res) => {
  const { email, senha } = await corpoJson(req);
  const r = auth.entrar(email ?? '', senha ?? '', ipDe(req));
  if (r.erro) {
    auditar(null, 'login_falhou', String(email ?? '').slice(0, 120), null, ipDe(req));
    return responder(res, 401, { erro: r.erro });
  }
  auditar(r.usuario.id, 'login', null, null, ipDe(req));
  responder(res, 200, { usuario: r.usuario }, {
    'Set-Cookie': `sessao=${r.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${config.sessaoHoras * 3600}`,
  });
}, true);

rota('POST', '/api/sair', async (req, res) => {
  auth.sair(cookie(req, 'sessao'));
  responder(res, 200, { ok: true }, { 'Set-Cookie': 'sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
});

rota('GET', '/api/eu', (req, res, { u }) => responder(res, 200, { usuario: u }));

rota('GET', '/api/status', (req, res, { u }) => {
  const ultima = db.prepare('SELECT * FROM execucoes_sync ORDER BY id DESC LIMIT 1').get() ?? null;
  responder(res, 200, {
    digisacConfigurado: digisacConfigurado(),
    iaHabilitada: config.ia.habilitada,
    modeloIa: config.ia.modelo,
    demonstracao: lerEstado('demonstracao') === 'sim',
    sincronizando: sincronizando(),
    ultimaSincronizacao: lerEstado('ultima_sincronizacao'),
    ultimaExecucao: ultima,
    intervaloMinutos: config.digisac.intervaloMinutos,
    retencaoDias: config.retencaoMensagensDias,
    // Contagem da equipe: só para a coordenação.
    pendentesRevisao: auth.podeGerir(u) ? db.prepare("SELECT COUNT(*) n FROM analises_ia WHERE status = 'pendente'").get().n : 0,
  });
});

rota('GET', '/api/filtros', (req, res, { u }) => {
  const escopo = auth.escopoTecnico(u);
  const tecnicos = db.prepare(`SELECT DISTINCT t.id, t.nome FROM tecnicos t JOIN chamados c ON c.tecnico_id = t.id
    ${escopo ? 'WHERE t.id = ?' : ''} ORDER BY t.nome`).all(...(escopo ? [escopo] : []));
  // A coordenação vê todos os departamentos do Digisac (os não monitorados podem ser ativados
  // pelo filtro); o técnico, só os monitorados.
  const departamentos = db.prepare(`SELECT id, nome, monitorado FROM departamentos WHERE id NOT LIKE 'demo-%'
    ${auth.podeGerir(u) ? '' : 'AND monitorado = 1'} ORDER BY monitorado DESC, nome`).all();
  responder(res, 200, { tecnicos, departamentos, motivos: MOTIVOS });
});

rota('GET', '/api/painel', (req, res, { u, q }) => {
  const f = { ...periodo(q), tecnico: q.get('tecnico') || null, departamento: listaDepartamentos(q) };
  // Dashboard geral: soma a voz (fila do Ponto na GoTo) ao chat, no mesmo período e técnico.
  const diaLocal = (iso) => new Date(Date.parse(iso) - 3 * 3600_000).toISOString().slice(0, 10);
  const escopo = auth.escopoTecnico(u);
  const vozResumo = voz({ de: diaLocal(f.de), ate: diaLocal(new Date(Date.parse(f.ate) - 1).toISOString()), tecnico: escopo ?? f.tecnico }).resumo;
  responder(res, 200, { ...painel(f, escopo), voz: vozResumo });
});

rota('GET', '/api/chamados', (req, res, { u, q }) => {
  const { de, ate } = periodo(q);
  const cond = ['d.monitorado = 1', 'c.iniciado_em >= ?', 'c.iniciado_em < ?'];
  const args = [de, ate];
  const escopo = auth.escopoTecnico(u) ?? (q.get('tecnico') || null);
  if (escopo) { cond.push('c.tecnico_id = ?'); args.push(escopo); }
  const deps = listaDepartamentos(q);
  if (deps.length) { cond.push(`c.departamento_id IN (${deps.map(() => '?').join(',')})`); args.push(...deps); }
  if (q.get('situacao') === 'abertos') cond.push('c.aberto = 1');
  if (q.get('situacao') === 'encerrados') cond.push('c.aberto = 0');
  const sentimento = q.get('sentimento');
  if (sentimento) {
    cond.push("a.status IN ('aprovada','ajustada') AND COALESCE(a.sentimento_revisado, a.sentimento) = ?");
    args.push(sentimento);
  }
  if (q.get('insatisfacao') === '1' && u.perfil !== 'tecnico') cond.push("a.insatisfacao = 1 AND a.status <> 'descartada'");
  const busca = (q.get('busca') ?? '').trim();
  if (busca) {
    cond.push(`(c.protocolo LIKE ? OR ct.nome LIKE ? OR ct.empresa LIKE ? OR c.assunto LIKE ?
      OR EXISTS (SELECT 1 FROM mensagens m WHERE m.chamado_id = c.id AND COALESCE(m.texto, '') || ' ' || COALESCE(m.transcricao, '') LIKE ?))`);
    const termo = `%${busca}%`;
    args.push(termo, termo, termo, termo, termo);
  }
  const pagina = Math.max(1, Number(q.get('pagina')) || 1);
  const where = cond.join(' AND ');
  const base = `FROM chamados c JOIN departamentos d ON d.id = c.departamento_id
    LEFT JOIN contatos ct ON ct.id = c.contato_id LEFT JOIN tecnicos t ON t.id = c.tecnico_id
    LEFT JOIN analises_ia a ON a.chamado_id = c.id WHERE ${where}`;
  const total = db.prepare(`SELECT COUNT(*) n ${base}`).get(...args).n;
  const itens = db.prepare(`SELECT c.id, c.protocolo, c.aberto, c.assunto, c.iniciado_em, c.encerrado_em,
      c.primeira_resposta_seg, c.duracao_seg, c.transferencias, ct.nome AS contato, ct.empresa, t.nome AS tecnico, d.nome AS departamento,
      CASE WHEN a.status IN ('aprovada','ajustada') OR ? THEN COALESCE(a.sentimento_revisado, a.sentimento) END AS sentimento,
      CASE WHEN a.status IN ('aprovada','ajustada') OR ? THEN a.status END AS status_ia,
      CASE WHEN ? THEN a.insatisfacao END AS insatisfacao
    ${base} ORDER BY c.iniciado_em DESC LIMIT 50 OFFSET ?`)
    .all(...[auth.podeGerir(u) ? 1 : 0, auth.podeGerir(u) ? 1 : 0, auth.podeGerir(u) ? 1 : 0], ...args, (pagina - 1) * 50);
  responder(res, 200, { total, pagina, porPagina: 50, itens });
});

rota('GET', '/api/chamados/([^/]+)', (req, res, { u, p, ip }) => {
  const c = db.prepare(`SELECT c.*, ct.nome AS contato, ct.numero, ct.empresa, t.nome AS tecnico, d.nome AS departamento
    FROM chamados c LEFT JOIN contatos ct ON ct.id = c.contato_id LEFT JOIN tecnicos t ON t.id = c.tecnico_id
    LEFT JOIN departamentos d ON d.id = c.departamento_id WHERE c.id = ?`).get(p[1]);
  if (!c) throw new ErroHttp(404, 'Chamado não encontrado');
  const escopo = auth.escopoTecnico(u);
  if (escopo && c.tecnico_id !== escopo) throw new ErroHttp(403, 'Este atendimento não é seu');
  auditar(u.id, 'ver_conversa', c.id, { protocolo: c.protocolo }, ip);
  const mensagens = db.prepare(`SELECT m.id, m.quando, m.autor, m.tipo, m.texto, m.transcricao, m.transcricao_erro, t.nome AS tecnico
    FROM mensagens m LEFT JOIN tecnicos t ON t.id = m.tecnico_id WHERE m.chamado_id = ? ORDER BY m.quando`).all(c.id);
  const analise = analiseParaTela(db.prepare('SELECT * FROM analises_ia WHERE chamado_id = ?').get(c.id), u);
  const erroIa = auth.podeGerir(u) ? db.prepare('SELECT * FROM erros_ia WHERE chamado_id = ?').get(c.id) ?? null : null;
  const avaliacoes = db.prepare('SELECT tipo, nota, comentario, respondido_em, origem, texto_ia FROM avaliacoes WHERE chamado_id = ? ORDER BY origem').all(c.id);
  delete c.bruto;
  responder(res, 200, { chamado: c, mensagens, analise, erroIa, avaliacoes, situacaoIa: situacaoIa(c.id) });
});

// Áudio, vídeo, imagem ou documento de uma mensagem, para tocar/mostrar na conversa. O arquivo
// continua no Digisac: o link assinado é buscado na hora (guardado 5 min) e o conteúdo passa
// por aqui sem ser gravado, com as mesmas permissões da conversa (técnico só vê as suas).
const TIPOS_COM_ARQUIVO = new Set(['ptt', 'audio', 'video', 'image', 'sticker', 'document']);
const linksDeArquivo = new Map();
// O WhatsApp manda voz como Ogg/Opus com tipo "audio/opus", que o navegador não toca; "audio/ogg" toca.
const TIPO_PARA_NAVEGADOR = { 'audio/opus': 'audio/ogg', 'audio/oga': 'audio/ogg' };

async function linkDoArquivo(mensagemId) {
  const guardado = linksDeArquivo.get(mensagemId);
  if (guardado && Date.now() - guardado.em < 5 * 60_000) return guardado.arquivo;
  const arquivo = await arquivoDaMensagem(mensagemId);
  if (arquivo?.url) linksDeArquivo.set(mensagemId, { arquivo, em: Date.now() });
  if (linksDeArquivo.size > 500) linksDeArquivo.delete(linksDeArquivo.keys().next().value);
  return arquivo;
}

rota('GET', '/api/mensagens/([^/]+)/midia', async (req, res, { u, p, ip }) => {
  const m = db.prepare(`SELECT m.id, m.tipo, c.id AS chamado_id, c.tecnico_id FROM mensagens m
    JOIN chamados c ON c.id = m.chamado_id WHERE m.id = ?`).get(p[1]);
  if (!m) throw new ErroHttp(404, 'Mensagem não encontrada');
  const escopo = auth.escopoTecnico(u);
  if (escopo && m.tecnico_id !== escopo) throw new ErroHttp(403, 'Este atendimento não é seu');
  if (!TIPOS_COM_ARQUIVO.has(m.tipo)) throw new ErroHttp(400, 'Esta mensagem não tem arquivo');
  if (!digisacConfigurado()) throw new ErroHttp(503, 'Digisac não configurado');
  const arquivo = await linkDoArquivo(m.id);
  if (!arquivo?.url) throw new ErroHttp(404, 'Arquivo não disponível no Digisac');
  const origem = await fetch(arquivo.url, { headers: req.headers.range ? { Range: req.headers.range } : {}, signal: AbortSignal.timeout(60_000) });
  if (!origem.ok) {
    linksDeArquivo.delete(m.id); // link expirado: o próximo pedido busca outro
    throw new ErroHttp(502, `O Digisac não entregou o arquivo (HTTP ${origem.status})`);
  }
  // O navegador pede o áudio em pedaços (Range); a auditoria registra só o primeiro pedido.
  if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) auditar(u.id, 'ver_midia', m.chamado_id, { mensagem: m.id, tipo: m.tipo }, ip);
  const tipo = arquivo.mimetype ?? origem.headers.get('content-type') ?? 'application/octet-stream';
  const nome = String(arquivo.name ?? arquivo.publicFilename ?? 'arquivo').replace(/[^\w.\- ]/g, '_');
  const cabecalhos = {
    ...CABECALHOS_SEGURANCA,
    'Content-Type': TIPO_PARA_NAVEGADOR[tipo] ?? tipo,
    'Cache-Control': 'private, max-age=300',
    'Content-Disposition': `${m.tipo === 'document' ? 'attachment' : 'inline'}; filename="${nome}"`,
    'Accept-Ranges': 'bytes',
  };
  for (const h of ['content-length', 'content-range']) if (origem.headers.get(h)) cabecalhos[h] = origem.headers.get(h);
  res.writeHead(origem.status, cabecalhos);
  Readable.fromWeb(origem.body).on('error', () => res.destroy()).pipe(res);
});

rota('POST', '/api/chamados/([^/]+)/analisar', async (req, res, { u, p, ip }) => {
  exigirGestor(u);
  if (!config.ia.habilitada) throw new ErroHttp(400, 'IA desabilitada no .env');
  const atual = db.prepare('SELECT status FROM analises_ia WHERE chamado_id = ?').get(p[1]);
  if (atual && atual.status !== 'pendente') throw new ErroHttp(409, 'Esta análise já foi revisada; reabra a revisão antes de reanalisar');
  if (!db.prepare('SELECT 1 FROM chamados WHERE id = ? AND aberto = 0').get(p[1])) throw new ErroHttp(404, 'Chamado não encontrado ou ainda aberto');
  // Num CPU a análise leva minutos: entra na frente da fila e a tela acompanha pelo GET do chamado.
  pedirAnalise(p[1]);
  auditar(u.id, 'analisar_ia', p[1], null, ip);
  responder(res, 202, { situacao: situacaoIa(p[1]) });
});

rota('GET', '/api/revisao', (req, res, { u, q }) => {
  exigirGestor(u);
  const status = ['pendente', 'aprovada', 'ajustada', 'descartada'].includes(q.get('status')) ? q.get('status') : 'pendente';
  const itens = db.prepare(`SELECT a.chamado_id, a.sentimento, a.insatisfacao, a.nota_qualidade, a.confianca, a.resumo, a.status,
      a.analisado_em, a.revisado_em, a.sentimento_revisado, a.nota_revisada, c.protocolo, c.iniciado_em, t.nome AS tecnico, ct.nome AS contato
    FROM analises_ia a JOIN chamados c ON c.id = a.chamado_id LEFT JOIN tecnicos t ON t.id = c.tecnico_id
    LEFT JOIN contatos ct ON ct.id = c.contato_id WHERE a.status = ?
    ORDER BY a.insatisfacao DESC, a.confianca ASC, a.analisado_em DESC LIMIT 200`).all(status);
  // Assertividade por modelo: quanto a coordenação aprovou sem mexer.
  const placar = db.prepare(`SELECT modelo, COUNT(*) AS revisadas,
      SUM(status = 'aprovada') AS aprovadas, SUM(status = 'ajustada') AS ajustadas, SUM(status = 'descartada') AS descartadas
    FROM analises_ia WHERE status <> 'pendente' GROUP BY modelo ORDER BY revisadas DESC`).all();
  responder(res, 200, { itens, placar });
});

rota('POST', '/api/analises/([^/]+)/revisar', async (req, res, { u, p, ip }) => {
  exigirGestor(u);
  const b = await corpoJson(req);
  const a = db.prepare('SELECT * FROM analises_ia WHERE chamado_id = ?').get(p[1]);
  if (!a) throw new ErroHttp(404, 'Análise não encontrada');
  const decisao = b.decisao;
  if (decisao === 'reabrir') {
    db.prepare(`UPDATE analises_ia SET status = 'pendente', revisado_por = NULL, revisado_em = NULL,
      sentimento_revisado = NULL, nota_revisada = NULL, observacao_revisao = NULL WHERE chamado_id = ?`).run(p[1]);
  } else {
    if (!['aprovada', 'ajustada', 'descartada'].includes(decisao)) throw new ErroHttp(400, 'Decisão inválida');
    let sentimento = null;
    let nota = null;
    if (decisao === 'ajustada') {
      if (b.sentimento && !['positivo', 'neutro', 'negativo'].includes(b.sentimento)) throw new ErroHttp(400, 'Sentimento inválido');
      sentimento = b.sentimento || null;
      nota = b.nota === '' || b.nota == null ? null : Number(b.nota);
      if (nota != null && !(nota >= 0 && nota <= 10)) throw new ErroHttp(400, 'A nota deve ficar entre 0 e 10');
      if (!String(b.observacao ?? '').trim()) throw new ErroHttp(400, 'Explique o ajuste na observação');
    }
    if (decisao === 'descartada' && !String(b.observacao ?? '').trim()) throw new ErroHttp(400, 'Explique por que a análise foi descartada');
    db.prepare(`UPDATE analises_ia SET status = ?, revisado_por = ?, revisado_em = ?, sentimento_revisado = ?, nota_revisada = ?,
      observacao_revisao = ? WHERE chamado_id = ?`)
      .run(decisao, u.id, agora(), sentimento, nota, String(b.observacao ?? '').trim() || null, p[1]);
  }
  auditar(u.id, `revisao_ia_${decisao}`, p[1], { antes: { status: a.status, sentimento: a.sentimento, nota: a.nota_qualidade }, depois: b }, ip);
  responder(res, 200, { ok: true });
});

// Aprovação em lote (seleção múltipla na tela de revisão). Só aprova: ajustar ou descartar exige
// justificativa individual. Cada análise ganha seu próprio registro na auditoria.
rota('POST', '/api/analises/aprovar-lote', async (req, res, { u, ip }) => {
  exigirGestor(u);
  const { ids } = await corpoJson(req);
  if (!Array.isArray(ids) || !ids.length) throw new ErroHttp(400, 'Selecione pelo menos uma análise');
  if (ids.length > 500) throw new ErroHttp(400, 'Selecione no máximo 500 análises por vez');
  const quando = agora();
  let aprovadas = 0;
  transacao(() => {
    for (const id of new Set(ids.map(String))) {
      const a = db.prepare("SELECT status, sentimento, nota_qualidade FROM analises_ia WHERE chamado_id = ? AND status = 'pendente'").get(id);
      if (!a) continue;
      db.prepare(`UPDATE analises_ia SET status = 'aprovada', revisado_por = ?, revisado_em = ?, sentimento_revisado = NULL,
        nota_revisada = NULL, observacao_revisao = NULL WHERE chamado_id = ?`).run(u.id, quando, id);
      auditar(u.id, 'revisao_ia_aprovada', id, { antes: { status: a.status, sentimento: a.sentimento, nota: a.nota_qualidade }, depois: { decisao: 'aprovada', lote: true } }, ip);
      aprovadas++;
    }
  });
  responder(res, 200, { aprovadas, ignoradas: ids.length - aprovadas });
});

rota('POST', '/api/sincronizar', async (req, res, { u, ip }) => {
  exigirGestor(u);
  if (!digisacConfigurado()) throw new ErroHttp(400, 'Digisac não configurado: preencha DIGISAC_URL e DIGISAC_TOKEN no .env');
  const b = await corpoJson(req);
  auditar(u.id, 'sincronizar', null, { completo: !!b.completo }, ip);
  sincronizar({ completo: !!b.completo }).catch((e) => console.error('Sincronização falhou:', e.message));
  responder(res, 202, { ok: true });
});

rota('GET', '/api/departamentos', async (req, res, { u, q }) => {
  exigirGestor(u);
  if (q.get('atualizar') === '1' && digisacConfigurado()) await atualizarCadastros();
  const itens = db.prepare(`SELECT d.id, d.nome, d.monitorado, (SELECT COUNT(*) FROM chamados c WHERE c.departamento_id = d.id) AS chamados
    FROM departamentos d WHERE d.id NOT LIKE 'demo-%' ORDER BY d.nome`).all();
  responder(res, 200, { itens, selecao: selecaoDeDepartamentos() });
});

rota('POST', '/api/departamentos', async (req, res, { u, ip }) => {
  exigirGestor(u);
  const { ids } = await corpoJson(req);
  if (!Array.isArray(ids) || !ids.length) throw new ErroHttp(400, 'Selecione pelo menos um departamento');
  const existentes = new Set(db.prepare('SELECT id FROM departamentos').all().map((d) => d.id));
  if (ids.some((id) => !existentes.has(id))) throw new ErroHttp(400, 'Departamento desconhecido; atualize a lista');
  const antes = selecaoDeDepartamentos();
  transacao(() => {
    gravarEstado('departamentos_monitorados', JSON.stringify(ids));
    db.prepare("UPDATE departamentos SET monitorado = 0 WHERE id NOT LIKE 'demo-%'").run();
    for (const id of ids) db.prepare('UPDATE departamentos SET monitorado = 1 WHERE id = ?').run(id);
    // Departamento novo na seleção precisa do histórico: a próxima sincronização refaz o período inicial.
    if (ids.some((id) => !antes.includes(id))) gravarEstado('chamados_desde', null);
  });
  auditar(u.id, 'departamentos_alterados', null, { antes, depois: ids }, ip);
  responder(res, 200, { ok: true });
});

rota('GET', '/api/execucoes', (req, res, { u }) => {
  exigirGestor(u);
  responder(res, 200, { itens: db.prepare('SELECT * FROM execucoes_sync ORDER BY id DESC LIMIT 30').all() });
});

rota('POST', '/api/conferir', async (req, res, { u, ip }) => {
  exigirGestor(u);
  const b = await corpoJson(req);
  const { de, ate } = periodo(new URLSearchParams({ de: b.de ?? '', ate: b.ate ?? '' }));
  const local = numerosParaConferencia(de, ate);
  let oficial = null;
  if (digisacConfigurado()) {
    // Um pedido por departamento monitorado + a soma das contagens (as médias do Digisac não somam).
    const deps = db.prepare('SELECT id, nome FROM departamentos WHERE monitorado = 1 ORDER BY nome').all();
    try {
      const porDep = {};
      const soma = { totalTicketsCount: 0, closedTicketsCount: 0, openedTicketsCount: 0 };
      for (const d of deps) {
        const r = await estatisticasGerais(de, ate, d.id);
        porDep[d.nome] = r;
        for (const k of Object.keys(soma)) soma[k] += Number(r[k]) || 0;
      }
      oficial = { 'Soma dos departamentos': soma, ...porDep };
    } catch (e) {
      oficial = { erro: e.message };
    }
  }
  db.prepare('INSERT INTO conferencias (quando, de, ate, local, digisac) VALUES (?, ?, ?, ?, ?)')
    .run(agora(), de, ate, JSON.stringify(local), oficial ? JSON.stringify(oficial) : null);
  auditar(u.id, 'conferir_indicadores', null, { de, ate }, ip);
  responder(res, 200, { de, ate, local, digisac: oficial });
});

rota('GET', '/api/exportar.csv', (req, res, { u, q, ip }) => {
  exigirGestor(u);
  const f = { ...periodo(q), tecnico: q.get('tecnico') || null, departamento: listaDepartamentos(q) };
  const { tecnicos } = painel(f, null);
  const linhas = tecnicos.map((t) => ({
    ...t,
    tme_min: t.primeira_resposta_media_seg == null ? null : (t.primeira_resposta_media_seg / 60).toFixed(1).replace('.', ','),
    tma_min: t.duracao_media_seg == null ? null : (t.duracao_media_seg / 60).toFixed(1).replace('.', ','),
    csat: t.csat_medio?.toFixed(2).replace('.', ','),
    qualidade: t.nota_qualidade_media?.toFixed(1).replace('.', ','),
    negativos: t.sentimento.negativo,
  }));
  auditar(u.id, 'exportar_csv', null, f, ip);
  res.writeHead(200, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tek-ponto-tecnicos.csv"' });
  res.end(csv(linhas, [
    ['nome', 'Técnico'], ['chamados', 'Chamados'], ['encerrados', 'Encerrados'], ['tme_min', 'TME 1ª resposta (min)'],
    ['tma_min', 'TMA (min)'], ['msgs_tecnico', 'Mensagens enviadas'], ['transferencias', 'Transferências'], ['csat', 'CSAT médio'],
    ['qualidade', 'Nota de qualidade (revisada)'], ['negativos', 'Sentimento negativo (revisado)'], ['analises_pendentes', 'Análises pendentes'],
  ]));
});

// Administração de usuários ---------------------------------------------------
rota('GET', '/api/usuarios', (req, res, { u }) => {
  exigirAdmin(u);
  const itens = db.prepare('SELECT * FROM usuarios ORDER BY nome').all().map(auth.publico);
  const tecnicos = db.prepare('SELECT id, nome FROM tecnicos ORDER BY nome').all();
  responder(res, 200, { itens, tecnicos });
});

rota('POST', '/api/usuarios', async (req, res, { u, ip }) => {
  exigirAdmin(u);
  const b = await corpoJson(req);
  if (!['admin', 'coordenador', 'tecnico'].includes(b.perfil)) throw new ErroHttp(400, 'Perfil inválido');
  if (!/^\S+@\S+\.\S+$/.test(b.email ?? '') || !String(b.nome ?? '').trim()) throw new ErroHttp(400, 'Informe nome e e-mail válidos');
  if (b.perfil === 'tecnico' && !b.tecnico_id) throw new ErroHttp(400, 'Vincule o técnico ao usuário do Digisac');
  if (b.id) {
    if (Number(b.id) === u.id && (b.perfil !== 'admin' || b.ativo === false)) throw new ErroHttp(400, 'Você não pode rebaixar ou desativar a si mesmo');
    db.prepare('UPDATE usuarios SET email = ?, nome = ?, perfil = ?, tecnico_id = ?, ativo = ? WHERE id = ?')
      .run(b.email.trim(), b.nome.trim(), b.perfil, b.tecnico_id || null, b.ativo === false ? 0 : 1, b.id);
    if (b.senha) {
      const erro = auth.validarSenha(b.senha);
      if (erro) throw new ErroHttp(400, erro);
      db.prepare('UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = ? WHERE id = ?').run(auth.gerarHash(b.senha), Number(b.id) === u.id ? 0 : 1, b.id);
      db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(b.id);
    }
    if (b.ativo === false) db.prepare('DELETE FROM sessoes WHERE usuario_id = ?').run(b.id);
    auditar(u.id, 'usuario_alterado', String(b.id), { email: b.email, perfil: b.perfil, ativo: b.ativo !== false, senha_trocada: !!b.senha }, ip);
  } else {
    const erro = auth.validarSenha(b.senha ?? '');
    if (erro) throw new ErroHttp(400, erro);
    try {
      const r = db.prepare('INSERT INTO usuarios (email, nome, perfil, tecnico_id, senha_hash, deve_trocar_senha) VALUES (?, ?, ?, ?, ?, 1)')
        .run(b.email.trim(), b.nome.trim(), b.perfil, b.tecnico_id || null, auth.gerarHash(b.senha));
      auditar(u.id, 'usuario_criado', String(r.lastInsertRowid), { email: b.email, perfil: b.perfil }, ip);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ErroHttp(409, 'Já existe usuário com este e-mail');
      throw e;
    }
  }
  responder(res, 200, { ok: true });
});

rota('POST', '/api/minha-senha', async (req, res, { u, ip }) => {
  const b = await corpoJson(req);
  const atual = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(u.id);
  if (!auth.conferirSenha(String(b.atual ?? ''), atual.senha_hash)) throw new ErroHttp(400, 'Senha atual incorreta');
  const erro = auth.validarSenha(b.nova ?? '');
  if (erro) throw new ErroHttp(400, erro);
  if (b.nova === b.atual) throw new ErroHttp(400, 'A nova senha deve ser diferente da atual');
  db.prepare('UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = 0 WHERE id = ?').run(auth.gerarHash(b.nova), u.id);
  auditar(u.id, u.deve_trocar_senha ? 'senha_provisoria_trocada' : 'senha_alterada', null, null, ip);
  responder(res, 200, { ok: true });
});

rota('GET', '/api/auditoria', (req, res, { u, q }) => {
  exigirAdmin(u);
  const itens = db.prepare(`SELECT a.*, u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id = a.usuario_id
    ${q.get('acao') ? 'WHERE a.acao = ?' : ''} ORDER BY a.id DESC LIMIT 300`).all(...(q.get('acao') ? [q.get('acao')] : []));
  responder(res, 200, { itens });
});

// --- Despacho -----------------------------------------------------------------

async function servirArquivo(res, caminho) {
  const alvo = path.normalize(path.join(PASTA_WEB, caminho === '/' ? 'index.html' : caminho));
  if (!alvo.startsWith(PASTA_WEB)) return responder(res, 404, { erro: 'Não encontrado' });
  try {
    const conteudo = await readFile(alvo);
    res.writeHead(200, { ...CABECALHOS_SEGURANCA, 'Content-Type': TIPOS[path.extname(alvo)] ?? 'application/octet-stream' });
    res.end(conteudo);
  } catch {
    responder(res, 404, { erro: 'Não encontrado' });
  }
}

registrarRotasGestao({ rota, responder, corpoJson, exigirGestor, ErroHttp, csv, CABECALHOS_SEGURANCA });

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (!url.pathname.startsWith('/api/')) return await servirArquivo(res, url.pathname);
    const r = rotas.find((x) => x.metodo === req.method && x.padrao.test(url.pathname));
    if (!r) throw new ErroHttp(404, 'Rota inexistente');
    const u = auth.usuarioDaSessao(cookie(req, 'sessao'));
    if (!r.publica && !u) throw new ErroHttp(401, 'Sessão expirada; entre novamente');
    // Senha provisória: só dá para ver quem sou, sair e trocar a senha até definir uma nova.
    if (u?.deve_trocar_senha && !['/api/eu', '/api/sair', '/api/minha-senha'].includes(url.pathname)) {
      throw new ErroHttp(403, 'Troque a senha provisória para continuar');
    }
    await r.fn(req, res, { u, q: url.searchParams, p: url.pathname.match(r.padrao), ip: ipDe(req) });
  } catch (e) {
    if (!(e instanceof ErroHttp)) console.error(e);
    if (!res.headersSent) responder(res, e.status ?? 500, { erro: e instanceof ErroHttp ? e.message : `Erro interno: ${e.message}` });
  }
});

export function iniciar() {
  const qtd = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
  servidor.listen(config.porta, config.host, () => {
    console.log(`Tek Ponto - Suporte Gestão em http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.porta}`);
    if (!qtd) console.log('Nenhum usuário cadastrado. Crie o primeiro com: npm run usuario -- --admin');
    if (!digisacConfigurado()) console.log('Digisac ainda não configurado (.env). Para testar a interface: npm run demo');
  });
  if (digisacConfigurado() && config.digisac.intervaloMinutos > 0) {
    const log = (m) => console.log(`[sync ${new Date().toLocaleTimeString('pt-BR')}] ${m}`);
    const ciclo = () => {
      // Base Bruno (GoTo): reimporta só quando chega um arquivo novo na pasta.
      try { importarSeMudou(log); } catch (e) { console.error('Importação da base GoTo falhou:', e.message); }
      return sincronizar({ log }).catch((e) => console.error('Sincronização falhou:', e.message));
    };
    setTimeout(ciclo, 5_000);
    setInterval(ciclo, config.digisac.intervaloMinutos * 60_000);
  }
  return servidor;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/server.mjs')) iniciar();
