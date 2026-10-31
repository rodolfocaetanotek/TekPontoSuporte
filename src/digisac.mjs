// Cliente da API Digisac (https://documenter.getpostman.com/view/24605757/2sA3BhfaDg).
// Autenticação: token pessoal (Bearer) ou POST /api/v1/oauth/token (grant password).
// Listagens aceitam ?query={JSON no formato Sequelize} com page/perPage.
import { config } from './config.mjs';

const ESPERA_MAX_MS = 60_000;
let tokenOauth = null;

async function obterToken(renovar = false) {
  if (config.digisac.token) return config.digisac.token;
  if (tokenOauth && !renovar) return tokenOauth;
  const resp = await fetch(`${config.digisac.url}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'password',
      client_id: 'api',
      client_secret: 'secret',
      username: config.digisac.email,
      password: config.digisac.senha,
    }),
  });
  if (!resp.ok) throw new ErroDigisac(`Falha no login OAuth do Digisac (HTTP ${resp.status})`, resp.status);
  const json = await resp.json();
  tokenOauth = json.access_token;
  if (!tokenOauth) throw new ErroDigisac('O Digisac não devolveu access_token no login OAuth', 0);
  return tokenOauth;
}

export class ErroDigisac extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export async function get(caminho, params = {}, tentativa = 1) {
  const url = new URL(`${config.digisac.url}/api/v1/${caminho.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${await obterToken(tentativa > 1)}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  }).catch((e) => {
    if (tentativa < 4) return null;
    throw new ErroDigisac(`Sem conexão com o Digisac: ${e.message}`, 0);
  });

  if (!resp || resp.status === 429 || resp.status >= 500) {
    if (tentativa >= 4) throw new ErroDigisac(`Digisac indisponível em ${caminho} (HTTP ${resp?.status ?? 'rede'})`, resp?.status ?? 0);
    const retry = Number(resp?.headers.get('retry-after')) * 1000;
    await dormir(Math.min(retry || 2000 * 2 ** tentativa, ESPERA_MAX_MS));
    return get(caminho, params, tentativa + 1);
  }
  if (resp.status === 401 && !config.digisac.token && tentativa === 1) {
    return get(caminho, params, 2); // token OAuth vencido: renova uma vez
  }
  if (!resp.ok) {
    const corpo = (await resp.text()).slice(0, 300);
    const dica = resp.status === 401 || resp.status === 403
      ? ' — verifique DIGISAC_TOKEN (ou e-mail/senha) no .env e se o usuário tem permissão de administrador'
      : '';
    throw new ErroDigisac(`Digisac respondeu HTTP ${resp.status} em ${caminho}${dica}. ${corpo}`, resp.status);
  }
  return resp.json();
}

// Normaliza as duas formas de resposta paginada vistas no Digisac:
// { data: [...], total, currentPage, lastPage } ou um array puro.
function lerPagina(resposta) {
  if (Array.isArray(resposta)) return { itens: resposta, ultima: null };
  const itens = resposta.data ?? resposta.rows ?? resposta.items ?? [];
  const ultima = resposta.lastPage ?? (resposta.total != null && resposta.limit ? Math.ceil(resposta.total / resposta.limit) : null);
  return { itens, ultima };
}

// Percorre todas as páginas de uma listagem.
export async function* paginar(caminho, query = {}, porPagina = 100) {
  for (let pagina = 1; ; pagina++) {
    const resp = await get(caminho, { query: { ...query, page: pagina, perPage: porPagina } });
    const { itens, ultima } = lerPagina(resp);
    for (const item of itens) yield item;
    if (itens.length < porPagina || (ultima != null && pagina >= ultima)) return;
  }
}

export const listarUsuarios = () => paginar('users', { order: [['name', 'ASC']] });
export const listarDepartamentos = () => paginar('departments', { order: [['name', 'ASC']] });

// Chamados alterados desde `desde`, com contato, assunto e transferências.
export function listarChamados(desde) {
  return paginar('tickets', {
    where: { updatedAt: { $gte: desde } },
    order: [['updatedAt', 'ASC']],
    include: [
      { model: 'contact', attributes: ['id', 'name', 'alternativeName', 'internalName', 'data', 'personId'],
        include: [{ model: 'person', attributes: ['id', 'name'] }] },
      { model: 'ticketTopics', attributes: ['id', 'name'] },
      { model: 'ticketTransfers', attributes: ['id', 'action', 'createdAt'] },
    ],
  });
}

export function listarMensagens(chamadoId) {
  return paginar('messages', {
    where: { ticketId: chamadoId },
    order: [['timestamp', 'ASC']],
    attributes: ['id', 'type', 'text', 'timestamp', 'isFromMe', 'isFromBot', 'userId', 'ticketId', 'origin', 'visible', 'isComment', 'data'],
  }, 200);
}

export function listarAvaliacoes(desde) {
  return paginar('answers', {
    where: { createdAt: { $gte: desde } },
    order: [['createdAt', 'ASC']],
  });
}

// Estatística oficial do Digisac para o período, usada na conferência dos indicadores.
export function estatisticasGerais(de, ate, departamentoId = 'all') {
  return get('dashboard/general', {
    startPeriod: de, endPeriod: ate, grouping: '', departmentId: departamentoId, userId: 'all',
    periodType: 'openDate', departmentParticipation: 'last', userParticipation: 'last', status: 'all',
  });
}

// Arquivo (áudio, vídeo...) de uma mensagem: o link é assinado e expira, por isso é buscado na hora.
export async function arquivoDaMensagem(mensagemId) {
  const r = await get('messages', { query: { where: { id: mensagemId }, include: ['file'], limit: 1 } });
  return (r.data ?? r)[0]?.file ?? null;
}
