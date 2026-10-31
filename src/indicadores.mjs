// Cálculo dos indicadores. Toda regra de negócio de "como se mede" fica aqui,
// documentada, para que a coordenação possa validar o número contra o Digisac.
import { db } from './db.mjs';

// Fuso de exibição: America/Sao_Paulo (UTC-3, sem horário de verão desde 2019).
export const DESLOCAMENTO_LOCAL = '-3 hours';

/**
 * Métricas de um chamado a partir das suas mensagens (ordenadas por data).
 * - primeira_resposta_seg: tempo que o cliente esperou por um humano. Começa na
 *   primeira mensagem do cliente ou, se o robô (menu/URA) falou depois disso, na
 *   última mensagem do robô antes do técnico — o tempo navegando no menu não é
 *   do técnico. Termina na primeira mensagem de um técnico humano.
 *   Contato ativo (o técnico escreveu antes do cliente) não tem 1ª resposta,
 *   como no Digisac: quem iniciou a conversa foi a empresa.
 * - duracao_seg: do início ao encerramento do chamado (só chamados encerrados).
 */
export function metricasDoChamado(chamado, mensagens) {
  const conta = { cliente: 0, tecnico: 0, bot: 0 };
  let primeiraCliente = null;
  let ultimoBot = null;
  let primeiraResposta = null;
  let contatoAtivo = false;
  for (const m of mensagens) {
    if (m.autor in conta) conta[m.autor]++;
    if (m.autor === 'tecnico' && !primeiraCliente) contatoAtivo = true;
    if (m.autor === 'cliente' && !primeiraCliente) primeiraCliente = m.quando;
    if (m.autor === 'bot' && primeiraCliente && !primeiraResposta) ultimoBot = m.quando;
    if (m.autor === 'tecnico' && primeiraCliente && !primeiraResposta) primeiraResposta = m.quando;
  }
  const inicioEspera = ultimoBot && ultimoBot > primeiraCliente ? ultimoBot : primeiraCliente;
  const seg = (a, b) => (a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : null);
  return {
    primeira_resposta_seg: contatoAtivo ? null : seg(inicioEspera, primeiraResposta),
    duracao_seg: chamado.aberto ? null : seg(chamado.iniciado_em, chamado.encerrado_em),
    msgs_cliente: conta.cliente,
    msgs_tecnico: conta.tecnico,
    msgs_bot: conta.bot,
  };
}

export function mediana(valores) {
  const v = valores.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

const media = (valores) => {
  const v = valores.filter((x) => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// Monta o WHERE comum. `escopoTecnico` força o filtro para o perfil técnico.
function filtro({ de, ate, tecnico, departamento }, escopoTecnico) {
  const cond = ['d.monitorado = 1'];
  const args = [];
  if (de) { cond.push('c.iniciado_em >= ?'); args.push(de); }
  if (ate) { cond.push('c.iniciado_em < ?'); args.push(ate); }
  const t = escopoTecnico ?? tecnico;
  if (t) { cond.push('c.tecnico_id = ?'); args.push(t); }
  const deps = [departamento ?? []].flat().filter(Boolean);
  if (deps.length) { cond.push(`c.departamento_id IN (${deps.map(() => '?').join(',')})`); args.push(...deps); }
  return { where: cond.join(' AND '), args };
}

// Sentimento e nota "valendo": só contam análises revisadas por uma pessoa.
const SQL_SENT = `CASE WHEN a.status IN ('aprovada','ajustada') THEN COALESCE(a.sentimento_revisado, a.sentimento) END`;
const SQL_NOTA = `CASE WHEN a.status IN ('aprovada','ajustada') THEN COALESCE(a.nota_revisada, a.nota_qualidade) END`;

function linhasChamados(f, escopo) {
  const { where, args } = filtro(f, escopo);
  return db.prepare(`
    SELECT c.*, t.nome AS tecnico_nome, ${SQL_SENT} AS sentimento_valido, ${SQL_NOTA} AS nota_valida,
           a.status AS status_ia, a.insatisfacao AS insatisfacao_ia,
           (SELECT AVG(nota) FROM avaliacoes v WHERE v.chamado_id = c.id AND v.origem = 'cliente' AND v.tipo = 'csat') AS csat,
           (SELECT AVG(nota) FROM avaliacoes v WHERE v.chamado_id = c.id AND v.origem = 'ia_digisac' AND v.tipo = 'csat') AS csat_ia
    FROM chamados c
    JOIN departamentos d ON d.id = c.departamento_id
    LEFT JOIN tecnicos t ON t.id = c.tecnico_id
    LEFT JOIN analises_ia a ON a.chamado_id = c.id
    WHERE ${where}`).all(...args);
}

function agregar(linhas) {
  const encerrados = linhas.filter((c) => !c.aberto);
  const revisadas = linhas.filter((c) => c.sentimento_valido);
  const sent = { positivo: 0, neutro: 0, negativo: 0 };
  for (const c of revisadas) sent[c.sentimento_valido] = (sent[c.sentimento_valido] ?? 0) + 1;
  const insatisfeitos = linhas.filter((c) => c.status_ia && c.status_ia !== 'descartada' && c.insatisfacao_ia).length;
  return {
    chamados: linhas.length,
    encerrados: encerrados.length,
    abertos: linhas.length - encerrados.length,
    primeira_resposta_media_seg: media(linhas.map((c) => c.primeira_resposta_seg)),
    primeira_resposta_mediana_seg: mediana(linhas.map((c) => c.primeira_resposta_seg)),
    duracao_media_seg: media(encerrados.map((c) => c.duracao_seg)),
    duracao_mediana_seg: mediana(encerrados.map((c) => c.duracao_seg)),
    msgs_tecnico: linhas.reduce((s, c) => s + c.msgs_tecnico, 0),
    transferencias: linhas.reduce((s, c) => s + c.transferencias, 0),
    csat_medio: media(linhas.map((c) => c.csat)),
    csat_respostas: linhas.filter((c) => c.csat != null).length,
    // Nota que a IA do próprio Digisac atribui; só referência, não é resposta do cliente.
    csat_ia_digisac: media(linhas.map((c) => c.csat_ia)),
    nota_qualidade_media: media(linhas.map((c) => c.nota_valida)),
    sentimento: sent,
    analises_revisadas: revisadas.length,
    analises_pendentes: linhas.filter((c) => c.status_ia === 'pendente').length,
    sinais_insatisfacao: insatisfeitos,
  };
}

export function painel(f, escopoTecnico = null) {
  const linhas = linhasChamados(f, escopoTecnico);
  const { where, args } = filtro(f, escopoTecnico);

  const porTecnico = new Map();
  for (const c of linhas) {
    const chave = c.tecnico_id ?? '';
    if (!porTecnico.has(chave)) porTecnico.set(chave, { id: c.tecnico_id, nome: c.tecnico_nome ?? 'Sem técnico (fila/bot)', linhas: [] });
    porTecnico.get(chave).linhas.push(c);
  }

  const porDia = db.prepare(`
    SELECT date(c.iniciado_em, '${DESLOCAMENTO_LOCAL}') AS dia, COUNT(*) AS chamados,
           SUM(CASE WHEN c.aberto = 0 THEN 1 ELSE 0 END) AS encerrados
    FROM chamados c JOIN departamentos d ON d.id = c.departamento_id
    WHERE ${where} GROUP BY dia ORDER BY dia`).all(...args);

  const porHora = db.prepare(`
    SELECT CAST(strftime('%w', c.iniciado_em, '${DESLOCAMENTO_LOCAL}') AS INTEGER) AS dia_semana,
           CAST(strftime('%H', c.iniciado_em, '${DESLOCAMENTO_LOCAL}') AS INTEGER) AS hora, COUNT(*) AS chamados
    FROM chamados c JOIN departamentos d ON d.id = c.departamento_id
    WHERE ${where} GROUP BY dia_semana, hora`).all(...args);

  const assuntos = db.prepare(`
    SELECT COALESCE(c.assunto, '(sem assunto)') AS assunto, COUNT(*) AS chamados
    FROM chamados c JOIN departamentos d ON d.id = c.departamento_id
    WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 12`).all(...args);

  const motivos = new Map();
  const motivosLinhas = db.prepare(`
    SELECT a.motivos FROM analises_ia a JOIN chamados c ON c.id = a.chamado_id
    JOIN departamentos d ON d.id = c.departamento_id
    WHERE ${where} AND a.status IN ('aprovada','ajustada') AND a.insatisfacao = 1`).all(...args);
  for (const { motivos: m } of motivosLinhas) {
    for (const motivo of JSON.parse(m || '[]')) motivos.set(motivo, (motivos.get(motivo) ?? 0) + 1);
  }

  return {
    resumo: agregar(linhas),
    tecnicos: [...porTecnico.values()]
      .map(({ id, nome, linhas: l }) => ({ id, nome, ...agregar(l) }))
      .sort((a, b) => b.chamados - a.chamados),
    porDia,
    porHora,
    assuntos,
    motivosInsatisfacao: [...motivos].map(([motivo, n]) => ({ motivo, n })).sort((a, b) => b.n - a.n).slice(0, 10),
  };
}

// Números locais no mesmo recorte usado pelo /dashboard/general do Digisac
// (período pela data de abertura), para a tela de conferência.
export function numerosParaConferencia(de, ate) {
  const r = agregar(linhasChamados({ de, ate }, null));
  return {
    chamados: r.chamados,
    encerrados: r.encerrados,
    abertos: r.abertos,
    primeira_resposta_media_seg: r.primeira_resposta_media_seg,
    duracao_media_seg: r.duracao_media_seg,
  };
}
