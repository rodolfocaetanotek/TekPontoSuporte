// Compara modelos de IA nas mesmas conversas reais, sem gravar nada em analises_ia.
// Referência objetiva: a nota CSAT que o próprio cliente deu (1-2 = insatisfeito, 5 = satisfeito).
// Uso: node src/comparar-ia.mjs --modelos=qwen3:8b,qwen3:14b --n=10 [--protocolos=2026...,2026...]
// Gera dados/comparacao-ia-AAAA-MM-DD.html (fica em dados/, pois contém trechos de conversas).
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, RAIZ } from './config.mjs';
import { db } from './db.mjs';
import { prepararEntrada, consultarModelo } from './ia.mjs';

const arg = (nome, padrao) => process.argv.find((a) => a.startsWith(`--${nome}=`))?.split('=')[1] ?? padrao;
const modelos = arg('modelos', 'qwen3:8b,qwen3:14b').split(',');
const n = Number(arg('n', '10'));
const provedor = arg('provedor', 'ollama');
const protocolos = arg('protocolos', '').split(',').filter(Boolean);

// Amostra equilibrada: metade com cliente insatisfeito (CSAT 2-3), metade satisfeito (CSAT 5).
// CSAT 1 fica de fora: há 29 notas 1 contra 2 notas 2, e a maioria é cliente que agradeceu e
// resolveu — sinal de escala lida ao contrário ("1 = primeira opção"), não de insatisfação.
const amostra = (filtro, limite) => db.prepare(`
  SELECT c.id, c.protocolo, t.nome AS tecnico, MIN(v.nota) AS csat, c.msgs_cliente + c.msgs_tecnico AS msgs
  FROM chamados c JOIN departamentos d ON d.id = c.departamento_id AND d.monitorado = 1
  JOIN avaliacoes v ON v.chamado_id = c.id AND v.origem = 'cliente' AND v.tipo = 'csat' AND v.nota IS NOT NULL
  LEFT JOIN tecnicos t ON t.id = c.tecnico_id
  WHERE c.aberto = 0 AND ${protocolos.length ? `c.protocolo IN (${protocolos.map(() => '?').join(',')})` : 'c.msgs_cliente BETWEEN 3 AND 60'}
  GROUP BY c.id HAVING ${filtro} ORDER BY MIN(v.nota) ASC, c.encerrado_em DESC LIMIT ?`).all(...protocolos, limite);
const chamados = protocolos.length
  ? amostra('1', protocolos.length)
  : [...amostra('MIN(v.nota) BETWEEN 2 AND 3', Math.ceil(n / 2)), ...amostra('MIN(v.nota) = 5', Math.floor(n / 2))];

// Acerto: insatisfação/sentimento coerentes com a nota que o cliente deu.
function acertou(csat, a) {
  if (csat === 1) return null; // não confiável (ver acima)
  if (csat === 2) return a.insatisfacao || a.sentimento === 'negativo';
  if (csat === 3) return a.sentimento !== 'positivo';
  if (csat >= 5) return !a.insatisfacao && a.sentimento !== 'negativo';
  return null; // nota 4: ambígua, não entra na conta
}

const resultados = [];
console.log(`${chamados.length} conversa(s) × ${modelos.length} modelo(s) via ${provedor}\n`);
for (const c of chamados) {
  const entrada = prepararEntrada(c.id);
  if (entrada.erro) { console.log(`- ${c.protocolo}: ${entrada.erro}`); continue; }
  const linha = { ...c, porModelo: {} };
  for (const modelo of modelos) {
    try {
      const r = await consultarModelo(entrada.conteudo, { provedor, modelo });
      linha.porModelo[modelo] = { ...r.analise, segundos: r.segundos, acerto: acertou(c.csat, r.analise) };
      console.log(`${c.protocolo} CSAT ${c.csat} | ${modelo.padEnd(12)} ${r.analise.sentimento.padEnd(8)} insat=${r.analise.insatisfacao ? 'S' : 'N'} nota=${r.analise.nota_qualidade} ${Math.round(r.segundos)}s ${linha.porModelo[modelo].acerto === false ? '✗' : ''}`);
    } catch (e) {
      linha.porModelo[modelo] = { erro: e.message };
      console.log(`${c.protocolo} | ${modelo}: ERRO ${e.message}`);
    }
  }
  resultados.push(linha);
}

const resumo = modelos.map((m) => {
  const ok = resultados.map((r) => r.porModelo[m]).filter((x) => x && !x.erro);
  const julgados = ok.filter((x) => x.acerto !== null);
  return {
    modelo: m,
    analisadas: ok.length,
    erros: resultados.length - ok.length,
    acertos: julgados.filter((x) => x.acerto).length,
    julgados: julgados.length,
    tempoMedio: ok.length ? ok.reduce((s, x) => s + x.segundos, 0) / ok.length : null,
  };
});
console.log('\nResumo:');
for (const r of resumo) console.log(`  ${r.modelo.padEnd(12)} acerto ${r.acertos}/${r.julgados} | ${r.erros} erro(s) | ${r.tempoMedio == null ? '-' : Math.round(r.tempoMedio) + ' s'} por conversa`);

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const celula = (a) => (!a ? '' : a.erro ? `<td class="erro">${esc(a.erro)}</td>` : `<td class="${a.acerto === false ? 'errou' : a.acerto ? 'acertou' : ''}">
  <b>${esc(a.sentimento)}</b> · insatisfação: ${a.insatisfacao ? 'sim' : 'não'} · nota ${a.nota_qualidade} · confiança ${Math.round(a.confianca * 100)}% · ${Math.round(a.segundos)} s
  ${a.motivos.length ? `<br><small>motivos: ${esc(a.motivos.join(', '))}</small>` : ''}<p>${esc(a.resumo)}</p>
  ${a.pontos_melhoria.length ? `<small>melhoria: ${esc(a.pontos_melhoria.join(' | '))}</small>` : ''}</td>`);
const html = `<!doctype html><meta charset="utf-8"><title>Comparação de modelos de IA</title>
<style>body{font:14px system-ui;margin:24px;color:#222}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px;vertical-align:top;text-align:left}
th{background:#f4f4f4}.acertou{background:#eaf7ef}.errou{background:#fdecec}.erro{color:#c62828}p{margin:6px 0}small{color:#555}</style>
<h1>Comparação de modelos de IA — ${new Date().toLocaleString('pt-BR')}</h1>
<p>Provedor: ${esc(provedor)}. Referência: nota CSAT dada pelo cliente (2 deve gerar insatisfação/negativo; 3 não pode ser positivo; 5 não pode ter insatisfação). Notas 1 e 4 não entram no acerto.
Verde = coerente com o cliente, vermelho = incoerente.</p>
<table><tr><th>Modelo</th><th>Acerto</th><th>Erros</th><th>Tempo médio</th></tr>
${resumo.map((r) => `<tr><td>${esc(r.modelo)}</td><td>${r.acertos}/${r.julgados}</td><td>${r.erros}</td><td>${r.tempoMedio == null ? '—' : Math.round(r.tempoMedio) + ' s'}</td></tr>`).join('')}</table>
<h2>Por conversa</h2><table><tr><th>Protocolo</th><th>CSAT do cliente</th>${modelos.map((m) => `<th>${esc(m)}</th>`).join('')}</tr>
${resultados.map((r) => `<tr><td>${esc(r.protocolo)}<br><small>${esc(r.tecnico)} · ${r.msgs} msgs</small></td><td>${r.csat}</td>${modelos.map((m) => celula(r.porModelo[m])).join('')}</tr>`).join('')}</table>`;
const arquivo = path.join(RAIZ, 'dados', `comparacao-ia-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.html`);
writeFileSync(arquivo, html);
console.log(`\nRelatório: ${arquivo}`);
