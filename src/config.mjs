// Configuração lida do arquivo .env (sem dependências) com valores padrão seguros.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function carregarEnv() {
  const arquivo = path.join(RAIZ, '.env');
  if (!existsSync(arquivo)) return;
  for (const linha of readFileSync(arquivo, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
carregarEnv();

const env = (nome, padrao = '') => (process.env[nome] ?? padrao).trim();
const lista = (nome) => env(nome).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  porta: Number(env('PORTA', '4250')),
  // Por padrão só aceita conexões da própria máquina; para a rede interna use 0.0.0.0.
  host: env('HOST', '127.0.0.1'),
  arquivoBanco: path.resolve(RAIZ, env('ARQUIVO_BANCO', 'dados/tek-ponto.db')),

  digisac: {
    url: env('DIGISAC_URL').replace(/\/+$/, ''),
    // Token pessoal (Digisac > Configurações > Tokens) ou, na falta dele, login OAuth.
    token: env('DIGISAC_TOKEN'),
    email: env('DIGISAC_EMAIL'),
    senha: env('DIGISAC_SENHA'),
    // Nomes ou IDs dos departamentos do Suporte de Ponto. Vazio = todos.
    departamentos: lista('DIGISAC_DEPARTAMENTOS'),
    diasIniciais: Number(env('DIGISAC_DIAS_INICIAIS', '90')),
    intervaloMinutos: Number(env('SINCRONIZAR_A_CADA_MINUTOS', '2')),
  },

  ia: {
    habilitada: env('IA_HABILITADA', 'sim') === 'sim',
    // 'groq' = nuvem, plano gratuito; 'ollama' = modelo aberto nesta máquina; 'anthropic' = Claude (pago).
    provedor: env('IA_PROVEDOR', 'groq'),
    groqUrl: env('GROQ_URL', 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    groqChave: env('GROQ_API_KEY'),
    // Áudios e vídeos viram texto (Whisper no Groq) antes da análise, para a IA saber o que foi falado.
    transcreverMidia: env('IA_TRANSCREVER_MIDIA', 'sim') === 'sim',
    modeloTranscricao: env('IA_MODELO_TRANSCRICAO', 'whisper-large-v3-turbo'),
    ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    modelo: env('IA_MODELO') || { anthropic: 'claude-opus-5-5', ollama: 'qwen3:14b' }[env('IA_PROVEDOR', 'groq')] || 'openai/gpt-oss-120b',
    esforco: env('IA_ESFORCO', 'low'),
    analisarAutomaticamente: env('IA_ANALISAR_AUTOMATICAMENTE', 'sim') === 'sim',
    maxPorCiclo: Number(env('IA_MAX_POR_CICLO', '50')),
    // Núcleos usados pelo Ollama (vazio = automático). Neste notebook 10 rende ~15% a mais.
    threads: Number(env('IA_THREADS', '0')) || null,
  },

  // Base Bruno: banco do sistema de gestão das outras áreas, que recebe as ligações da GoTo.
  // O arquivo mais recente da pasta é reimportado sozinho quando muda.
  baseGoto: {
    pasta: path.resolve(RAIZ, env('BASE_GOTO_PASTA', 'C:/Projetos/Base Bruno')),
    fila: env('BASE_GOTO_FILA', 'Ponto Eletrônico'),
  },

  sessaoHoras: Number(env('SESSAO_HORAS', '10')),
  // Dias que as mensagens ficam guardadas localmente (LGPD: minimização). 0 = sem limite.
  retencaoMensagensDias: Number(env('RETENCAO_MENSAGENS_DIAS', '365')),
};

export const digisacConfigurado = () =>
  Boolean(config.digisac.url && (config.digisac.token || (config.digisac.email && config.digisac.senha)));
