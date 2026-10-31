// Análise de sentimento e qualidade do atendimento com IA (Ollama local ou Claude).
// Toda análise nasce com status 'pendente' e só entra nos indicadores
// depois de aprovada ou ajustada por uma pessoa da coordenação.
// Uso: node src/ia.mjs [--limite=50]
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.mjs';
import { db, agora, lerEstado, gravarEstado } from './db.mjs';
import { transcreverChamado } from './transcricao.mjs';

export const VERSAO_PROMPT = '2026-10-30.1';
const LIMITE_CARACTERES = 300_000;
const MODELOS_COM_FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const MOTIVOS = [
  'demora_na_resposta', 'problema_nao_resolvido', 'reincidencia', 'comunicacao_do_tecnico',
  'excesso_de_transferencias', 'falha_no_sistema_de_ponto', 'questao_comercial', 'outro',
];

const nota = { type: 'number', description: 'De 0 a 10' };
const ESQUEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentimento', 'intensidade', 'insatisfacao', 'motivos', 'nota_qualidade', 'criterios', 'resumo', 'pontos_melhoria', 'evidencias', 'confianca'],
  properties: {
    sentimento: { type: 'string', enum: ['positivo', 'neutro', 'negativo'], description: 'Sentimento predominante do CLIENTE ao final do atendimento' },
    intensidade: { type: 'number', description: 'De 0 (leve) a 1 (muito forte)' },
    insatisfacao: { type: 'boolean', description: 'Há sinal claro de insatisfação do cliente?' },
    motivos: { type: 'array', items: { type: 'string', enum: MOTIVOS } },
    nota_qualidade: nota,
    criterios: {
      type: 'object',
      additionalProperties: false,
      required: ['cordialidade', 'clareza', 'resolucao', 'agilidade', 'procedimento'],
      properties: { cordialidade: nota, clareza: nota, resolucao: nota, agilidade: nota, procedimento: nota },
    },
    resumo: { type: 'string', maxLength: 300, description: 'Até 2 frases curtas: o que o cliente pediu e como terminou' },
    pontos_melhoria: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 160 } },
    evidencias: {
      type: 'array',
      maxItems: 2,
      items: {
        type: 'object', additionalProperties: false, required: ['trecho', 'justificativa'],
        properties: { trecho: { type: 'string', maxLength: 120 }, justificativa: { type: 'string', maxLength: 140 } },
      },
    },
    confianca: { type: 'number', description: 'De 0 a 1: quão seguro você está desta avaliação' },
  },
};

const SISTEMA = `Você avalia atendimentos do Suporte de Ponto Eletrônico da Tek Norte feitos por chat (WhatsApp, via Digisac). Os clientes são empresas que usam relógio de ponto e sistema de controle de jornada; os assuntos típicos são cadastro de funcionários, marcações, comunicação com o relógio (REP), espelho de ponto, banco de horas, AFD/AEJ e integração com a folha.

Sua avaliação é um apoio à coordenação: ela será revisada por uma pessoa antes de valer como indicador, e pode afetar como um técnico é avaliado. Por isso:
- Baseie cada conclusão no que está escrito na conversa. Se a conversa é curta, ambígua ou só tem mensagens automáticas, diga isso no resumo e use confiança baixa.
- Avalie o sentimento do cliente, não o do técnico. Cliente objetivo ou seco não é cliente insatisfeito.
- Não penalize o técnico por fatores fora do controle dele (fila, falha do sistema, regra comercial); registre o motivo e explique na evidência.
- Mensagens de robô e comentários internos aparecem marcados; não os atribua ao técnico.
- Áudios e vídeos aparecem como "(áudio transcrito)": é o que foi falado, convertido em texto automaticamente, e pode ter pequenos erros de reconhecimento. "[áudio]" sem transcrição significa que o conteúdo não está disponível; não suponha o que foi dito.
- Insatisfação nem sempre é dita com palavras fortes. Marque insatisfacao = true e sentimento negativo quando o cliente aponta erro da Tek Norte (cobrança, cadastro, informação errada), repete o pedido ou cobra resposta ("olá?", "alguém?"), fica sem resposta para a dúvida principal, ou quando o chamado é encerrado ou transferido sem resolver nem dar prazo. Nesses casos, resolucao fica baixa.
- Dados pessoais foram mascarados ([TELEFONE], [CPF], [CNPJ], [EMAIL]); não tente reconstruí-los.

Critérios (0 a 10): cordialidade; clareza das orientações; resolução (o problema foi resolvido ou encaminhado corretamente); agilidade (tempo de resposta percebido na conversa); procedimento (seguiu boas práticas: confirmou dados, registrou, deu retorno). nota_qualidade é a sua nota geral, não necessariamente a média.

Seja breve. Em evidencias, cite até 2 trechos curtos e literais da conversa que sustentam a avaliação. Em pontos_melhoria, até 2 orientações práticas e curtas para o técnico, em português, ou deixe vazio se não houver.`;

// --- LGPD: minimização antes de enviar a conversa para fora ---------------------

export function mascarar(texto) {
  return String(texto ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[EMAIL]')
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}[\/.]?\d{4}-?\d{2}\b/g, '[CNPJ]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]')
    .replace(/(\+?55\s?)?\(?\b\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g, '[TELEFONE]');
}

const ROTULO = { cliente: 'CLIENTE', tecnico: 'TÉCNICO', bot: 'ROBÔ', comentario: 'COMENTÁRIO INTERNO', sistema: 'SISTEMA' };

const MAX_POR_MENSAGEM = 400;
const MAX_ROBO = 80;
const MAX_TRANSCRICAO = 1500;
const ROTULO_MIDIA = { ptt: 'áudio', audio: 'áudio', video: 'vídeo' };
const corte = (t, max) => (t.length > max ? `${t.slice(0, max)}…` : t);

// Transcrição enxuta: no processador, cada token lido custa tempo. Fica de fora o que não diz
// nada sobre o atendimento ([ticket], reações, a nota gerada pela IA do Digisac); menus do robô
// viram uma linha curta; a data só aparece quando muda.
export function transcrever(mensagens) {
  let diaAnterior = null;
  const linhas = [];
  for (const m of mensagens) {
    if (m.autor === 'sistema' || m.tipo === 'ia-csat') continue;
    const quando = new Date(m.quando);
    const dia = quando.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    if (dia !== diaAnterior) { linhas.push(`--- ${dia} ---`); diaAnterior = dia; }
    const hora = quando.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    // Áudio/vídeo transcrito entra com o que foi falado, marcado como transcrição.
    if (m.transcricao) {
      const falado = mascarar(m.transcricao.replace(/\s+/g, ' ').trim());
      linhas.push(`[${hora}] ${ROTULO[m.autor]} (${ROTULO_MIDIA[m.tipo] ?? 'mídia'} transcrito): ${corte(falado, MAX_TRANSCRICAO)}`);
      continue;
    }
    const texto = mascarar(String(m.texto ?? '').replace(/\s+/g, ' ').trim());
    linhas.push(`[${hora}] ${ROTULO[m.autor]}: ${corte(texto, m.autor === 'bot' ? MAX_ROBO : MAX_POR_MENSAGEM)}`);
  }
  return linhas.join('\n');
}

// --- Chamada ao modelo --------------------------------------------------------
// Provedores: 'groq' (nuvem, plano gratuito; padrão), 'ollama' (modelo aberto nesta máquina;
// a conversa não sai do computador) e 'anthropic' (Claude, pago, na nuvem).

export class ErroIa extends Error {}

let cliente = null;
function anthropic() {
  cliente ??= new Anthropic();
  return cliente;
}

// Monta o texto enviado ao modelo, ou devolve { erro } se a conversa não é analisável.
export function prepararEntrada(chamadoId) {
  const chamado = db.prepare('SELECT * FROM chamados WHERE id = ?').get(chamadoId);
  if (!chamado) throw new Error('Chamado não encontrado');
  const mensagens = db.prepare('SELECT autor, quando, tipo, texto, transcricao FROM mensagens WHERE chamado_id = ? ORDER BY quando').all(chamadoId);
  if (!mensagens.some((m) => m.autor === 'cliente')) return { erro: 'Sem mensagens do cliente para analisar' };

  const conversa = transcrever(mensagens);
  if (conversa.length > LIMITE_CARACTERES) return { erro: `Conversa longa demais para análise automática (${conversa.length} caracteres); avaliar manualmente` };

  const contexto = [
    `Protocolo: ${chamado.protocolo ?? chamado.id}`,
    `Assunto registrado: ${chamado.assunto ?? '(não informado)'}`,
    `Transferências: ${chamado.transferencias}`,
    `Tempo até a primeira resposta humana: ${chamado.primeira_resposta_seg == null ? 'n/d' : Math.round(chamado.primeira_resposta_seg / 60) + ' min'}`,
    `Duração total: ${chamado.duracao_seg == null ? 'n/d' : Math.round(chamado.duracao_seg / 60) + ' min'}`,
  ].join('\n');
  return { conteudo: `${contexto}\n\n<conversa>\n${conversa}\n</conversa>` };
}

async function consultarAnthropic(conteudo, modelo) {
  const resposta = await anthropic().beta.messages.create({
    model: modelo,
    max_tokens: 16000,
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: conteudo }],
    output_config: { effort: config.ia.esforco, format: { type: 'json_schema', schema: ESQUEMA } },
    ...(MODELOS_COM_FALLBACK.has(modelo) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  });
  if (resposta.stop_reason === 'refusal') throw new ErroIa(`Modelo recusou a análise (${resposta.stop_details?.category ?? 'sem categoria'})`);
  if (resposta.stop_reason === 'max_tokens') throw new ErroIa('Resposta da IA cortada por limite de tokens');
  const texto = resposta.content.find((b) => b.type === 'text')?.text;
  if (!texto) throw new ErroIa('A IA não devolveu conteúdo');
  return { texto, modelo: resposta.model };
}

// Ollama: /api/chat com `format` = esquema JSON (saída estruturada) e temperatura 0
// para a mesma conversa gerar a mesma avaliação.
async function consultarOllama(conteudo, modelo) {
  const sistema = `${SISTEMA}\n\nResponda somente com o JSON pedido, em português. Campos: ${JSON.stringify(ESQUEMA.properties)}`;
  // Janela em degraus fixos: mudar num_ctx a cada conversa obriga o Ollama a recarregar o modelo
  // e a reler as instruções (iguais em todas). ~3 caracteres por token em português.
  const estimado = Math.ceil((sistema.length + conteudo.length) / 3) + 1024;
  const numCtx = estimado <= 8192 ? 8192 : estimado <= 16384 ? 16384 : 32768;
  const corpo = JSON.stringify({
    model: modelo,
    messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }],
    format: ESQUEMA,
    stream: true,
    think: false,
    keep_alive: '30m',
    options: { temperature: 0, num_ctx: numCtx, num_predict: 1024, ...(config.ia.threads ? { num_thread: config.ia.threads } : {}) },
  });
  // node:http em vez de fetch: o Ollama só envia os cabeçalhos após ler a conversa inteira,
  // o que num CPU passa de 5 min, e o fetch do Node desiste após 5 min sem cabeçalhos.
  let resp;
  try {
    resp = await new Promise((ok, falha) => {
      const req = http.request(`${config.ia.ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
      }, ok);
      req.setTimeout(30 * 60_000, () => req.destroy(new Error('sem resposta em 30 min')));
      req.on('error', falha);
      req.end(corpo);
    });
  } catch (e) {
    throw new Error(`Ollama não respondeu em ${config.ia.ollamaUrl} (${e.message}). Ele está rodando? Use ia-local.cmd`);
  }
  if (resp.statusCode !== 200) {
    let bruto = '';
    for await (const p of resp) bruto += p;
    const erro = (() => { try { return JSON.parse(bruto).error; } catch { return null; } })();
    throw new Error(`Ollama: ${erro ?? `HTTP ${resp.statusCode}`}${resp.statusCode === 404 ? ` — baixe o modelo com: ollama pull ${modelo}` : ''}`);
  }
  // Resposta em NDJSON: uma linha JSON por pedaço; a última traz done_reason.
  let texto = '';
  let final = {};
  let resto = '';
  const decodificador = new TextDecoder();
  for await (const pedaco of resp) {
    resto += decodificador.decode(pedaco, { stream: true });
    const linhas = resto.split('\n');
    resto = linhas.pop();
    for (const linha of linhas.filter(Boolean)) {
      const j = JSON.parse(linha);
      if (j.error) throw new Error(`Ollama: ${j.error}`);
      texto += j.message?.content ?? '';
      if (j.done) final = j;
    }
  }
  if (final.done_reason === 'length') throw new ErroIa('Resposta da IA cortada por limite de tokens');
  if (!texto.trim()) throw new ErroIa('A IA não devolveu conteúdo');
  return { texto, modelo: `ollama/${final.model ?? modelo}` };
}

// Cota esgotada ou chave inválida: vale para todos os chamados, então a fila para e retoma no
// próximo ciclo de sincronização (em vez de marcar falha em cada chamado).
export class ErroPararFila extends Error {}

// Groq (nuvem, plano gratuito): API no formato OpenAI. O processamento é todo lá; aqui é só
// uma chamada HTTP. Termos do Groq: não treina com os dados enviados; ligue "Zero Data
// Retention" em console.groq.com > Settings > Data Controls.
async function consultarGroq(conteudo, modelo, tentativa = 1) {
  if (!config.ia.groqChave) throw new ErroPararFila('Falta GROQ_API_KEY no .env (crie em console.groq.com > API Keys)');
  const sistema = `${SISTEMA}\n\nResponda somente com um objeto JSON, em português, com exatamente estes campos: ${JSON.stringify(ESQUEMA.properties)}`;
  let resp;
  try {
    resp = await fetch(`${config.ia.groqUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.ia.groqChave}` },
      body: JSON.stringify({
        model: modelo,
        messages: [{ role: 'system', content: sistema }, { role: 'user', content: conteudo }],
        // Saída estruturada pelo esquema: com json_object simples o gpt-oss copiava o esquema em vez de preenchê-lo.
        response_format: { type: 'json_schema', json_schema: { name: 'analise_atendimento', schema: ESQUEMA, strict: false } },
        temperature: 0,
        max_completion_tokens: 2048,
        // Modelos com raciocínio (gpt-oss): pouco raciocínio basta e economiza a cota diária.
        ...(modelo.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (e) {
    throw new Error(`Groq não respondeu (${e.message}). Verifique a internet.`);
  }
  if (resp.status === 429) {
    const espera = Number(resp.headers.get('retry-after')) || 0;
    // Limite por minuto: espera e tenta de novo. Limite diário: para a fila até o próximo ciclo.
    if (espera && espera <= 60 && tentativa <= 3) {
      await new Promise((ok) => setTimeout(ok, espera * 1000));
      return consultarGroq(conteudo, modelo, tentativa + 1);
    }
    throw new ErroPararFila(`Cota gratuita do Groq atingida; a fila retoma sozinha${espera ? ` em ~${Math.ceil(espera / 60)} min` : ' mais tarde'}`);
  }
  const json = await resp.json().catch(() => ({}));
  if (resp.status === 401) throw new ErroPararFila('Groq recusou a chave: confira GROQ_API_KEY no .env');
  if (!resp.ok) {
    const dica = resp.status === 404 ? ` — modelo "${modelo}" não existe no Groq; ajuste IA_MODELO` : '';
    throw new Error(`Groq: ${json.error?.message ?? `HTTP ${resp.status}`}${dica}`);
  }
  const escolha = json.choices?.[0];
  if (escolha?.finish_reason === 'length') throw new ErroIa('Resposta da IA cortada por limite de tokens');
  const texto = escolha?.message?.content;
  if (!texto?.trim()) throw new ErroIa('A IA não devolveu conteúdo');
  return { texto, modelo: `groq/${json.model ?? modelo}` };
}

const PROVEDORES = { anthropic: consultarAnthropic, groq: consultarGroq, ollama: consultarOllama };

// Consulta o modelo e devolve a análise já validada e normalizada.
export async function consultarModelo(conteudo, { provedor = config.ia.provedor, modelo = config.ia.modelo } = {}) {
  const inicio = Date.now();
  const consultar = PROVEDORES[provedor];
  if (!consultar) throw new Error(`IA_PROVEDOR desconhecido: ${provedor} (use groq, ollama ou anthropic)`);
  const { texto, modelo: usado } = await consultar(conteudo, modelo);
  let r;
  try { r = JSON.parse(texto); } catch { throw new ErroIa('A IA devolveu JSON inválido'); }
  return { analise: normalizar(r), modelo: usado, segundos: (Date.now() - inicio) / 1000 };
}

// Modelos menores às vezes escapam do intervalo ou inventam motivos: corrige aqui.
function normalizar(r) {
  const limitar = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
  if (!['positivo', 'neutro', 'negativo'].includes(r.sentimento)) throw new ErroIa(`Sentimento inválido: ${r.sentimento}`);
  const criterios = {};
  for (const k of ['cordialidade', 'clareza', 'resolucao', 'agilidade', 'procedimento']) criterios[k] = limitar(r.criterios?.[k], 10);
  return {
    sentimento: r.sentimento,
    intensidade: limitar(r.intensidade, 1),
    insatisfacao: Boolean(r.insatisfacao),
    motivos: [...new Set((r.motivos ?? []).filter((m) => MOTIVOS.includes(m)))],
    nota_qualidade: limitar(r.nota_qualidade, 10),
    criterios,
    resumo: String(r.resumo ?? '').trim(),
    pontos_melhoria: (r.pontos_melhoria ?? []).map(String).filter(Boolean).slice(0, 6),
    evidencias: (r.evidencias ?? []).filter((e) => e?.trecho).slice(0, 6),
    confianca: limitar(r.confianca, 1),
  };
}

export async function analisarChamado(chamadoId) {
  await transcreverChamado(chamadoId, { log: console.log });
  const entrada = prepararEntrada(chamadoId);
  if (entrada.erro) return registrarErro(chamadoId, entrada.erro);
  let resultado;
  try {
    resultado = await consultarModelo(entrada.conteudo);
  } catch (e) {
    if (e instanceof ErroIa) return registrarErro(chamadoId, e.message);
    throw e;
  }
  const { analise: r, modelo } = resultado;
  const limitar = (v, max) => Math.min(max, Math.max(0, Number(v) || 0));
  db.prepare(`INSERT INTO analises_ia (chamado_id, sentimento, intensidade, insatisfacao, motivos, nota_qualidade, criterios, resumo,
      pontos_melhoria, evidencias, confianca, modelo, versao_prompt, analisado_em, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente')
    ON CONFLICT(chamado_id) DO UPDATE SET sentimento = excluded.sentimento, intensidade = excluded.intensidade,
      insatisfacao = excluded.insatisfacao, motivos = excluded.motivos, nota_qualidade = excluded.nota_qualidade,
      criterios = excluded.criterios, resumo = excluded.resumo, pontos_melhoria = excluded.pontos_melhoria,
      evidencias = excluded.evidencias, confianca = excluded.confianca, modelo = excluded.modelo,
      versao_prompt = excluded.versao_prompt, analisado_em = excluded.analisado_em, status = 'pendente',
      revisado_por = NULL, revisado_em = NULL, sentimento_revisado = NULL, nota_revisada = NULL, observacao_revisao = NULL`)
    .run(chamadoId, r.sentimento, limitar(r.intensidade, 1), r.insatisfacao ? 1 : 0, JSON.stringify(r.motivos),
      limitar(r.nota_qualidade, 10), JSON.stringify(r.criterios), r.resumo, JSON.stringify(r.pontos_melhoria),
      JSON.stringify(r.evidencias), limitar(r.confianca, 1), modelo, VERSAO_PROMPT, agora());
  db.prepare('DELETE FROM erros_ia WHERE chamado_id = ?').run(chamadoId);
  return true;
}

function registrarErro(chamadoId, motivo) {
  db.prepare(`INSERT INTO erros_ia (chamado_id, quando, motivo) VALUES (?, ?, ?)
    ON CONFLICT(chamado_id) DO UPDATE SET quando = excluded.quando, motivo = excluded.motivo`).run(chamadoId, agora(), motivo);
  return false;
}

// Fila única de análises, separada da sincronização: num CPU cada conversa leva minutos,
// e a sincronização não pode esperar por isso. Pedidos feitos na tela passam na frente.
const pedidos = [];
let atual = null;
let rodando = null;

export const situacaoIa = (chamadoId) => (chamadoId === atual ? 'analisando' : pedidos.includes(chamadoId) ? 'na_fila' : null);

export function pedirAnalise(chamadoId) {
  if (atual !== chamadoId && !pedidos.includes(chamadoId)) pedidos.push(chamadoId);
  rodarFila({ automatica: false }).catch((e) => console.error('IA:', e.message));
}

// Sem retroativo: só chamados encerrados depois que a análise automática foi ligada (data
// gravada no banco na primeira vez). Com conversa, ainda sem análise; erros são tentados de
// novo após 1 dia. Na ordem em que foram encerrados.
function filaAutomatica(limite) {
  const ontem = new Date(Date.now() - 86400_000).toISOString();
  let desde = lerEstado('ia_analisar_desde');
  if (!desde) gravarEstado('ia_analisar_desde', (desde = agora()));
  return db.prepare(`
    SELECT c.id FROM chamados c
    JOIN departamentos d ON d.id = c.departamento_id AND d.monitorado = 1
    LEFT JOIN analises_ia a ON a.chamado_id = c.id
    LEFT JOIN erros_ia e ON e.chamado_id = c.id
    WHERE c.aberto = 0 AND c.msgs_cliente > 0 AND c.encerrado_em >= ? AND a.chamado_id IS NULL
      AND (e.chamado_id IS NULL OR e.quando < ?)
    ORDER BY c.encerrado_em ASC LIMIT ?`).all(desde, ontem, limite).map((r) => r.id);
}

async function analisarComTratamento(id, log) {
  try {
    return await analisarChamado(id);
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Chave da Anthropic inválida: confira ANTHROPIC_API_KEY no .env');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Limite de uso da IA atingido; o restante fica para o próximo ciclo.');
    if (e instanceof ErroPararFila) throw e;
    log(`IA: falha no chamado ${id}: ${e.message}`);
    return registrarErro(id, e instanceof Anthropic.APIError ? `Erro da API de IA (HTTP ${e.status}): ${e.message}` : e.message);
  }
}

// Se a fila já está rodando, devolve a execução em andamento (os pedidos novos entram nela).
export function rodarFila({ automatica = true, limite = config.ia.maxPorCiclo, log = console.log } = {}) {
  if (!config.ia.habilitada) return Promise.resolve(0);
  if (rodando) return rodando;
  rodando = (async () => {
    const auto = automatica ? filaAutomatica(limite) : [];
    let feitas = 0;
    let total = 0;
    try {
      while (pedidos.length || auto.length) {
        const manual = pedidos.length > 0;
        const id = manual ? pedidos.shift() : auto.shift();
        if (!manual && db.prepare('SELECT 1 FROM analises_ia WHERE chamado_id = ?').get(id)) continue;
        atual = id;
        total++;
        if (await analisarComTratamento(id, log)) feitas++;
      }
    } catch (e) {
      log(`IA: ${e.message}`);
    }
    if (total) log(`IA: ${feitas} de ${total} conversa(s) analisada(s).`);
    return feitas;
  })().finally(() => { rodando = null; atual = null; });
  return rodando;
}

export const analisarPendentes = (opcoes) => rodarFila({ automatica: true, ...opcoes });

if (process.argv[1]?.replace(/\\/g, '/').endsWith('src/ia.mjs')) {
  const limite = Number(process.argv.find((a) => a.startsWith('--limite='))?.split('=')[1] ?? config.ia.maxPorCiclo);
  analisarPendentes({ limite }).then(() => process.exit(0)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
}
