// Rotas da gestão da equipe: dashboards (técnicos, individual, gestão), GoTo/Voz, análise de
// chamadas, cadastro de técnicos, disponibilidade, calendário, escalas, metas e feriados.
// Escrita só pela coordenação, sempre auditada. O técnico vê o próprio dashboard e, no
// calendário, só as próprias ausências (atestado é dado de saúde: LGPD).
import { db, auditar, transacao } from './db.mjs';
import * as auth from './auth.mjs';
import * as g from './gestao.mjs';
import { importarBase, infoBase } from './base-goto.mjs';
import { painel } from './indicadores.mjs';

const DIA = /^\d{4}-\d{2}-\d{2}$/;
const HORA = /^\d{2}:\d{2}$/;
const TIPOS_FERIADO = ['nacional', 'estadual', 'municipal', 'facultativo', 'empresa'];
// Funções do cadastro (as mesmas da Base Bruno).
const FUNCOES = ['Técnico', 'Apoio', 'Apoio Gestão'];
export const FUNCOES_FORA_DO_RANKING = ['Apoio'];

export function registrarRotasGestao({ rota, responder, corpoJson, exigirGestor, ErroHttp, csv, CABECALHOS_SEGURANCA }) {
  const falha = (msg) => { throw new ErroHttp(400, msg); };
  const dia = (v, nome) => (DIA.test(v ?? '') ? v : falha(`${nome}: use uma data válida`));
  const hora = (v, nome) => (v == null || v === '' ? null : HORA.test(v) ? v : falha(`${nome}: use HH:MM`));
  const numero = (v, nome, { min = 0, max = Infinity, vazio = null } = {}) => {
    if (v === '' || v == null) return vazio;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n >= min && n <= max ? n : falha(`${nome}: valor inválido`);
  };
  // Período em dias locais; padrão: mês corrente.
  const periodo = (q) => {
    const hoje = g.hojeLocal();
    const de = DIA.test(q.get('de') ?? '') ? q.get('de') : `${hoje.slice(0, 7)}-01`;
    const ate = DIA.test(q.get('ate') ?? '') ? q.get('ate') : hoje;
    if (de > ate) falha('A data inicial deve ser antes da final');
    if (g.dias(de, ate).length > 400) falha('Escolha um período de até 400 dias');
    return { de, ate };
  };
  const tecnicoExiste = (id) => db.prepare('SELECT id, nome, jornada_min FROM tecnicos WHERE id = ?').get(id) ?? falha('Técnico não encontrado');
  // Técnico só enxerga os próprios números.
  const tecnicoPermitido = (u, id) => {
    const escopo = auth.escopoTecnico(u);
    if (escopo && id !== escopo) throw new ErroHttp(403, 'Você só pode ver o seu próprio dashboard');
    return escopo ?? id;
  };

  // --- Dashboards -------------------------------------------------------------

  rota('GET', '/api/dashboard/tecnicos', (req, res, { u, q }) => {
    exigirGestor(u);
    const p = periodo(q);
    const gr = g.grade(p.de, p.ate);
    const vozPorTecnico = new Map(g.voz(p).porAgente.filter((a) => a.id).map((a) => [a.id, a]));
    const tecnicos = gr.map((x) => {
      const r = g.resumir(x);
      return { ...r, voz: vozPorTecnico.get(r.id) ?? null };
    });
    responder(res, 200, { periodo: p, tecnicos });
  });

  rota('GET', '/api/dashboard/individual', (req, res, { u, q }) => {
    const id = tecnicoPermitido(u, q.get('tecnico') || null);
    const p = periodo(q);
    const equipe = auth.podeGerir(u) ? g.equipe({ incluirInativos: true }).map((t) => ({ id: t.id, nome: t.nome })) : [];
    if (!id) return responder(res, 200, { periodo: p, equipe, tecnico: null });
    const t = db.prepare(`SELECT id, nome, email, matricula, data_admissao, funcao, jornada_min, meta_padrao, goto_agente, situacao, na_equipe
      FROM tecnicos WHERE id = ?`).get(id);
    if (!t) throw new ErroHttp(404, 'Técnico não encontrado');
    const [linha] = g.grade(p.de, p.ate, [t]);
    responder(res, 200, {
      periodo: p, equipe, tecnico: t, resumo: g.resumir(linha), dias: linha.dias,
      voz: g.voz({ ...p, tecnico: id }), pausas: g.pausasDoTecnico(id, p.de, p.ate),
      posicoes: FUNCOES_FORA_DO_RANKING.includes(t.funcao) ? null : posicoesNoRanking(rankings(p), id),
    });
  });

  rota('GET', '/api/dashboard/gestao', (req, res, { u, q }) => {
    exigirGestor(u);
    const p = periodo(q);
    const ia = db.prepare(`SELECT SUM(status = 'pendente') AS pendentes, SUM(insatisfacao = 1 AND status != 'descartada') AS insatisfacao
      FROM analises_ia a JOIN chamados c ON c.id = a.chamado_id WHERE date(c.encerrado_em, '-3 hours') BETWEEN ? AND ?`).get(p.de, p.ate);
    responder(res, 200, { periodo: p, ...g.painelGestao(p.de, p.ate), voz: g.voz(p).resumo, ia, rankings: rankings(p), foraDoRanking: FUNCOES_FORA_DO_RANKING });
  });

  // --- Rankings (Digisac e ligações) -----------------------------------------
  // Digisac: chamados abertos no período (mesma regra do Dashboard Geral) com 1ª resposta,
  // duração, CSAT dos clientes e qualidade revisada. Ligações: fila do Ponto na GoTo.
  // A ordem de cada critério é decidida na tela; aqui vai a lista completa.
  const rankings = (p) => {
    const naEquipe = new Set(g.equipe({ incluirInativos: true }).map((t) => t.id));
    // Função Apoio não entra no ranking (continua nos totais e nos demais dashboards).
    const apoio = new Set(db.prepare('SELECT id FROM tecnicos WHERE funcao IN (' + FUNCOES_FORA_DO_RANKING.map(() => '?').join(',') + ')').all(...FUNCOES_FORA_DO_RANKING).map((t) => t.id));
    const f = { de: new Date(`${p.de}T00:00:00-03:00`).toISOString(), ate: new Date(Date.parse(`${p.ate}T00:00:00-03:00`) + 86400_000).toISOString(), tecnico: null, departamento: [] };
    const digisac = painel(f, null).tecnicos.filter((t) => t.id && !apoio.has(t.id) && (!naEquipe.size || naEquipe.has(t.id))).map((t) => ({
      id: t.id, nome: t.nome, chamados: t.chamados, encerrados: t.encerrados,
      primeira_resposta_seg: t.primeira_resposta_media_seg, duracao_seg: t.duracao_media_seg,
      csat: t.csat_medio, csat_respostas: t.csat_respostas, qualidade: t.nota_qualidade_media, revisadas: t.analises_revisadas,
    }));
    const ligacoes = g.voz(p).porAgente.filter((a) => !apoio.has(a.id)).map((a) => ({
      id: a.id, nome: a.nome, ligacoes: a.ligacoes, conversa_seg: a.conversa_total_seg, tma_seg: a.tma_medio_seg,
      espera_seg: a.espera_media_seg, pausas_seg: a.pausas_seg, pausas_qtd: a.pausas_qtd,
    }));
    return { digisac, ligacoes };
  };

  // Posição de um técnico em cada métrica ranqueada (mesmas regras da tela Rankings em
  // web/gestao.js: sentido de cada critério e CSAT só com 3+ respostas). Devolve só a posição,
  // o valor dele e a média da equipe, sem os números individuais dos colegas.
  const CRITERIOS_RANKING = {
    digisac: [['chamados', true], ['encerrados', true], ['primeira_resposta_seg', false], ['duracao_seg', false], ['csat', true, (x) => x.csat_respostas >= 3], ['qualidade', true]],
    ligacoes: [['ligacoes', true], ['conversa_seg', true], ['tma_seg', false], ['espera_seg', false], ['pausas_seg', false]],
  };
  const posicoesNoRanking = (rk, tecnicoId) => Object.fromEntries(Object.entries(CRITERIOS_RANKING).map(([tipo, criterios]) => [tipo, criterios.map(([chave, maior, valido]) => {
    const ok = (x) => x[chave] != null && (!valido || valido(x));
    const lista = rk[tipo].filter(ok).sort((a, b) => (maior ? b[chave] - a[chave] : a[chave] - b[chave]));
    const eu = rk[tipo].find((x) => x.id === tecnicoId) ?? null;
    const indice = lista.findIndex((x) => x.id === tecnicoId);
    return {
      chave, maior, valor: eu?.[chave] ?? null, extra: eu ? { csat_respostas: eu.csat_respostas, revisadas: eu.revisadas, pausas_qtd: eu.pausas_qtd } : null,
      posicao: indice >= 0 ? indice + 1 : null, total: lista.length,
      media: lista.length ? lista.reduce((s, x) => s + x[chave], 0) / lista.length : null,
      motivo: indice >= 0 ? null : !eu ? 'sem atendimentos no período' : chave === 'csat' && eu.csat != null ? 'menos de 3 respostas de clientes' : 'sem dados no período',
    };
  })]));

  rota('GET', '/api/rankings', (req, res, { u, q }) => {
    exigirGestor(u);
    const p = periodo(q);
    responder(res, 200, { periodo: p, ...rankings(p) });
  });

  // --- GoTo / Voz -------------------------------------------------------------

  rota('GET', '/api/voz', (req, res, { u, q }) => {
    exigirGestor(u);
    const p = periodo(q);
    responder(res, 200, { periodo: p, ...g.voz({ ...p, tecnico: q.get('tecnico') || null }), base: infoBase(), tecnicos: g.equipe({ incluirInativos: true }).map((t) => ({ id: t.id, nome: t.nome })) });
  });

  const filtrosChamadas = (q) => ({
    esperaMin: numero(q.get('espera_min'), 'Espera mínima') ?? 0,
    duracaoMin: (numero(q.get('duracao_min'), 'Duração mínima') ?? 0) * 60,
    ordem: q.get('ordem') || 'recentes',
  });

  rota('GET', '/api/voz/chamadas', (req, res, { u, q }) => {
    exigirGestor(u);
    const p = periodo(q);
    const pagina = Math.max(1, Number(q.get('pagina')) || 1);
    responder(res, 200, { periodo: p, ...g.chamadasDeVoz({ ...p, tecnico: q.get('tecnico') || null }, { ...filtrosChamadas(q), pagina }) });
  });

  rota('GET', '/api/voz/chamadas.csv', (req, res, { u, q, ip }) => {
    exigirGestor(u);
    const p = periodo(q);
    const r = g.chamadasDeVoz({ ...p, tecnico: q.get('tecnico') || null }, { ...filtrosChamadas(q), porPagina: 100_000 });
    auditar(u.id, 'exportar_ligacoes', null, { ...p, total: r.total }, ip);
    const min = (s) => (s == null ? null : (s / 60).toFixed(2).replace('.', ','));
    res.writeHead(200, { ...CABECALHOS_SEGURANCA, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="tek-ponto-ligacoes.csv"' });
    res.end(csv(r.itens.map((l) => ({ ...l, hora_ini: new Date(l.inicio).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' }), espera: l.espera_seg, conversa: min(l.conversa_seg), pos: min(l.pos_seg), total: min(l.total_seg) })), [
      ['dia', 'Dia'], ['hora_ini', 'Hora'], ['tecnico', 'Técnico'], ['espera', 'Espera na fila (s)'], ['conversa', 'Conversa (min)'], ['pos', 'Pós-atendimento (min)'], ['total', 'TMA (min)'],
    ]));
  });

  rota('POST', '/api/voz/importar', (req, res, { u, ip }) => {
    exigirGestor(u);
    const info = importarBase({ log: () => {} });
    auditar(u.id, 'importar_base_goto', null, info, ip);
    responder(res, 200, info);
  });

  // --- Cadastro de técnicos ---------------------------------------------------

  rota('GET', '/api/equipe', (req, res, { u }) => {
    exigirGestor(u);
    const hoje = g.hojeLocal();
    const tecnicos = db.prepare(`SELECT t.id, t.nome, t.email, t.ativo, t.na_equipe, t.matricula, t.data_admissao, t.funcao, t.jornada_min, t.meta_padrao,
        t.goto_agente, t.situacao,
        (SELECT e.nome FROM tecnico_escalas te JOIN escalas e ON e.id = te.escala_id WHERE te.tecnico_id = t.id AND te.desde <= ? AND (te.ate IS NULL OR te.ate >= ?) ORDER BY te.desde DESC LIMIT 1) AS escala,
        (SELECT m.meta FROM metas_periodo m WHERE m.tecnico_id = t.id AND m.desde <= ? ORDER BY m.desde DESC LIMIT 1) AS meta_vigente,
        (SELECT COUNT(*) FROM chamados c WHERE c.tecnico_id = t.id) AS chamados
      FROM tecnicos t ORDER BY t.na_equipe DESC, t.nome`).all(hoje, hoje, hoje);
    const agentes = db.prepare('SELECT agente, COUNT(*) AS ligacoes FROM ligacoes GROUP BY agente ORDER BY agente').all();
    responder(res, 200, { tecnicos, agentes, funcoes: FUNCOES, jornadaPadraoMin: g.JORNADA_PADRAO_MIN });
  });

  rota('POST', '/api/equipe/([^/]+)', async (req, res, { u, p, ip }) => {
    exigirGestor(u);
    const antes = db.prepare('SELECT * FROM tecnicos WHERE id = ?').get(p[1]) ?? falha('Técnico não encontrado');
    const b = await corpoJson(req);
    const goto = String(b.goto_agente ?? '').trim() || null;
    if (goto && db.prepare('SELECT 1 FROM tecnicos WHERE goto_agente = ? AND id != ?').get(goto, p[1])) falha('Este atendente da GoTo já está ligado a outro técnico');
    const jornada = b.jornada ? String(b.jornada) : null;
    if (jornada && !HORA.test(jornada)) falha('Jornada: use HH:MM (ex.: 07:12)');
    const novo = {
      na_equipe: b.na_equipe ? 1 : 0,
      matricula: String(b.matricula ?? '').trim() || null,
      data_admissao: b.data_admissao ? dia(b.data_admissao, 'Admissão') : null,
      funcao: !b.funcao ? null : FUNCOES.includes(b.funcao) ? b.funcao : falha('Função inválida'),
      jornada_min: jornada ? Number(jornada.slice(0, 2)) * 60 + Number(jornada.slice(3)) : null,
      meta_padrao: numero(b.meta_padrao, 'Meta padrão', { max: 1000 }),
      goto_agente: goto,
      situacao: b.situacao === 'Inativo' ? 'Inativo' : 'Ativo',
    };
    db.prepare(`UPDATE tecnicos SET na_equipe = ?, matricula = ?, data_admissao = ?, funcao = ?, jornada_min = ?, meta_padrao = ?,
      goto_agente = ?, situacao = ? WHERE id = ?`).run(...Object.values(novo), p[1]);
    auditar(u.id, 'tecnico_cadastro', p[1], { antes: Object.fromEntries(Object.keys(novo).map((k) => [k, antes[k]])), depois: novo }, ip);
    responder(res, 200, { ok: true });
  });

  // --- Disponibilidade --------------------------------------------------------

  rota('GET', '/api/disponibilidade', (req, res, { u, q }) => {
    exigirGestor(u);
    const mes = /^\d{4}-\d{2}$/.test(q.get('mes') ?? '') ? q.get('mes') : g.hojeLocal().slice(0, 7);
    const de = `${mes}-01`;
    const ate = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 0)).toISOString().slice(0, 10);
    const gr = g.grade(de, ate);
    responder(res, 200, {
      mes, status: Object.keys(g.STATUS_DISPONIBILIDADE), parciais: [...g.STATUS_PARCIAIS],
      tecnicos: gr.map((x) => ({ ...g.resumir(x), dias: x.dias.map((d) => ({ dia: d.dia, util: d.util, motivo: d.motivo, feriado: d.feriado?.descricao ?? null, status: d.status, fracao: d.fracao, meta: d.meta, registro: d.registro, realizado: d.realizado })) })),
    });
  });

  // Lança um status para um técnico em um dia ou intervalo (só dias úteis do intervalo).
  rota('POST', '/api/disponibilidade', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const t = tecnicoExiste(b.tecnico_id);
    const de = dia(b.de, 'Data inicial');
    const ate = b.ate ? dia(b.ate, 'Data final') : de;
    if (ate < de) falha('A data final deve ser igual ou depois da inicial');
    if (g.dias(de, ate).length > 120) falha('Lance no máximo 120 dias por vez');
    const inicio = hora(b.hora_inicio_ausencia, 'Início da ausência');
    const fim = hora(b.hora_fim_ausencia, 'Fim da ausência');
    if ((inicio && !fim) || (!inicio && fim)) falha('Informe início e fim da ausência');
    let fracao;
    try { fracao = g.fracaoDoStatus(b.status, inicio, fim, t.jornada_min); } catch (e) { falha(e.message); }
    const metaDia = numero(b.meta_do_dia, 'Meta do dia', { max: 1000 });
    const observacao = String(b.observacao ?? '').trim().slice(0, 300) || null;
    const feriados = g.feriadosEntre(de, ate);
    const alvo = g.dias(de, ate).filter((d) => de === ate || g.tipoDoDia(d, feriados).util);
    transacao(() => {
      for (const d of alvo) {
        db.prepare(`INSERT INTO disponibilidade (tecnico_id, dia, status, fracao, hora_inicio_ausencia, hora_fim_ausencia, meta_do_dia, observacao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tecnico_id, dia) DO UPDATE SET status = excluded.status, fracao = excluded.fracao,
          hora_inicio_ausencia = excluded.hora_inicio_ausencia, hora_fim_ausencia = excluded.hora_fim_ausencia, meta_do_dia = excluded.meta_do_dia,
          observacao = excluded.observacao`).run(t.id, d, b.status, fracao, inicio, fim, metaDia, observacao);
      }
    });
    auditar(u.id, 'disponibilidade_lancada', t.id, { de, ate, dias: alvo.length, status: b.status, fracao }, ip);
    responder(res, 200, { dias: alvo.length, fracao });
  });

  rota('POST', '/api/disponibilidade/remover', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const t = tecnicoExiste(b.tecnico_id);
    const de = dia(b.de, 'Data inicial');
    const ate = b.ate ? dia(b.ate, 'Data final') : de;
    const n = Number(db.prepare('DELETE FROM disponibilidade WHERE tecnico_id = ? AND dia BETWEEN ? AND ?').run(t.id, de, ate).changes);
    auditar(u.id, 'disponibilidade_removida', t.id, { de, ate, dias: n }, ip);
    responder(res, 200, { dias: n });
  });

  // --- Calendário -------------------------------------------------------------

  rota('GET', '/api/calendario', (req, res, { u, q }) => {
    const mes = /^\d{4}-\d{2}$/.test(q.get('mes') ?? '') ? q.get('mes') : g.hojeLocal().slice(0, 7);
    const de = `${mes}-01`;
    const ate = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 0)).toISOString().slice(0, 10);
    const escopo = auth.escopoTecnico(u);
    const gestor = auth.podeGerir(u);
    const tecnicos = g.equipe().filter((t) => !escopo || t.id === escopo);
    const gr = g.grade(de, ate, tecnicos);
    const feriados = g.feriadosEntre(de, ate);
    const diasMes = g.dias(de, ate).map((d) => {
      const tipo = g.tipoDoDia(d, feriados);
      const ausentes = gr.map((x) => ({ x, d: x.dias.find((y) => y.dia === d) })).filter(({ d: y }) => y.util && y.status !== 'Presente')
        .map(({ x, d: y }) => ({ tecnico: x.tecnico.nome, status: y.status, fracao: y.fracao, observacao: gestor ? y.registro?.observacao ?? null : null }));
      const trocas = gr.filter((x) => x.dias.find((y) => y.dia === d)?.escala?.desde === d).map((x) => ({ tecnico: x.tecnico.nome, escala: x.dias.find((y) => y.dia === d).escala.nome }));
      const disponiveis = gr.reduce((s, x) => s + (x.dias.find((y) => y.dia === d)?.fracao ?? 0), 0);
      return { dia: d, util: tipo.util, motivo: tipo.motivo, feriado: (tipo.feriado ?? feriados.get(d)) ?? null, ausentes, trocas, disponiveis: Number(disponiveis.toFixed(2)), equipe: tecnicos.length };
    });
    responder(res, 200, { mes, dias: diasMes });
  });

  // --- Escalas ----------------------------------------------------------------

  rota('GET', '/api/escalas', (req, res, { u }) => {
    exigirGestor(u);
    const escalas = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM tecnico_escalas te WHERE te.escala_id = e.id AND te.ate IS NULL) AS tecnicos FROM escalas e ORDER BY e.hora_inicio, e.nome`).all();
    const atribuicoes = db.prepare(`SELECT te.id, te.tecnico_id, t.nome AS tecnico, te.escala_id, e.nome AS escala, e.hora_inicio, e.hora_fim, te.desde, te.ate, te.motivo
      FROM tecnico_escalas te JOIN tecnicos t ON t.id = te.tecnico_id JOIN escalas e ON e.id = te.escala_id ORDER BY t.nome, te.desde DESC`).all();
    responder(res, 200, { escalas, atribuicoes, equipe: g.equipe().map((t) => ({ id: t.id, nome: t.nome })) });
  });

  rota('POST', '/api/escalas', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const nome = String(b.nome ?? '').trim() || falha('Dê um nome à escala');
    const inicio = hora(b.hora_inicio, 'Início') ?? falha('Informe o início');
    const fim = hora(b.hora_fim, 'Fim') ?? falha('Informe o fim');
    if (fim <= inicio) falha('O fim deve ser depois do início');
    const ativo = b.ativo === false || b.ativo === '0' ? 0 : 1;
    try {
      if (b.id) db.prepare('UPDATE escalas SET nome = ?, hora_inicio = ?, hora_fim = ?, ativo = ? WHERE id = ?').run(nome, inicio, fim, ativo, Number(b.id));
      else db.prepare('INSERT INTO escalas (nome, hora_inicio, hora_fim, ativo) VALUES (?, ?, ?, ?)').run(nome, inicio, fim, ativo);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) falha('Já existe uma escala com esse nome');
      throw e;
    }
    auditar(u.id, b.id ? 'escala_editada' : 'escala_criada', b.id ? String(b.id) : null, { nome, inicio, fim, ativo }, ip);
    responder(res, 200, { ok: true });
  });

  // Atribui uma escala a partir de uma data; a anterior em aberto termina na véspera.
  rota('POST', '/api/escalas/atribuir', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const t = tecnicoExiste(b.tecnico_id);
    const escala = db.prepare('SELECT id, nome FROM escalas WHERE id = ? AND ativo = 1').get(Number(b.escala_id)) ?? falha('Escolha uma escala ativa');
    const desde = dia(b.desde, 'A partir de');
    const vespera = new Date(Date.parse(`${desde}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10);
    transacao(() => {
      db.prepare('UPDATE tecnico_escalas SET ate = ? WHERE tecnico_id = ? AND desde < ? AND (ate IS NULL OR ate >= ?)').run(vespera, t.id, desde, desde);
      db.prepare(`INSERT INTO tecnico_escalas (tecnico_id, escala_id, desde, motivo) VALUES (?, ?, ?, ?)
        ON CONFLICT(tecnico_id, desde) DO UPDATE SET escala_id = excluded.escala_id, motivo = excluded.motivo, ate = NULL`)
        .run(t.id, escala.id, desde, String(b.motivo ?? '').trim().slice(0, 200) || null);
    });
    auditar(u.id, 'escala_atribuida', t.id, { escala: escala.nome, desde }, ip);
    responder(res, 200, { ok: true });
  });

  rota('POST', '/api/escalas/atribuicoes/(\\d+)/remover', (req, res, { u, p, ip }) => {
    exigirGestor(u);
    const a = db.prepare('SELECT * FROM tecnico_escalas WHERE id = ?').get(Number(p[1])) ?? falha('Atribuição não encontrada');
    db.prepare('DELETE FROM tecnico_escalas WHERE id = ?').run(a.id);
    auditar(u.id, 'escala_atribuicao_removida', a.tecnico_id, a, ip);
    responder(res, 200, { ok: true });
  });

  // --- Metas por período ------------------------------------------------------

  rota('GET', '/api/metas', (req, res, { u }) => {
    exigirGestor(u);
    const hoje = g.hojeLocal();
    const equipe = g.equipe().map((t) => ({
      id: t.id, nome: t.nome, meta_padrao: t.meta_padrao,
      vigente: db.prepare('SELECT meta, desde FROM metas_periodo WHERE tecnico_id = ? AND desde <= ? ORDER BY desde DESC LIMIT 1').get(t.id, hoje) ?? null,
      proxima: db.prepare('SELECT meta, desde FROM metas_periodo WHERE tecnico_id = ? AND desde > ? ORDER BY desde LIMIT 1').get(t.id, hoje) ?? null,
    }));
    const historico = db.prepare(`SELECT m.id, m.tecnico_id, t.nome AS tecnico, m.desde, m.meta, m.observacao FROM metas_periodo m
      JOIN tecnicos t ON t.id = m.tecnico_id ORDER BY m.desde DESC, t.nome`).all();
    responder(res, 200, { equipe, historico });
  });

  // tecnico_id = "equipe" aplica a mesma meta a todos os técnicos ativos da equipe.
  rota('POST', '/api/metas', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const desde = dia(b.desde, 'A partir de');
    const meta = numero(b.meta, 'Meta diária', { max: 1000 }) ?? falha('Informe a meta diária');
    const observacao = String(b.observacao ?? '').trim().slice(0, 200) || null;
    const alvos = b.tecnico_id === 'equipe' ? g.equipe().map((t) => t.id) : [tecnicoExiste(b.tecnico_id).id];
    if (!alvos.length) falha('Nenhum técnico na equipe; marque-os em Técnicos');
    transacao(() => {
      for (const id of alvos) {
        db.prepare(`INSERT INTO metas_periodo (tecnico_id, desde, meta, observacao) VALUES (?, ?, ?, ?)
          ON CONFLICT(tecnico_id, desde) DO UPDATE SET meta = excluded.meta, observacao = excluded.observacao`).run(id, desde, meta, observacao);
      }
    });
    auditar(u.id, 'meta_definida', b.tecnico_id === 'equipe' ? null : alvos[0], { desde, meta, tecnicos: alvos.length }, ip);
    responder(res, 200, { tecnicos: alvos.length });
  });

  rota('POST', '/api/metas/(\\d+)/remover', (req, res, { u, p, ip }) => {
    exigirGestor(u);
    const m = db.prepare('SELECT * FROM metas_periodo WHERE id = ?').get(Number(p[1])) ?? falha('Meta não encontrada');
    db.prepare('DELETE FROM metas_periodo WHERE id = ?').run(m.id);
    auditar(u.id, 'meta_removida', m.tecnico_id, m, ip);
    responder(res, 200, { ok: true });
  });

  // --- Feriados ---------------------------------------------------------------

  rota('GET', '/api/feriados', (req, res, { u, q }) => {
    exigirGestor(u);
    const ano = /^\d{4}$/.test(q.get('ano') ?? '') ? q.get('ano') : g.hojeLocal().slice(0, 4);
    const itens = db.prepare("SELECT * FROM feriados WHERE dia LIKE ? || '-%' ORDER BY dia").all(ano);
    const anos = db.prepare('SELECT DISTINCT substr(dia, 1, 4) AS ano FROM feriados ORDER BY ano').all().map((r) => r.ano);
    responder(res, 200, { ano, itens, anos, tipos: TIPOS_FERIADO });
  });

  rota('POST', '/api/feriados', async (req, res, { u, ip }) => {
    exigirGestor(u);
    const b = await corpoJson(req);
    const d = dia(b.dia, 'Data');
    const descricao = String(b.descricao ?? '').trim().slice(0, 120) || falha('Descreva o feriado');
    const tipo = TIPOS_FERIADO.includes(b.tipo) ? b.tipo : falha('Tipo inválido');
    const ativo = b.ativo === false || b.ativo === '0' ? 0 : 1;
    if (b.dia_original && b.dia_original !== d) db.prepare('DELETE FROM feriados WHERE dia = ?').run(dia(b.dia_original, 'Data original'));
    db.prepare(`INSERT INTO feriados (dia, descricao, tipo, ativo) VALUES (?, ?, ?, ?)
      ON CONFLICT(dia) DO UPDATE SET descricao = excluded.descricao, tipo = excluded.tipo, ativo = excluded.ativo`).run(d, descricao, tipo, ativo);
    auditar(u.id, 'feriado_salvo', d, { descricao, tipo, ativo }, ip);
    responder(res, 200, { ok: true });
  });

  rota('POST', '/api/feriados/([0-9-]+)/remover', (req, res, { u, p, ip }) => {
    exigirGestor(u);
    const f = db.prepare('SELECT * FROM feriados WHERE dia = ?').get(p[1]) ?? falha('Feriado não encontrado');
    db.prepare('DELETE FROM feriados WHERE dia = ?').run(f.dia);
    auditar(u.id, 'feriado_removido', f.dia, f, ip);
    responder(res, 200, { ok: true });
  });
}
