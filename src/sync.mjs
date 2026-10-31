// Sincronização incremental Digisac -> banco local.
// Uso: node src/sync.mjs [--completo]
import { config, digisacConfigurado } from './config.mjs';
import { db, agora, lerEstado, gravarEstado, transacao } from './db.mjs';
import * as digisac from './digisac.mjs';
import { metricasDoChamado } from './indicadores.mjs';
import { analisarPendentes } from './ia.mjs';

const iaAutomatica = () => config.ia.habilitada && config.ia.analisarAutomaticamente;

let emAndamento = null;
export const sincronizando = () => Boolean(emAndamento);

// --- Normalização dos objetos do Digisac --------------------------------------

export function autorDaMensagem(m) {
  if (m.isComment || m.type === 'comment') return 'comentario';
  if (m.type === 'ticket' || m.origin === 'ticket' || m.type === 'reaction') return 'sistema';
  if (m.isFromBot) return 'bot';
  if (m.isFromMe) return m.userId ? 'tecnico' : 'bot';
  return 'cliente';
}

const ROTULO_MIDIA = { image: '[imagem]', audio: '[áudio]', ptt: '[áudio]', video: '[vídeo]', document: '[documento]', sticker: '[figurinha]', location: '[localização]', vcard: '[contato]' };

export function textoDaMensagem(m) {
  const texto = (m.text ?? '').trim();
  if (texto) return texto;
  return ROTULO_MIDIA[m.type] ?? (m.type ? `[${m.type}]` : '');
}

function nomeDoContato(c) {
  return c?.internalName || c?.alternativeName || c?.name || null;
}

// Departamentos escolhidos na tela (estado 'departamentos_monitorados') têm prioridade sobre o .env.
export function selecaoDeDepartamentos() {
  const salvo = lerEstado('departamentos_monitorados');
  return salvo ? JSON.parse(salvo) : config.digisac.departamentos;
}

function departamentoMonitorado(dep) {
  const filtro = selecaoDeDepartamentos().map((s) => String(s).toLowerCase());
  if (!filtro.length) return true;
  return filtro.includes(String(dep.id).toLowerCase()) || filtro.includes(String(dep.name ?? '').toLowerCase());
}

// --- Gravação -----------------------------------------------------------------

const sql = {
  tecnico: db.prepare(`INSERT INTO tecnicos (id, nome, email, ativo, bruto) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, email = excluded.email, ativo = excluded.ativo, bruto = excluded.bruto`),
  departamento: db.prepare(`INSERT INTO departamentos (id, nome, monitorado) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, monitorado = excluded.monitorado`),
  contato: db.prepare(`INSERT INTO contatos (id, nome, numero, empresa) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET nome = excluded.nome, numero = excluded.numero, empresa = excluded.empresa`),
  chamado: db.prepare(`INSERT INTO chamados (id, protocolo, aberto, contato_id, departamento_id, tecnico_id, assunto,
      iniciado_em, encerrado_em, atualizado_em, transferencias, bruto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET protocolo = excluded.protocolo, aberto = excluded.aberto, contato_id = excluded.contato_id,
      departamento_id = excluded.departamento_id, tecnico_id = excluded.tecnico_id, assunto = excluded.assunto,
      iniciado_em = excluded.iniciado_em, encerrado_em = excluded.encerrado_em, atualizado_em = excluded.atualizado_em,
      transferencias = excluded.transferencias, bruto = excluded.bruto`),
  mensagem: db.prepare(`INSERT INTO mensagens (id, chamado_id, quando, autor, tecnico_id, tipo, texto) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET texto = excluded.texto, autor = excluded.autor, tecnico_id = excluded.tecnico_id`),
  metricas: db.prepare(`UPDATE chamados SET primeira_resposta_seg = ?, duracao_seg = ?, msgs_cliente = ?, msgs_tecnico = ?,
      msgs_bot = ?, mensagens_sincronizadas_em = ? WHERE id = ?`),
  avaliacao: db.prepare(`INSERT INTO avaliacoes (id, chamado_id, tecnico_id, tipo, nota, comentario, respondido_em, bruto, origem, texto_ia)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET tipo = excluded.tipo, nota = excluded.nota, comentario = excluded.comentario,
      bruto = excluded.bruto, origem = excluded.origem, texto_ia = excluded.texto_ia`),
};

export function gravarChamado(t) {
  const contato = t.contact;
  if (contato) sql.contato.run(contato.id, nomeDoContato(contato), contato.data?.number ?? null, contato.person?.name ?? null);
  const assunto = (t.ticketTopics ?? []).map((x) => x.name).join(', ') || null;
  sql.chamado.run(
    t.id, t.protocol ?? null, t.isOpen ? 1 : 0, t.contactId ?? contato?.id ?? null, t.departmentId ?? null, t.userId ?? null,
    assunto, t.startedAt ?? t.createdAt ?? null, t.endedAt ?? null, t.updatedAt ?? null,
    (t.ticketTransfers ?? []).length, JSON.stringify(t),
  );
}

export function gravarMensagens(chamadoId, mensagens) {
  for (const m of mensagens) {
    if (m.visible === false) continue;
    sql.mensagem.run(m.id, chamadoId, m.timestamp ?? m.createdAt, autorDaMensagem(m), m.userId ?? null, m.type ?? null, textoDaMensagem(m));
  }
  recalcularMetricas(chamadoId);
}

export function recalcularMetricas(chamadoId) {
  const chamado = db.prepare('SELECT aberto, iniciado_em, encerrado_em FROM chamados WHERE id = ?').get(chamadoId);
  const msgs = db.prepare('SELECT autor, quando FROM mensagens WHERE chamado_id = ? ORDER BY quando').all(chamadoId);
  const m = metricasDoChamado(chamado, msgs);
  sql.metricas.run(m.primeira_resposta_seg, m.duracao_seg, m.msgs_cliente, m.msgs_tecnico, m.msgs_bot, agora(), chamadoId);
}

// /answers mistura respostas do cliente com notas que a IA do Digisac gera sozinha
// (aiGenerated: true). Nota inválida (-1, "no_human_context") vira nula.
export function gravarAvaliacao(a, tiposDePergunta = new Map()) {
  const valor = Number(String(a.text ?? a.value ?? '').trim());
  const tipo = tiposDePergunta.get(a.questionId) ?? a.question?.type ?? null;
  const maximo = tipo === 'nps' ? 10 : 5;
  const nota = Number.isFinite(valor) && valor >= 0 && valor <= maximo ? valor : null;
  sql.avaliacao.run(
    a.id, a.ticketId ?? null, a.userId ?? null, tipo, nota, a.reason ?? null, a.createdAt ?? null,
    JSON.stringify(a), a.aiGenerated ? 'ia_digisac' : 'cliente', a.aiText?.trim() || null,
  );
}

// LGPD: apaga o texto das conversas além do prazo de retenção (métricas ficam).
export function aplicarRetencao() {
  if (!config.retencaoMensagensDias) return 0;
  const limite = new Date(Date.now() - config.retencaoMensagensDias * 86400_000).toISOString();
  return Number(db.prepare('DELETE FROM mensagens WHERE quando < ?').run(limite).changes);
}

// --- Ciclo --------------------------------------------------------------------

export async function sincronizar({ completo = false, log = console.log } = {}) {
  if (emAndamento) return emAndamento;
  emAndamento = executar({ completo, log }).finally(() => { emAndamento = null; });
  // A IA roda na sua própria fila, sem segurar a sincronização (cada conversa leva minutos no CPU).
  emAndamento.then(() => {
    if (iaAutomatica()) analisarPendentes({ log }).catch((e) => log(`IA: ${e.message}`));
  }, () => {});
  return emAndamento;
}

// Só técnicos e departamentos (rápido); usado pela tela de seleção de departamentos.
export async function atualizarCadastros() {
  const usuarios = [];
  for await (const u of digisac.listarUsuarios()) usuarios.push(u);
  const departamentos = [];
  for await (const d of digisac.listarDepartamentos()) departamentos.push(d);
  transacao(() => {
    for (const u of usuarios) sql.tecnico.run(u.id, u.name ?? u.email ?? u.id, u.email ?? null, u.archivedAt || u.active === false ? 0 : 1, JSON.stringify({ ...u, data: undefined }));
    for (const d of departamentos) sql.departamento.run(d.id, d.name, departamentoMonitorado(d) ? 1 : 0);
  });
  return departamentos;
}

async function executar({ completo, log }) {
  if (!digisacConfigurado()) throw new Error('Digisac não configurado: preencha DIGISAC_URL e DIGISAC_TOKEN no arquivo .env');

  const execId = Number(db.prepare("INSERT INTO execucoes_sync (inicio, status) VALUES (?, 'executando')").run(agora()).lastInsertRowid);
  const totais = { chamados: 0, mensagens: 0, avaliacoes: 0, analises: 0 };
  try {
    log('Atualizando técnicos e departamentos...');
    const departamentos = await atualizarCadastros();
    const monitorados = new Set(db.prepare('SELECT id FROM departamentos WHERE monitorado = 1').all().map((d) => d.id));
    if (selecaoDeDepartamentos().length && !monitorados.size) {
      throw new Error(`Nenhum departamento do Digisac corresponde à seleção (${selecaoDeDepartamentos().join(', ')}). Disponíveis: ${departamentos.map((d) => d.name).join(', ')}`);
    }

    const inicial = new Date(Date.now() - config.digisac.diasIniciais * 86400_000).toISOString();
    const desde = completo ? inicial : lerEstado('chamados_desde', inicial);
    log(`Buscando chamados alterados desde ${desde}...`);
    let maisRecente = desde;
    const paraMensagens = [];
    for await (const t of digisac.listarChamados(desde)) {
      if (t.updatedAt > maisRecente) maisRecente = t.updatedAt;
      if (!monitorados.has(t.departmentId)) continue;
      gravarChamado(t);
      totais.chamados++;
      paraMensagens.push(t.id);
    }

    log(`Baixando mensagens de ${paraMensagens.length} chamado(s)...`);
    for (const id of paraMensagens) {
      const msgs = [];
      for await (const m of digisac.listarMensagens(id)) msgs.push(m);
      transacao(() => gravarMensagens(id, msgs));
      totais.mensagens += msgs.length;
    }
    gravarEstado('chamados_desde', maisRecente);

    log('Buscando avaliações de satisfação...');
    try {
      const desdeAval = completo ? inicial : lerEstado('avaliacoes_desde', inicial);
      let maisRecenteAval = desdeAval;
      const tipos = new Map();
      for await (const q of digisac.paginar('questions', {})) tipos.set(q.id, q.type);
      for await (const a of digisac.listarAvaliacoes(desdeAval)) {
        gravarAvaliacao(a, tipos);
        totais.avaliacoes++;
        if (a.createdAt > maisRecenteAval) maisRecenteAval = a.createdAt;
      }
      gravarEstado('avaliacoes_desde', maisRecenteAval);
    } catch (e) {
      // Contas sem o módulo de avaliações respondem erro aqui; o resto segue.
      log(`Avaliações não sincronizadas: ${e.message}`);
    }

    const apagadas = aplicarRetencao();
    if (apagadas) log(`Retenção LGPD: ${apagadas} mensagem(ns) antigas removidas.`);

    gravarEstado('ultima_sincronizacao', agora());
    db.prepare(`UPDATE execucoes_sync SET fim = ?, status = 'ok', chamados = ?, mensagens = ?, avaliacoes = ?, analises = ? WHERE id = ?`)
      .run(agora(), totais.chamados, totais.mensagens, totais.avaliacoes, totais.analises, execId);
    log(`Concluído: ${totais.chamados} chamados, ${totais.mensagens} mensagens, ${totais.avaliacoes} avaliações, ${totais.analises} análises.`);
    return totais;
  } catch (e) {
    db.prepare(`UPDATE execucoes_sync SET fim = ?, status = 'erro', erro = ?, chamados = ?, mensagens = ? WHERE id = ?`)
      .run(agora(), e.message, totais.chamados, totais.mensagens, execId);
    throw e;
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/sync.mjs')) {
  sincronizar({ completo: process.argv.includes('--completo') })
    // Pela linha de comando (agendador) espera a fila da IA terminar antes de sair.
    .then(() => (iaAutomatica() ? analisarPendentes() : 0))
    .then(() => process.exit(0))
    .catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
