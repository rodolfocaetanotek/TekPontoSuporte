// Importa da Base Bruno (banco SQLite do sistema de gestão das outras áreas, alimentado pela
// API da GoTo) só o que é do Ponto: ligações da fila "Ponto Eletrônico", pausas dos atendentes
// dessa fila, as escalas-padrão e os feriados. O arquivo é aberto só para leitura.
// Ficam de fora, de propósito: salários, senhas, feedbacks de RH e dados de AT/Fiscal/Folha.
// Abandonos também ficam de fora: na base eles não indicam a fila (os sem área misturam Ponto,
// Administrativo e Legal One), então não dá para separar os do Ponto.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';
import { db, agora, lerEstado, gravarEstado, transacao } from './db.mjs';

// O arquivo mais recente da pasta (os backups têm a data no nome: database.db.backup-AAAAMMDD_HHMMSS).
export function arquivoMaisRecente(pasta = config.baseGoto.pasta) {
  let arquivos;
  try { arquivos = readdirSync(pasta); } catch { return null; }
  return arquivos
    .filter((n) => /^database\.db/i.test(n) && !/-(wal|shm|journal)$/i.test(n))
    .map((n) => { const p = path.join(pasta, n); const s = statSync(p); return { caminho: p, nome: n, mtime: s.mtimeMs, tamanho: s.size }; })
    .sort((a, b) => b.mtime - a.mtime)[0] ?? null;
}

const normalizar = (nome) => String(nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .split(/\s+/).filter((p) => p && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(p));

// "Carlos Souza" (Digisac) = "Carlos Eduardo Lima Souza" (GoTo): mesmo primeiro nome e todas
// as partes do nome mais curto presentes no mais longo. Ambíguo (2+ candidatos) não liga.
export function mesmoNome(a, b) {
  const [x, y] = [normalizar(a), normalizar(b)];
  if (!x.length || !y.length || x[0] !== y[0]) return false;
  const [curto, longo] = x.length <= y.length ? [x, y] : [y, x];
  return curto.every((p) => longo.includes(p));
}

function vincularAgentes(agentes) {
  const tecnicos = db.prepare('SELECT id, nome, goto_agente FROM tecnicos').all();
  const jaLigados = new Set(tecnicos.map((t) => t.goto_agente).filter(Boolean));
  let ligados = 0;
  for (const agente of agentes) {
    if (jaLigados.has(agente)) continue;
    const candidatos = tecnicos.filter((t) => !t.goto_agente && mesmoNome(t.nome, agente));
    if (candidatos.length !== 1) continue;
    db.prepare('UPDATE tecnicos SET goto_agente = ?, na_equipe = 1 WHERE id = ?').run(agente, candidatos[0].id);
    candidatos[0].goto_agente = agente;
    ligados++;
  }
  return ligados;
}

const segundos = (ms) => (ms == null ? null : Number(ms) / 1000);

export function importarBase({ arquivo = arquivoMaisRecente(), log = console.log } = {}) {
  if (!arquivo) throw new Error(`Nenhum arquivo database.db* encontrado em ${config.baseGoto.pasta}`);
  const origem = new DatabaseSync(arquivo.caminho, { readOnly: true });
  try {
    const fila = config.baseGoto.fila;
    const ligacoes = origem.prepare(`SELECT contact_id, queue_name, agent_name, contact_creation_time, call_date, hr_ini,
        time_in_queue_ms, talk_time_ms, wrap_time_ms, handle_time_ms, contact_resolution
      FROM ligacoes_importadas WHERE queue_name = ?`).all(fila);
    const agentes = [...new Set(ligacoes.map((l) => l.agent_name))];
    const pausas = agentes.length
      ? origem.prepare(`SELECT agent_name, call_date, pause_reason, pause_duration_ms, pause_count FROM pausas
          WHERE agent_name IN (${agentes.map(() => '?').join(',')})`).all(...agentes)
      : [];
    const escalas = origem.prepare('SELECT nome, hora_inicio, hora_fim, ativo FROM escalas').all();
    const feriados = origem.prepare('SELECT data, descricao, tipo, ativo FROM feriados').all();

    const resumo = transacao(() => {
      const insLigacao = db.prepare(`INSERT INTO ligacoes (id, fila, agente, inicio, dia, hora, espera_seg, conversa_seg, pos_seg, total_seg, resultado)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET agente = excluded.agente, espera_seg = excluded.espera_seg,
        conversa_seg = excluded.conversa_seg, pos_seg = excluded.pos_seg, total_seg = excluded.total_seg, resultado = excluded.resultado`);
      for (const l of ligacoes) {
        insLigacao.run(l.contact_id, l.queue_name, l.agent_name, l.contact_creation_time, l.call_date,
          l.hr_ini ? Number(l.hr_ini.slice(0, 2)) : null, segundos(l.time_in_queue_ms), segundos(l.talk_time_ms),
          segundos(l.wrap_time_ms), segundos(l.handle_time_ms), l.contact_resolution);
      }
      // Pausas não têm identificador na origem: troca o conjunto inteiro dos atendentes da fila.
      if (agentes.length) db.prepare(`DELETE FROM pausas WHERE agente IN (${agentes.map(() => '?').join(',')})`).run(...agentes);
      const insPausa = db.prepare('INSERT INTO pausas (agente, dia, motivo, duracao_seg, quantidade) VALUES (?, ?, ?, ?, ?)');
      for (const p of pausas) insPausa.run(p.agent_name, p.call_date, p.pause_reason, segundos(p.pause_duration_ms) ?? 0, p.pause_count ?? 1);
      // Escalas e feriados: só completam o que falta (edições feitas aqui prevalecem).
      let escalasNovas = 0;
      if (!db.prepare('SELECT COUNT(*) n FROM escalas').get().n) {
        for (const e of escalas) {
          db.prepare('INSERT INTO escalas (nome, hora_inicio, hora_fim, ativo) VALUES (?, ?, ?, ?)').run(e.nome, e.hora_inicio, e.hora_fim, e.ativo);
          escalasNovas++;
        }
      }
      let feriadosNovos = 0;
      const tipos = new Set(['nacional', 'estadual', 'municipal', 'facultativo', 'empresa']);
      for (const f of feriados) {
        feriadosNovos += Number(db.prepare('INSERT OR IGNORE INTO feriados (dia, descricao, tipo, ativo) VALUES (?, ?, ?, ?)')
          .run(f.data, f.descricao, tipos.has(f.tipo) ? f.tipo : 'empresa', f.ativo ? 1 : 0).changes);
      }
      const vinculados = vincularAgentes(agentes);
      return { ligacoes: ligacoes.length, pausas: pausas.length, agentes: agentes.length, vinculados, escalasNovas, feriadosNovos };
    });
    const dias = ligacoes.map((l) => l.call_date).sort();
    const info = { arquivo: arquivo.nome, mtime: arquivo.mtime, tamanho: arquivo.tamanho, importado_em: agora(), fila, ...resumo, de: dias[0] ?? null, ate: dias.at(-1) ?? null };
    gravarEstado('base_goto', JSON.stringify(info));
    log(`Base GoTo: ${resumo.ligacoes} ligações da fila "${fila}", ${resumo.pausas} pausas, ${resumo.vinculados} técnico(s) vinculado(s), ${resumo.feriadosNovos} feriado(s) novo(s).`);
    return info;
  } finally {
    origem.close();
  }
}

export const infoBase = () => { const s = lerEstado('base_goto'); return s ? JSON.parse(s) : null; };

// Chamado a cada ciclo de sincronização: reimporta só quando chega um arquivo novo/alterado.
export function importarSeMudou(log = console.log) {
  const arquivo = arquivoMaisRecente();
  if (!arquivo) return null;
  const atual = infoBase();
  if (atual && atual.arquivo === arquivo.nome && atual.mtime === arquivo.mtime && atual.tamanho === arquivo.tamanho) return null;
  return importarBase({ arquivo, log });
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/base-goto.mjs')) {
  try { importarBase(); process.exit(0); } catch (e) { console.error('ERRO:', e.message); process.exit(1); }
}
