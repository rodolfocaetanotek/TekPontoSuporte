// Gestão da equipe: dias úteis, disponibilidade, meta do dia, produção (chat + voz) e os números
// dos dashboards. Regras trazidas da Base Bruno:
// - Dia útil = segunda a sexta que não é feriado ativo. Feriado "facultativo" conta como dia útil
//   (aparece no calendário, mas a meta continua); para folgar nele, desative-o ou lance a folga.
// - Sem registro de disponibilidade no dia = Presente (100%).
// - Ausência parcial (atestado, banco de horas, treinamento) com horário: fração = 1 - horas / jornada.
// - Meta do dia = meta do dia lançada na disponibilidade, ou meta vigente (metas por período,
//   senão a meta padrão do técnico) × fração disponível. Sem meta cadastrada = sem meta (não inventa).
// - Produção = chamados do Digisac encerrados no dia (com mensagem do cliente) + ligações atendidas
//   na fila do Ponto na GoTo.
import { db } from './db.mjs';
import { DESLOCAMENTO_LOCAL } from './indicadores.mjs';

export const STATUS_DISPONIBILIDADE = {
  'Presente': 1, 'Meio período': 0.5, 'Férias': 0, 'Folga': 0, 'DayOff': 0, 'Ausente': 0,
  'Atestado': 0, 'Banco de horas': 0, 'Treinamento': 0,
};
// Estes podem ser parciais: com horário de ausência, a fração vem das horas.
export const STATUS_PARCIAIS = new Set(['Atestado', 'Banco de horas', 'Treinamento']);
export const JORNADA_PADRAO_MIN = 432; // 7h12, a jornada da Base Bruno
const NIVEL_SERVICO_SEG = 20; // ligação atendida em até 20 s de fila

const umDia = 86400_000;
export const dias = (de, ate) => {
  const lista = [];
  for (let t = Date.parse(`${de}T12:00:00Z`); t <= Date.parse(`${ate}T12:00:00Z`); t += umDia) lista.push(new Date(t).toISOString().slice(0, 10));
  return lista;
};
const diaDaSemana = (dia) => new Date(`${dia}T12:00:00Z`).getUTCDay();
export const hojeLocal = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const minutos = (hhmm) => { const [h, m] = String(hhmm ?? '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };

export function feriadosEntre(de, ate) {
  return new Map(db.prepare('SELECT dia, descricao, tipo, ativo FROM feriados WHERE dia BETWEEN ? AND ?').all(de, ate).map((f) => [f.dia, f]));
}

export function tipoDoDia(dia, feriados) {
  const f = feriados.get(dia);
  const ds = diaDaSemana(dia);
  if (f?.ativo && f.tipo !== 'facultativo') return { util: false, motivo: 'feriado', feriado: f };
  if (ds === 0 || ds === 6) return { util: false, motivo: 'fim de semana', feriado: f ?? null };
  return { util: true, motivo: null, feriado: f?.ativo ? f : null };
}

export function fracaoDoStatus(status, inicio, fim, jornadaMin) {
  if (!(status in STATUS_DISPONIBILIDADE)) throw new Error(`Status inválido: ${status}`);
  if (STATUS_PARCIAIS.has(status) && inicio && fim) {
    const ausente = minutos(fim) - minutos(inicio);
    if (!(ausente > 0)) throw new Error('O fim da ausência deve ser depois do início');
    return Math.max(0, Math.min(1, Number((1 - ausente / (jornadaMin || JORNADA_PADRAO_MIN)).toFixed(4))));
  }
  return STATUS_DISPONIBILIDADE[status];
}

export const equipe = ({ incluirInativos = false } = {}) => db.prepare(`
  SELECT id, nome, email, matricula, data_admissao, funcao, jornada_min, meta_padrao, goto_agente, situacao
  FROM tecnicos WHERE na_equipe = 1 ${incluirInativos ? '' : "AND situacao = 'Ativo'"} ORDER BY nome`).all();

// Monta, para cada técnico e dia, o que vale: dia útil, disponibilidade, meta e produção.
export function grade(de, ate, tecnicos = equipe()) {
  const lista = dias(de, ate);
  const feriados = feriadosEntre(de, ate);
  const ids = tecnicos.map((t) => t.id);
  const marcadores = ids.map(() => '?').join(',') || "''";

  const disp = new Map(db.prepare(`SELECT * FROM disponibilidade WHERE dia BETWEEN ? AND ? AND tecnico_id IN (${marcadores})`)
    .all(de, ate, ...ids).map((d) => [`${d.tecnico_id}|${d.dia}`, d]));
  const metas = db.prepare(`SELECT tecnico_id, desde, meta FROM metas_periodo WHERE tecnico_id IN (${marcadores}) ORDER BY desde`).all(...ids);
  const escalas = db.prepare(`SELECT te.tecnico_id, te.desde, te.ate, e.nome, e.hora_inicio, e.hora_fim FROM tecnico_escalas te
    JOIN escalas e ON e.id = te.escala_id WHERE te.tecnico_id IN (${marcadores}) ORDER BY te.desde`).all(...ids);

  const deUtc = new Date(`${de}T00:00:00-03:00`).toISOString();
  const ateUtc = new Date(Date.parse(`${ate}T00:00:00-03:00`) + umDia).toISOString();
  const chats = new Map(db.prepare(`SELECT c.tecnico_id, date(c.encerrado_em, '${DESLOCAMENTO_LOCAL}') AS dia, COUNT(*) AS n
    FROM chamados c JOIN departamentos d ON d.id = c.departamento_id AND d.monitorado = 1
    WHERE c.aberto = 0 AND c.msgs_cliente > 0 AND c.encerrado_em >= ? AND c.encerrado_em < ? AND c.tecnico_id IN (${marcadores})
    GROUP BY 1, 2`).all(deUtc, ateUtc, ...ids).map((r) => [`${r.tecnico_id}|${r.dia}`, r.n]));
  const voz = new Map(db.prepare(`SELECT t.id AS tecnico_id, l.dia, COUNT(*) AS n FROM ligacoes l JOIN tecnicos t ON t.goto_agente = l.agente
    WHERE l.dia BETWEEN ? AND ? AND t.id IN (${marcadores}) GROUP BY 1, 2`).all(de, ate, ...ids).map((r) => [`${r.tecnico_id}|${r.dia}`, r.n]));

  const vigente = (lista2, tecnicoId, dia) => {
    let atual = null;
    for (const x of lista2) if (x.tecnico_id === tecnicoId && x.desde <= dia && (!x.ate || x.ate >= dia)) atual = x;
    return atual;
  };

  return tecnicos.map((t) => ({
    tecnico: t,
    dias: lista.map((dia) => {
      const tipo = tipoDoDia(dia, feriados);
      const antesDaAdmissao = t.data_admissao && dia < t.data_admissao;
      const registro = disp.get(`${t.id}|${dia}`) ?? null;
      const util = tipo.util && !antesDaAdmissao;
      const fracao = !util ? 0 : registro ? registro.fracao : 1;
      const metaBase = vigente(metas, t.id, dia)?.meta ?? t.meta_padrao ?? null;
      const meta = !util ? 0 : registro?.meta_do_dia ?? (metaBase == null ? null : Number((metaBase * fracao).toFixed(2)));
      const nChats = chats.get(`${t.id}|${dia}`) ?? 0;
      const nVoz = voz.get(`${t.id}|${dia}`) ?? 0;
      return {
        dia, util, motivo: antesDaAdmissao ? 'antes da admissão' : tipo.motivo, feriado: tipo.feriado,
        status: !util ? null : registro?.status ?? 'Presente', fracao, registro, meta,
        escala: vigente(escalas, t.id, dia), chats: nChats, ligacoes: nVoz, realizado: nChats + nVoz,
      };
    }),
  }));
}

// Totais de um técnico no período.
export function resumir({ tecnico, dias: lista }) {
  const uteis = lista.filter((d) => d.util);
  const comMeta = uteis.filter((d) => d.meta != null);
  const ausencias = {};
  for (const d of uteis) if (d.status !== 'Presente') ausencias[d.status] = (ausencias[d.status] ?? 0) + (1 - d.fracao);
  const meta = comMeta.length ? comMeta.reduce((s, d) => s + d.meta, 0) : null;
  const realizado = lista.reduce((s, d) => s + d.realizado, 0);
  return {
    id: tecnico.id, nome: tecnico.nome, funcao: tecnico.funcao ?? null,
    dias_uteis: uteis.length,
    dias_disponiveis: Number(uteis.reduce((s, d) => s + d.fracao, 0).toFixed(2)),
    disponibilidade: uteis.length ? uteis.reduce((s, d) => s + d.fracao, 0) / uteis.length : null,
    ausencias,
    meta: meta == null ? null : Number(meta.toFixed(1)),
    chats: lista.reduce((s, d) => s + d.chats, 0),
    ligacoes: lista.reduce((s, d) => s + d.ligacoes, 0),
    realizado,
    atingimento: meta ? realizado / meta : null,
    media_por_dia_disponivel: uteis.reduce((s, d) => s + d.fracao, 0) ? realizado / uteis.reduce((s, d) => s + d.fracao, 0) : null,
    escala: lista.at(-1)?.escala ?? null,
  };
}

// --- Voz (GoTo) ---------------------------------------------------------------

function filtroVoz({ de, ate, tecnico }) {
  const cond = ['l.dia BETWEEN ? AND ?'];
  const args = [de, ate];
  if (tecnico) { cond.push('t.id = ?'); args.push(tecnico); }
  return { where: cond.join(' AND '), args };
}

const mediana = (v) => {
  const s = v.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function voz(f) {
  const { where, args } = filtroVoz(f);
  const base = `FROM ligacoes l LEFT JOIN tecnicos t ON t.goto_agente = l.agente WHERE ${where}`;
  const linhas = db.prepare(`SELECT l.espera_seg, l.total_seg, l.conversa_seg ${base}`).all(...args);
  const n = linhas.length;
  const soma = (k) => linhas.reduce((s, l) => s + (l[k] ?? 0), 0);
  const resumo = {
    ligacoes: n,
    espera_media_seg: n ? soma('espera_seg') / n : null,
    espera_mediana_seg: mediana(linhas.map((l) => l.espera_seg)),
    espera_maxima_seg: n ? Math.max(...linhas.map((l) => l.espera_seg ?? 0)) : null,
    nivel_servico: n ? linhas.filter((l) => (l.espera_seg ?? 0) <= NIVEL_SERVICO_SEG).length / n : null,
    nivel_servico_seg: NIVEL_SERVICO_SEG,
    tma_medio_seg: n ? soma('total_seg') / n : null,
    tma_mediano_seg: mediana(linhas.map((l) => l.total_seg)),
    conversa_total_seg: soma('conversa_seg'),
  };
  const porDia = db.prepare(`SELECT l.dia, COUNT(*) AS ligacoes, AVG(l.espera_seg) AS espera_media_seg, AVG(l.total_seg) AS tma_medio_seg
    ${base} GROUP BY l.dia ORDER BY l.dia`).all(...args);
  const porHora = db.prepare(`SELECT CAST(strftime('%w', l.dia) AS INTEGER) AS dia_semana, l.hora, COUNT(*) AS chamados
    ${base} AND l.hora IS NOT NULL GROUP BY 1, 2`).all(...args);
  const porAgente = db.prepare(`SELECT t.id, COALESCE(t.nome, l.agente) AS nome, l.agente, COUNT(*) AS ligacoes,
      AVG(l.espera_seg) AS espera_media_seg, AVG(l.total_seg) AS tma_medio_seg, SUM(l.conversa_seg) AS conversa_total_seg
    ${base} GROUP BY l.agente ORDER BY ligacoes DESC`).all(...args);
  const pausasPorAgente = new Map(db.prepare(`SELECT p.agente, SUM(p.duracao_seg) AS seg, SUM(p.quantidade) AS qtd FROM pausas p
    LEFT JOIN tecnicos t ON t.goto_agente = p.agente WHERE p.dia BETWEEN ? AND ? ${f.tecnico ? 'AND t.id = ?' : ''}
    AND p.agente IN (SELECT DISTINCT agente FROM ligacoes) GROUP BY p.agente`).all(f.de, f.ate, ...(f.tecnico ? [f.tecnico] : [])).map((p) => [p.agente, p]));
  for (const a of porAgente) { const p = pausasPorAgente.get(a.agente); a.pausas_seg = p?.seg ?? 0; a.pausas_qtd = p?.qtd ?? 0; }
  const pausas = db.prepare(`SELECT p.motivo, SUM(p.duracao_seg) AS seg, SUM(p.quantidade) AS qtd FROM pausas p
    LEFT JOIN tecnicos t ON t.goto_agente = p.agente WHERE p.dia BETWEEN ? AND ? ${f.tecnico ? 'AND t.id = ?' : ''}
    AND p.agente IN (SELECT DISTINCT agente FROM ligacoes) GROUP BY p.motivo ORDER BY seg DESC`).all(f.de, f.ate, ...(f.tecnico ? [f.tecnico] : []));

  // Dias úteis sem nenhuma ligação na base (ex.: agosto/2026 veio vazio): avisa na tela.
  const feriados = feriadosEntre(f.de, f.ate);
  const comLigacao = new Set(porDia.map((d) => d.dia));
  const ultimoDia = f.ate > hojeLocal() ? hojeLocal() : f.ate;
  const diasSemDados = f.tecnico ? [] : dias(f.de, ultimoDia).filter((d) => tipoDoDia(d, feriados).util && !comLigacao.has(d));
  return { resumo, porDia, porHora, porAgente, pausas, diasSemDados };
}

const FAIXAS_TMA = [[0, 60, 'até 1 min'], [60, 180, '1 a 3 min'], [180, 300, '3 a 5 min'], [300, 600, '5 a 10 min'], [600, 1200, '10 a 20 min'], [1200, Infinity, 'mais de 20 min']];
const FAIXAS_ESPERA = [[0, 10, 'até 10 s'], [10, 20, '10 a 20 s'], [20, 30, '20 a 30 s'], [30, 60, '30 s a 1 min'], [60, 120, '1 a 2 min'], [120, Infinity, 'mais de 2 min']];

export function chamadasDeVoz(f, { esperaMin = 0, duracaoMin = 0, ordem = 'recentes', pagina = 1, porPagina = 50 } = {}) {
  const { where, args } = filtroVoz(f);
  const cond = `${where} AND COALESCE(l.espera_seg, 0) >= ? AND COALESCE(l.total_seg, 0) >= ?`;
  const todos = [...args, esperaMin, duracaoMin];
  const ordens = { recentes: 'l.inicio DESC', longas: 'l.total_seg DESC', espera: 'l.espera_seg DESC', curtas: 'l.total_seg ASC' };
  const base = `FROM ligacoes l LEFT JOIN tecnicos t ON t.goto_agente = l.agente WHERE ${cond}`;
  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...todos).n;
  const itens = db.prepare(`SELECT l.id, l.inicio, l.dia, l.hora, l.agente, t.id AS tecnico_id, COALESCE(t.nome, l.agente) AS tecnico,
      l.espera_seg, l.conversa_seg, l.pos_seg, l.total_seg ${base} ORDER BY ${ordens[ordem] ?? ordens.recentes} LIMIT ? OFFSET ?`)
    .all(...todos, porPagina, (pagina - 1) * porPagina);
  const valores = db.prepare(`SELECT l.espera_seg, l.total_seg ${base}`).all(...todos);
  const faixa = (lista, campo) => lista.map(([min, max, rotulo]) => ({ rotulo, n: valores.filter((v) => (v[campo] ?? 0) >= min && (v[campo] ?? 0) < max).length }));
  return { total, pagina, porPagina, itens, faixasTma: faixa(FAIXAS_TMA, 'total_seg'), faixasEspera: faixa(FAIXAS_ESPERA, 'espera_seg') };
}

export function pausasDoTecnico(tecnicoId, de, ate) {
  return db.prepare(`SELECT p.motivo, SUM(p.duracao_seg) AS seg, SUM(p.quantidade) AS qtd FROM pausas p
    JOIN tecnicos t ON t.goto_agente = p.agente WHERE t.id = ? AND p.dia BETWEEN ? AND ? GROUP BY p.motivo ORDER BY seg DESC`).all(tecnicoId, de, ate);
}

// --- Gestão (visão da equipe) -------------------------------------------------

export function painelGestao(de, ate) {
  const g = grade(de, ate);
  const tecnicos = g.map(resumir);
  const comMeta = tecnicos.filter((t) => t.meta);
  const meta = comMeta.length ? comMeta.reduce((s, t) => s + t.meta, 0) : null;
  const realizado = tecnicos.reduce((s, t) => s + t.realizado, 0);

  // Semana a semana (segunda a domingo), meta x realizado da equipe.
  const semanas = new Map();
  for (const { dias: lista } of g) {
    for (const d of lista) {
      const ds = diaDaSemana(d.dia);
      const segunda = new Date(Date.parse(`${d.dia}T12:00:00Z`) - ((ds + 6) % 7) * umDia).toISOString().slice(0, 10);
      const s = semanas.get(segunda) ?? { semana: segunda, meta: 0, temMeta: false, realizado: 0, chats: 0, ligacoes: 0 };
      if (d.meta != null) { s.meta += d.meta; s.temMeta = true; }
      s.realizado += d.realizado; s.chats += d.chats; s.ligacoes += d.ligacoes;
      semanas.set(segunda, s);
    }
  }

  const ausencias = {};
  for (const t of tecnicos) for (const [status, diasAusente] of Object.entries(t.ausencias)) ausencias[status] = (ausencias[status] ?? 0) + diasAusente;

  // Projeção do período: ritmo dos dias úteis já passados aplicado aos que faltam.
  const hoje = hojeLocal();
  const passados = g.flatMap((x) => x.dias).filter((d) => d.util && d.dia <= hoje);
  const futuros = g.flatMap((x) => x.dias).filter((d) => d.util && d.dia > hoje);
  const diasPassados = new Set(passados.map((d) => d.dia)).size;
  const diasFuturos = new Set(futuros.map((d) => d.dia)).size;
  const ritmo = diasPassados ? realizado / diasPassados : null;
  const projecao = ritmo == null ? null : Math.round(realizado + ritmo * diasFuturos);

  const alertas = [];
  for (const t of tecnicos) {
    if (t.atingimento != null && t.atingimento < 0.8) alertas.push({ tipo: 'meta', tecnico: t.nome, texto: `${Math.round(t.atingimento * 100)}% da meta no período` });
    if (t.disponibilidade != null && t.disponibilidade < 0.7 && t.dias_uteis >= 5) alertas.push({ tipo: 'disponibilidade', tecnico: t.nome, texto: `disponível em ${Math.round(t.disponibilidade * 100)}% dos dias úteis` });
  }
  const semMeta = tecnicos.filter((t) => t.meta == null).map((t) => t.nome);

  return {
    resumo: {
      tecnicos: tecnicos.length, meta: meta == null ? null : Number(meta.toFixed(1)), realizado,
      chats: tecnicos.reduce((s, t) => s + t.chats, 0), ligacoes: tecnicos.reduce((s, t) => s + t.ligacoes, 0),
      atingimento: meta ? realizado / meta : null,
      disponibilidade: tecnicos.length ? tecnicos.reduce((s, t) => s + (t.disponibilidade ?? 0), 0) / tecnicos.length : null,
      dias_uteis: new Set(g.flatMap((x) => x.dias).filter((d) => d.util).map((d) => d.dia)).size,
      projecao, dias_passados: diasPassados, dias_futuros: diasFuturos,
    },
    tecnicos, semanas: [...semanas.values()].map((s) => ({ ...s, meta: s.temMeta ? Number(s.meta.toFixed(1)) : null })),
    ausencias, alertas, semMeta,
  };
}
