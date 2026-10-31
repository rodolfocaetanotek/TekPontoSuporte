// Interface do Tek Ponto - Suporte Gestão (SPA sem framework).
// Atenção à CSP: nada de atributo style="" em HTML gerado; estilos dinâmicos vão por elemento.style.
import { registrarGestao } from './gestao.js';

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];
const pagina = $('#pagina');

const estado = {
  usuario: null,
  status: null,
  filtrosDisponiveis: { tecnicos: [], departamentos: [], motivos: [] },
  filtro: { de: diaIso(-29), ate: diaIso(0), tecnico: '', departamento: '' },
  graficos: [],
};

// --- Utilidades ---------------------------------------------------------------

function diaIso(deslocamento) {
  const d = new Date(Date.now() + deslocamento * 86400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const num = (v, casas = 0) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }));

function duracao(seg) {
  if (seg == null) return '—';
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${String(min % 60).padStart(2, '0')}min` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

const dataHora = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const pct = (a, b) => (b ? `${num((a / b) * 100, 0)}%` : '—');
const MOTIVO = {
  demora_na_resposta: 'Demora na resposta', problema_nao_resolvido: 'Problema não resolvido', reincidencia: 'Reincidência',
  comunicacao_do_tecnico: 'Comunicação do técnico', excesso_de_transferencias: 'Excesso de transferências',
  falha_no_sistema_de_ponto: 'Falha no sistema de ponto', questao_comercial: 'Questão comercial', outro: 'Outro',
};
const CRITERIO = { cordialidade: 'Cordialidade', clareza: 'Clareza', resolucao: 'Resolução', agilidade: 'Agilidade', procedimento: 'Procedimento' };
const STATUS_IA = { pendente: 'Aguardando revisão', aprovada: 'Aprovada', ajustada: 'Ajustada', descartada: 'Descartada' };
const ehGestor = () => ['admin', 'coordenador'].includes(estado.usuario?.perfil);
const ehAdmin = () => estado.usuario?.perfil === 'admin';

async function api(caminho, opcoes = {}) {
  const resp = await fetch(caminho, {
    ...opcoes,
    headers: opcoes.body ? { 'Content-Type': 'application/json' } : {},
    body: opcoes.body ? JSON.stringify(opcoes.body) : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  if (resp.status === 401 && caminho !== '/api/entrar') { mostrarLogin(); throw new Error(dados.erro ?? 'Sessão expirada'); }
  if (resp.status === 403 && estado.usuario?.deve_trocar_senha) { exigirTrocaDeSenha(); throw new Error(dados.erro); }
  if (!resp.ok) throw new Error(dados.erro ?? `Erro ${resp.status}`);
  return dados;
}

function aviso(texto, erro = false) {
  const el = document.createElement('div');
  el.className = `toast${erro ? ' erro' : ''}`;
  el.textContent = texto;
  document.body.append(el);
  setTimeout(() => el.remove(), 4500);
}

function consultaFiltro(extra = {}) {
  const f = { ...estado.filtro, ...extra };
  return new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '' && v != null)).toString();
}

function destruirGraficos() {
  estado.graficos.forEach((g) => g.destroy());
  estado.graficos = [];
}

function aplicarLarguras(raiz = pagina) {
  $$('[data-largura]', raiz).forEach((el) => { el.style.width = `${el.dataset.largura}%`; });
}

function barraFiltros({ periodo = true, tecnico = true, departamento = true, extra = '' } = {}) {
  const tecnicos = estado.filtrosDisponiveis.tecnicos;
  const deps = estado.filtrosDisponiveis.departamentos;
  return `<form class="filtros" id="filtros">
    ${periodo ? `<label>De<input type="date" name="de" value="${estado.filtro.de}"></label>
    <label>Até<input type="date" name="ate" value="${estado.filtro.ate}"></label>` : ''}
    ${tecnico && estado.usuario.perfil !== 'tecnico' ? `<label>Técnico<select name="tecnico"><option value="">Todos</option>
      ${tecnicos.map((t) => `<option value="${esc(t.id)}" ${t.id === estado.filtro.tecnico ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>` : ''}
    ${departamento && deps.length > 1 ? seletorDepartamentos(deps) : ''}
    ${extra}
    <button class="botao primario">Aplicar</button>
  </form>`;
}

// Vários departamentos: caixas de marcar dentro de um <details>; nenhuma marcada = todos.
// Lista todos os departamentos do Digisac. Os monitorados (com dados) vêm marcados quando o
// filtro está em "todos"; os demais aparecem à parte e, se escolhidos, passam a ser sincronizados.
function seletorDepartamentos(deps) {
  const monitorados = deps.filter((d) => d.monitorado);
  const outros = deps.filter((d) => !d.monitorado);
  const marcados = estado.filtro.departamento.split(',').filter(Boolean);
  const efetivos = marcados.length ? marcados : monitorados.map((d) => d.id);
  const resumo = !marcados.length ? `Todos os monitorados (${monitorados.length})`
    : marcados.length === 1 ? deps.find((d) => d.id === marcados[0])?.nome ?? '1 selecionado' : `${marcados.length} selecionados`;
  const opcao = (d) => `<label class="opcao"><input type="checkbox" name="departamento" value="${esc(d.id)}" ${efetivos.includes(d.id) ? 'checked' : ''}>${esc(d.nome)}</label>`;
  return `<div class="campo-multi"><span class="rotulo-campo">Departamentos</span><details class="multi"><summary>${esc(resumo)}</summary><div class="multi-opcoes">
    ${monitorados.map(opcao).join('')}
    ${outros.length ? `<p class="multi-grupo">Outros departamentos do Digisac<br><small>ainda sem dados; ao aplicar, você pode começar a sincronizá-los</small></p>${outros.map(opcao).join('')}` : ''}
  </div></details></div>`;
}

// Departamentos escolhidos no filtro que ainda não são sincronizados: pergunta se deve passar a
// sincronizá-los (vira a mesma seleção de Sincronização e conferência > Departamentos monitorados).
function confirmarNovosDepartamentos(novos) {
  const deps = estado.filtrosDisponiveis.departamentos;
  return new Promise((resolver) => {
    abrirDialogo(`<h2>Começar a sincronizar?</h2>
      <p>Estes departamentos ainda não têm dados no painel:</p>
      <ul>${novos.map((id) => `<li>${esc(deps.find((d) => d.id === id)?.nome ?? id)}</li>`).join('')}</ul>
      <p class="nota">Eles passam a ser sincronizados com o Digisac (histórico dos últimos 90 dias, alguns minutos),
        entram nos indicadores de "todos os monitorados" e os novos atendimentos deles também são analisados pela IA.</p>`,
    async () => {
      const ids = [...deps.filter((d) => d.monitorado).map((d) => d.id), ...novos];
      await api('/api/departamentos', { method: 'POST', body: { ids } });
      await api('/api/sincronizar', { method: 'POST', body: {} }).catch(() => {});
      estado.filtrosDisponiveis = await api('/api/filtros');
      aviso('Sincronização iniciada; os dados aparecem em alguns minutos.');
      resolver(true);
    });
    $('#dialogo').addEventListener('close', () => resolver(false), { once: true });
  });
}

function ligarFiltros(aoAplicar) {
  $('#filtros')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const dados = Object.fromEntries(form);
    if ($('#filtros .multi')) {
      const deps = estado.filtrosDisponiveis.departamentos;
      const escolhidos = form.getAll('departamento');
      const novos = escolhidos.filter((id) => !deps.find((d) => d.id === id)?.monitorado);
      if (novos.length && !(await confirmarNovosDepartamentos(novos))) return;
      // Todos os monitorados marcados = "todos" (assim um departamento ativado depois entra sozinho).
      const monitorados = estado.filtrosDisponiveis.departamentos.filter((d) => d.monitorado).map((d) => d.id);
      const todos = escolhidos.length === monitorados.length && monitorados.every((id) => escolhidos.includes(id));
      dados.departamento = todos ? '' : escolhidos.join(',');
    }
    for (const k of ['de', 'ate', 'tecnico', 'departamento']) if (k in dados) estado.filtro[k] = dados[k];
    aoAplicar(dados);
  });
}

// --- Sessão -------------------------------------------------------------------

function mostrarLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#form-login [name=email]').focus();
}

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = Object.fromEntries(new FormData(e.target));
  try {
    const r = await api('/api/entrar', { method: 'POST', body: dados });
    estado.usuario = r.usuario;
    e.target.reset();
    $('#erro-login').textContent = '';
    await iniciarApp();
  } catch (err) {
    $('#erro-login').textContent = err.message;
  }
});

$('#botao-sair').addEventListener('click', async () => {
  await api('/api/sair', { method: 'POST', body: {} }).catch(() => {});
  estado.usuario = null;
  mostrarLogin();
});

$('#botao-senha').addEventListener('click', () => {
  abrirDialogo(`<h2>Trocar minha senha</h2>
    <label>Senha atual<input type="password" name="atual" required autocomplete="current-password"></label>
    <label>Nova senha (mín. 10 caracteres)<input type="password" name="nova" required minlength="10" autocomplete="new-password"></label>`,
  async (dados) => {
    await api('/api/minha-senha', { method: 'POST', body: dados });
    aviso('Senha alterada.');
  });
});

function abrirDialogo(html, aoConfirmar) {
  const dialogo = $('#dialogo');
  const form = $('#dialogo-form');
  form.innerHTML = `${html}<p class="erro" id="erro-dialogo"></p>
    <div class="acoes"><button class="botao primario" value="ok">Salvar</button><button class="botao" value="cancelar" formnovalidate>Cancelar</button></div>`;
  form.onsubmit = async (e) => {
    if (e.submitter?.value === 'cancelar') return;
    e.preventDefault();
    try {
      await aoConfirmar(Object.fromEntries(new FormData(form)), form);
      dialogo.close();
    } catch (err) {
      $('#erro-dialogo').textContent = err.message;
    }
  };
  dialogo.showModal();
}

async function atualizarStatus() {
  try {
    estado.status = await api('/api/status');
  } catch { return; }
  const s = estado.status;
  $('#faixa-demo').hidden = !s.demonstracao;
  const ult = s.ultimaExecucao;
  let html;
  if (!s.digisacConfigurado) html = '<span class="bolinha parado"></span>Digisac não configurado';
  else if (s.sincronizando) html = '<span class="bolinha"></span>Sincronizando agora...';
  else if (ult?.status === 'erro') html = `<span class="bolinha erro"></span>Última sincronização falhou<br>${esc(dataHora(ult.inicio))}`;
  else html = `<span class="bolinha"></span>Atualizado em ${esc(dataHora(s.ultimaSincronizacao))}`;
  $('#estado-sync').innerHTML = html;
  const contador = $('#contador-revisao');
  contador.hidden = !ehGestor() || !s.pendentesRevisao;
  contador.textContent = s.pendentesRevisao;
}

// Senha provisória (acesso criado pela coordenação): antes de qualquer tela, a pessoa cria a
// própria senha. O servidor também bloqueia tudo até a troca; aqui não há como fechar a janela.
function exigirTrocaDeSenha() {
  const dialogo = $('#dialogo');
  const form = $('#dialogo-form');
  $('#login').hidden = true;
  form.innerHTML = `<h2>Crie sua senha</h2>
    <p>Olá, ${esc(estado.usuario.nome)}! Você entrou com uma senha provisória. Para continuar, crie uma senha só sua.</p>
    <label>Senha provisória<input type="password" name="atual" required autocomplete="current-password"></label>
    <label>Nova senha (mín. 10 caracteres)<input type="password" name="nova" required minlength="10" autocomplete="new-password"></label>
    <label>Repita a nova senha<input type="password" name="confirmar" required minlength="10" autocomplete="new-password"></label>
    <p class="erro" id="erro-dialogo"></p>
    <div class="acoes"><button class="botao primario">Salvar e entrar</button><button class="botao" type="button" id="troca-sair">Sair</button></div>`;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form));
    if (d.nova !== d.confirmar) { $('#erro-dialogo').textContent = 'As duas senhas novas não são iguais'; return; }
    try {
      await api('/api/minha-senha', { method: 'POST', body: { atual: d.atual, nova: d.nova } });
      estado.usuario.deve_trocar_senha = false;
      dialogo.close();
      aviso('Senha criada. Bem-vindo(a)!');
      await iniciarApp();
    } catch (err) { $('#erro-dialogo').textContent = err.message; }
  };
  $('#troca-sair').addEventListener('click', async () => {
    await api('/api/sair', { method: 'POST' }).catch(() => {});
    estado.usuario = null;
    dialogo.close();
    mostrarLogin();
  });
  if (!dialogo.open) dialogo.showModal();
  $('[name=atual]', form).focus();
}
$('#dialogo').addEventListener('cancel', (e) => { if (estado.usuario?.deve_trocar_senha) e.preventDefault(); });

// Menu do técnico: só os próprios dados, com nomes no singular.
const MENU_TECNICO = { individual: 'Meu dashboard', conversas: 'Minhas conversas', calendario: 'Meu calendário' };

async function iniciarApp() {
  if (estado.usuario.deve_trocar_senha) { exigirTrocaDeSenha(); return; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#nome-usuario').textContent = `${estado.usuario.nome} · `;
  $$('#menu [data-perfil]').forEach((a) => {
    a.hidden = a.dataset.perfil === 'admin' ? !ehAdmin() : !ehGestor();
  });
  $$('#menu a[data-pagina]').forEach((a) => {
    a.dataset.rotulo ??= a.firstChild.textContent.trim();
    a.firstChild.textContent = (!ehGestor() && MENU_TECNICO[a.dataset.pagina]) || a.dataset.rotulo;
  });
  estado.filtrosDisponiveis = await api('/api/filtros');
  await atualizarStatus();
  rotear();
}

// --- Roteamento ---------------------------------------------------------------

const paginas = {};

function rotear() {
  if (!estado.usuario) return;
  const [, nome = ehGestor() ? 'painel' : 'individual', param] = location.hash.split('/');
  $$('#menu a').forEach((a) => a.classList.toggle('ativo', a.dataset.pagina === (nome === 'conversa' ? 'conversas' : nome)));
  destruirGraficos();
  const fn = paginas[nome] ?? (ehGestor() ? paginas.painel : paginas.individual);
  pagina.innerHTML = '<p class="vazio">Carregando...</p>';
  fn(param ? decodeURIComponent(param) : undefined).catch((e) => {
    pagina.innerHTML = `<div class="cartao"><p class="erro">${esc(e.message)}</p></div>`;
  });
}
window.addEventListener('hashchange', rotear);

// --- Gráficos -----------------------------------------------------------------

const COR = { laranja: '#D64000', verde: '#1F9D55', verdeClaro: '#8FD3A8', cinza: '#9AA1A8', vermelho: '#C62828' };

function grafico(canvas, config) {
  if (!window.Chart) return;
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  Chart.defaults.color = '#6B7075';
  const g = new Chart(canvas, { ...config, options: { responsive: true, maintainAspectRatio: false, ...config.options } });
  estado.graficos.push(g);
}

function mapaDeCalor(porHora) {
  const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const max = Math.max(1, ...porHora.map((x) => x.chamados));
  const idx = new Map(porHora.map((x) => [`${x.dia_semana}-${x.hora}`, x.chamados]));
  let html = '<div class="calor"><div></div>';
  for (let h = 0; h < 24; h++) html += `<div>${h % 3 === 0 ? h : ''}</div>`;
  for (const d of [1, 2, 3, 4, 5, 6, 0]) {
    html += `<div>${dias[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const n = idx.get(`${d}-${h}`) ?? 0;
      html += `<div class="celula" data-intensidade="${n / max}" title="${dias[d]} ${h}h: ${n} chamado(s)"></div>`;
    }
  }
  return `${html}</div>`;
}

function pintarCalor() {
  $$('.calor .celula').forEach((el) => {
    const i = Number(el.dataset.intensidade);
    if (i > 0) el.style.background = `rgba(214, 64, 0, ${0.12 + i * 0.88})`;
  });
}

// --- Painel -------------------------------------------------------------------

function kpis(r) {
  const neg = r.sentimento.negativo ?? 0;
  return `<div class="grade-kpi">
    <div class="kpi"><div class="rotulo">Chamados</div><div class="valor">${num(r.chamados)}</div><div class="detalhe">${num(r.encerrados)} encerrados · ${num(r.abertos)} em aberto</div></div>
    <div class="kpi"><div class="rotulo">1ª resposta (TME)</div><div class="valor">${duracao(r.primeira_resposta_media_seg)}</div><div class="detalhe">mediana ${duracao(r.primeira_resposta_mediana_seg)}</div></div>
    <div class="kpi"><div class="rotulo">Duração do atendimento (TMA)</div><div class="valor">${duracao(r.duracao_media_seg)}</div><div class="detalhe">mediana ${duracao(r.duracao_mediana_seg)}</div></div>
    <div class="kpi verde"><div class="rotulo">Satisfação dos clientes (CSAT)</div><div class="valor">${num(r.csat_medio, 2)}</div><div class="detalhe">${num(r.csat_respostas)} resposta(s) de clientes${r.csat_ia_digisac != null ? ` · IA Digisac ${num(r.csat_ia_digisac, 2)}` : ''}</div></div>
    <div class="kpi verde"><div class="rotulo">Qualidade (IA revisada)</div><div class="valor">${num(r.nota_qualidade_media, 1)}</div><div class="detalhe">${num(r.analises_revisadas)} análise(s) revisada(s)</div></div>
    <div class="kpi ${neg ? 'alerta' : 'verde'}"><div class="rotulo">Sentimento negativo</div><div class="valor">${pct(neg, r.analises_revisadas)}</div><div class="detalhe">${num(neg)} de ${num(r.analises_revisadas)} revisadas</div></div>
    ${ehGestor() ? `<div class="kpi ${r.sinais_insatisfacao ? 'alerta' : 'verde'}"><div class="rotulo">Sinais de insatisfação (IA)</div><div class="valor">${num(r.sinais_insatisfacao)}</div><div class="detalhe">${num(r.analises_pendentes)} aguardando revisão</div></div>` : ''}
  </div>`;
}

function kpisVoz(v) {
  if (!v) return '';
  const s = (x) => (x == null ? '—' : x < 60 ? `${Math.round(x)} s` : duracao(x));
  return `<h2 class="titulo-secao">Voz · fila Ponto Eletrônico (GoTo)</h2><div class="grade-kpi">
    <div class="kpi verde"><div class="rotulo">Ligações atendidas</div><div class="valor">${num(v.ligacoes)}</div><div class="detalhe"><a href="#/voz">ver GoTo/Voz</a></div></div>
    <div class="kpi verde"><div class="rotulo">Espera na fila (TME)</div><div class="valor">${s(v.espera_media_seg)}</div><div class="detalhe">mediana ${s(v.espera_mediana_seg)}</div></div>
    <div class="kpi ${v.nivel_servico != null && v.nivel_servico < 0.8 ? 'alerta' : 'verde'}"><div class="rotulo">Nível de serviço</div><div class="valor">${v.nivel_servico == null ? '—' : `${num(v.nivel_servico * 100)}%`}</div><div class="detalhe">atendidas em até ${v.nivel_servico_seg} s</div></div>
    <div class="kpi verde"><div class="rotulo">Duração (TMA)</div><div class="valor">${s(v.tma_medio_seg)}</div><div class="detalhe">mediana ${s(v.tma_mediano_seg)}</div></div>
  </div>`;
}

paginas.painel = async () => {
  if (!ehGestor()) { location.hash = '#/individual'; return; }
  const p = await api(`/api/painel?${consultaFiltro()}`);
  const r = p.resumo;
  pagina.innerHTML = `
    <div class="cabecalho"><div><h1>Dashboard Geral</h1><p>Chat (Digisac, pela data de abertura do chamado) e voz (fila do Ponto na GoTo) no período selecionado.</p></div>${barraFiltros()}</div>
    ${kpis(r)}
    ${kpisVoz(p.voz)}
    <div class="grade-2">
      <div class="cartao"><h2>Chamados por dia</h2><div class="grafico"><canvas id="g-dia"></canvas></div></div>
      <div class="cartao"><h2>Sentimento dos clientes</h2><div class="grafico"><canvas id="g-sent"></canvas></div>
        <p class="nota">Só conta análises da IA revisadas pela coordenação.</p></div>
    </div>
    <div class="grade-2-iguais">
      <div class="cartao"><h2>Quando os clientes chamam</h2>${mapaDeCalor(p.porHora)}<p class="nota">Horário de Brasília, pela abertura do chamado.</p></div>
      <div class="cartao"><h2>Assuntos mais frequentes</h2><div class="grafico"><canvas id="g-assunto"></canvas></div></div>
    </div>
    <div class="grade-2">
      <div class="cartao"><h2>Desempenho por técnico</h2>${tabelaTecnicos(p.tecnicos, r)}</div>
      <div class="cartao"><h2>Motivos de insatisfação</h2>${p.motivosInsatisfacao.length
    ? `<table>${p.motivosInsatisfacao.map((m) => `<tr><td>${esc(MOTIVO[m.motivo] ?? m.motivo)}</td><td class="num">${num(m.n)}</td></tr>`).join('')}</table>`
    : '<p class="vazio">Nenhum motivo registrado em análises revisadas.</p>'}</div>
    </div>`;
  ligarFiltros(() => rotear());
  aplicarLarguras();
  pintarCalor();
  ligarTabelaTecnicos();

  grafico($('#g-dia'), {
    type: 'bar',
    data: {
      labels: p.porDia.map((d) => d.dia.split('-').reverse().slice(0, 2).join('/')),
      datasets: [
        { label: 'Abertos no dia', data: p.porDia.map((d) => d.chamados), backgroundColor: COR.laranja, borderRadius: 3 },
        { label: 'Já encerrados', data: p.porDia.map((d) => d.encerrados), backgroundColor: COR.verdeClaro, borderRadius: 3 },
      ],
    },
    options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  const s = r.sentimento;
  grafico($('#g-sent'), {
    type: 'doughnut',
    data: { labels: ['Positivo', 'Neutro', 'Negativo'], datasets: [{ data: [s.positivo, s.neutro, s.negativo], backgroundColor: [COR.verde, COR.cinza, COR.vermelho] }] },
    options: { cutout: '62%', plugins: { legend: { position: 'bottom' } } },
  });
  grafico($('#g-assunto'), {
    type: 'bar',
    data: { labels: p.assuntos.map((a) => (a.assunto.length > 34 ? `${a.assunto.slice(0, 33)}…` : a.assunto)), datasets: [{ label: 'Chamados', data: p.assuntos.map((a) => a.chamados), backgroundColor: COR.verde, borderRadius: 3 }] },
    options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } } },
  });
};

function tabelaTecnicos(tecnicos, total) {
  if (!tecnicos.length) return '<p class="vazio">Sem chamados no período.</p>';
  const max = Math.max(...tecnicos.map((t) => t.chamados));
  return `<div class="tabela-envolve"><table>
    <thead><tr><th>Técnico</th><th class="num">Chamados</th><th></th><th class="num">1ª resposta</th><th class="num">TMA</th><th class="num">CSAT</th><th class="num">Qualidade</th><th class="num">Negativos</th></tr></thead>
    <tbody>${tecnicos.map((t) => `<tr class="clicavel" data-tecnico="${esc(t.id ?? '')}">
      <td>${esc(t.nome)}</td><td class="num">${num(t.chamados)}</td>
      <td><div class="barra"><span data-largura="${(t.chamados / max) * 100}"></span></div></td>
      <td class="num">${duracao(t.primeira_resposta_media_seg)}</td><td class="num">${duracao(t.duracao_media_seg)}</td>
      <td class="num">${num(t.csat_medio, 2)}</td><td class="num">${num(t.nota_qualidade_media, 1)}</td>
      <td class="num">${t.analises_revisadas ? `${num(t.sentimento.negativo)} (${pct(t.sentimento.negativo, t.analises_revisadas)})` : '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="nota">Participação no total: ${num(total.chamados)} chamados. Clique em um técnico para ver os detalhes.</p>`;
}

function ligarTabelaTecnicos() {
  $$('tr[data-tecnico]').forEach((tr) => tr.addEventListener('click', () => {
    if (!tr.dataset.tecnico) return;
    location.hash = `#/individual/${encodeURIComponent(tr.dataset.tecnico)}`;
  }));
}

// --- Técnicos -----------------------------------------------------------------

// Endereços antigos: a lista virou o Dashboard Técnicos e a página do técnico, o Dashboard Individual.
paginas.tecnicos = async (id) => { location.hash = id ? `#/individual/${encodeURIComponent(id)}` : (ehGestor() ? '#/dash-tecnicos' : '#/individual'); };

// Comparação só de chat (antiga tela Técnicos); continua acessível em #/tecnicos-chat.
paginas['tecnicos-chat'] = async (id) => {
  if (estado.usuario.perfil === 'tecnico') id = estado.usuario.tecnico_id;
  if (!id) {
    const p = await api(`/api/painel?${consultaFiltro({ tecnico: '' })}`);
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Produtividade da equipe</h1><p>Compare os técnicos no período. Indicadores de IA só contam análises revisadas.</p></div>
      <div class="filtros">${barraFiltros({ tecnico: false })}${ehGestor() ? '<a class="botao" id="exportar" href="#">Exportar CSV</a>' : ''}</div></div>
      <div class="cartao">${tabelaTecnicos(p.tecnicos, p.resumo)}</div>
      <div class="cartao" id="cartao-g-comp"><h2>Volume e qualidade por técnico</h2><div class="grafico"><canvas id="g-comp"></canvas></div></div>`;
    ligarFiltros(() => rotear());
    aplicarLarguras();
    ligarTabelaTecnicos();
    $('#exportar')?.addEventListener('click', (e) => { e.preventDefault(); location.href = `/api/exportar.csv?${consultaFiltro({ tecnico: '' })}`; });
    $('#cartao-g-comp').classList.add('grade-espaco');
    const t = p.tecnicos.filter((x) => x.id);
    grafico($('#g-comp'), {
      type: 'bar',
      data: {
        labels: t.map((x) => x.nome),
        datasets: [
          { label: 'Chamados', data: t.map((x) => x.chamados), backgroundColor: COR.laranja, yAxisID: 'y', borderRadius: 3 },
          { label: 'Qualidade (0-10)', data: t.map((x) => x.nota_qualidade_media), backgroundColor: COR.verde, yAxisID: 'y2', borderRadius: 3 },
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, position: 'left' }, y2: { beginAtZero: true, max: 10, position: 'right', grid: { display: false } } } },
    });
    return;
  }

  const p = await api(`/api/painel?${consultaFiltro({ tecnico: id })}`);
  const nome = p.tecnicos[0]?.nome ?? estado.filtrosDisponiveis.tecnicos.find((t) => t.id === id)?.nome ?? 'Técnico';
  pagina.innerHTML = `<div class="cabecalho"><div>${estado.usuario.perfil === 'tecnico' ? '' : '<a href="#/tecnicos">← Equipe</a>'}<h1>${esc(nome)}</h1>
      <p>Indicadores individuais no período.</p></div>${barraFiltros({ tecnico: false })}</div>
    ${kpis(p.resumo)}
    <div class="grade-2">
      <div class="cartao"><h2>Atendimentos por dia</h2><div class="grafico"><canvas id="g-dia"></canvas></div></div>
      <div class="cartao"><h2>Motivos de insatisfação</h2>${p.motivosInsatisfacao.length
    ? `<table>${p.motivosInsatisfacao.map((m) => `<tr><td>${esc(MOTIVO[m.motivo] ?? m.motivo)}</td><td class="num">${num(m.n)}</td></tr>`).join('')}</table>`
    : '<p class="vazio">Nenhum motivo registrado.</p>'}</div>
    </div>
    <div class="cartao"><h2>Atendimentos</h2><div id="lista-tecnico"></div></div>`;
  ligarFiltros(() => rotear());
  grafico($('#g-dia'), {
    type: 'line',
    data: { labels: p.porDia.map((d) => d.dia.split('-').reverse().slice(0, 2).join('/')), datasets: [{ label: 'Chamados', data: p.porDia.map((d) => d.chamados), borderColor: COR.laranja, backgroundColor: 'rgba(214,64,0,.12)', fill: true, tension: 0.3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  await listaChamados($('#lista-tecnico'), { tecnico: id });
};

// --- Conversas ----------------------------------------------------------------

async function listaChamados(alvo, extra = {}, paginaAtual = 1) {
  const r = await api(`/api/chamados?${consultaFiltro({ ...extra, pagina: paginaAtual })}`);
  if (!r.itens.length) { alvo.innerHTML = '<p class="vazio">Nenhum atendimento encontrado.</p>'; return; }
  const totalPaginas = Math.ceil(r.total / r.porPagina);
  alvo.innerHTML = `<div class="tabela-envolve"><table>
    <thead><tr><th>Protocolo</th><th>Início</th><th>Cliente</th><th>Técnico</th><th>Assunto</th><th class="num">1ª resposta</th><th class="num">Duração</th><th>Sentimento</th></tr></thead>
    <tbody>${r.itens.map((c) => `<tr class="clicavel" data-id="${esc(c.id)}">
      <td>${esc(c.protocolo ?? '—')} ${c.aberto ? '<span class="etiqueta aberto">aberto</span>' : ''}</td>
      <td>${dataHora(c.iniciado_em)}</td><td>${esc(c.contato ?? '—')}<br><small>${esc(c.empresa ?? '')}</small></td>
      <td>${esc(c.tecnico ?? '—')}</td><td>${esc(c.assunto ?? '—')}</td>
      <td class="num">${duracao(c.primeira_resposta_seg)}</td><td class="num">${duracao(c.duracao_seg)}</td>
      <td>${c.sentimento ? `<span class="etiqueta ${esc(c.sentimento)}">${esc(c.sentimento)}</span>` : ''}
        ${c.status_ia === 'pendente' ? '<span class="etiqueta pendente">a revisar</span>' : ''}
        ${c.insatisfacao ? '<span class="etiqueta negativo">insatisfação</span>' : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="paginacao">${num(r.total)} atendimento(s) · página ${paginaAtual} de ${totalPaginas}
      <button class="botao" data-ir="${paginaAtual - 1}" ${paginaAtual <= 1 ? 'disabled' : ''}>Anterior</button>
      <button class="botao" data-ir="${paginaAtual + 1}" ${paginaAtual >= totalPaginas ? 'disabled' : ''}>Próxima</button></div>`;
  $$('tr[data-id]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/conversa/${encodeURIComponent(tr.dataset.id)}`; }));
  $$('[data-ir]', alvo).forEach((b) => b.addEventListener('click', () => listaChamados(alvo, extra, Number(b.dataset.ir))));
}

paginas.conversas = async () => {
  const extra = `<label>Busca<input name="busca" placeholder="protocolo, cliente, texto..." value="${esc(estado.busca ?? '')}"></label>
    <label>Situação<select name="situacao"><option value="">Todos</option><option value="encerrados">Encerrados</option><option value="abertos">Em aberto</option></select></label>
    <label>Sentimento<select name="sentimento"><option value="">Todos</option><option value="positivo">Positivo</option><option value="neutro">Neutro</option><option value="negativo">Negativo</option></select></label>
    ${ehGestor() ? '<label>Insatisfação<select name="insatisfacao"><option value="">Todos</option><option value="1">Com sinal (IA)</option></select></label>' : ''}`;
  pagina.innerHTML = `<div class="cabecalho"><div><h1>Conversas</h1><p>Histórico dos atendimentos sincronizados do Digisac. Cada abertura de conversa fica registrada na auditoria.</p></div></div>
    <div class="cartao">${barraFiltros({ extra })}<div id="lista" class="grade-espaco"></div></div>`;
  const filtrosExtras = {};
  ligarFiltros((dados) => {
    estado.busca = dados.busca;
    for (const k of ['busca', 'situacao', 'sentimento', 'insatisfacao']) filtrosExtras[k] = dados[k] ?? '';
    listaChamados($('#lista'), filtrosExtras);
  });
  if (estado.busca) filtrosExtras.busca = estado.busca;
  await listaChamados($('#lista'), filtrosExtras);
};

const AUTOR = { cliente: 'Cliente', tecnico: 'Técnico', bot: 'Robô', comentario: 'Comentário interno', sistema: 'Sistema' };

// Áudio/vídeo transcrito pela IA aparece dentro do balão, marcado como transcrição automática.
function transcricaoDaMensagem(m) {
  if (m.transcricao) return `<div class="transcricao"><span>Transcrição automática</span>${esc(m.transcricao)}</div>`;
  if (m.transcricao_erro) return `<div class="transcricao falhou"><span>Sem transcrição</span>${esc(m.transcricao_erro)}</div>`;
  return '';
}

// Áudio, vídeo e imagem tocam/aparecem no próprio balão; o arquivo vem do Digisac só quando a
// pessoa dá play ou rola até a imagem (preload="none" / loading="lazy").
function midiaDaMensagem(m) {
  const src = `/api/mensagens/${encodeURIComponent(m.id)}/midia`;
  if (m.tipo === 'ptt' || m.tipo === 'audio') return `<audio class="midia" controls preload="none" src="${src}"></audio>`;
  if (m.tipo === 'video') return `<video class="midia" controls preload="none" src="${src}"></video>`;
  if (m.tipo === 'image' || m.tipo === 'sticker') {
    return `<a href="${src}" target="_blank" rel="noopener"><img class="midia" loading="lazy" src="${src}" alt="Imagem enviada na conversa"></a>`;
  }
  if (m.tipo === 'document') return `<a class="midia-documento" href="${src}">Baixar documento</a>`;
  return '';
}

// Para mídia, o texto guardado costuma ser só o marcador ("[áudio]"); com o player ele é dispensável.
const ROTULOS_DE_MIDIA = new Set(['[áudio]', '[vídeo]', '[imagem]', '[figurinha]', '[documento]']);
function textoDaMensagem(m) {
  const midia = midiaDaMensagem(m);
  return `${midia && ROTULOS_DE_MIDIA.has(m.texto) ? '' : esc(m.texto)}${midia}`;
}

paginas.conversa = async (id) => {
  const { chamado: c, mensagens, analise, erroIa, avaliacoes, situacaoIa } = await api(`/api/chamados/${encodeURIComponent(id)}`);
  pagina.innerHTML = `<div class="cabecalho"><div><a href="#/conversas">← Conversas</a><h1>Protocolo ${esc(c.protocolo ?? c.id)}</h1>
      <p>${esc(c.contato ?? 'Cliente')}${c.empresa ? ` · ${esc(c.empresa)}` : ''} · ${esc(c.departamento ?? '')}</p></div></div>
    <div class="conversa-layout">
      <div class="cartao"><h2>Conversa</h2>
        <div class="chat">${mensagens.length ? mensagens.map((m) => `<div class="balao ${esc(m.autor)}">
          <small>${esc(m.autor === 'tecnico' ? m.tecnico ?? 'Técnico' : AUTOR[m.autor])} · ${dataHora(m.quando)}</small>${textoDaMensagem(m)}${transcricaoDaMensagem(m)}</div>`).join('')
    : '<p class="vazio">Mensagens não disponíveis (ainda não sincronizadas ou removidas pela política de retenção).</p>'}</div>
      </div>
      <div>
        <div class="cartao"><h2>Dados do atendimento</h2><dl class="ficha">
          <dt>Técnico</dt><dd>${esc(c.tecnico ?? '—')}</dd>
          <dt>Situação</dt><dd>${c.aberto ? '<span class="etiqueta aberto">em aberto</span>' : 'Encerrado'}</dd>
          <dt>Início</dt><dd>${dataHora(c.iniciado_em)}</dd><dt>Fim</dt><dd>${dataHora(c.encerrado_em)}</dd>
          <dt>1ª resposta</dt><dd>${duracao(c.primeira_resposta_seg)}</dd><dt>Duração</dt><dd>${duracao(c.duracao_seg)}</dd>
          <dt>Assunto</dt><dd>${esc(c.assunto ?? '—')}</dd><dt>Transferências</dt><dd>${num(c.transferencias)}</dd>
          <dt>Mensagens</dt><dd>${num(c.msgs_cliente)} do cliente · ${num(c.msgs_tecnico)} do técnico · ${num(c.msgs_bot)} do robô</dd>
          <dt>Pesquisa</dt><dd>${avaliacoes.some((a) => a.origem === 'cliente') ? avaliacoes.filter((a) => a.origem === 'cliente').map((a) => `${esc((a.tipo ?? 'nota').toUpperCase())} ${num(a.nota, 0)}${a.comentario ? ` — “${esc(a.comentario)}”` : ''}`).join('<br>') : 'Cliente não respondeu'}</dd>
          ${avaliacoes.filter((a) => a.origem === 'ia_digisac').map((a) => `<dt>IA do Digisac</dt><dd>${esc((a.tipo ?? '').toUpperCase())} ${a.nota == null ? 'sem nota' : num(a.nota, 0)}${a.texto_ia ? `<br><small>${esc(a.texto_ia)}</small>` : ''}</dd>`).join('')}
        </dl></div>
        <div class="cartao grade-espaco" id="painel-ia">${painelIa(c, analise, erroIa, situacaoIa)}</div>
      </div>
    </div>`;
  ligarPainelIa(c.id, analise, situacaoIa);
  const chat = $('.chat');
  chat.scrollTop = chat.scrollHeight;
};

const SITUACAO_IA = {
  analisando: 'Analisando agora... Esta área atualiza sozinha.',
  na_fila: 'Na fila da IA: será a próxima a ser analisada. Esta área atualiza sozinha.',
};

function painelIa(c, a, erroIa, situacao) {
  if (situacao && ehGestor()) {
    return `<h2>Análise da IA</h2><p class="aviso-ia"><span class="girando"></span> ${SITUACAO_IA[situacao]}</p>`;
  }
  if (!a) {
    if (!ehGestor()) return '<h2>Avaliação de qualidade</h2><p class="vazio">Ainda não há avaliação revisada para este atendimento.</p>';
    const iaLigada = estado.status?.iaHabilitada;
    return `<h2>Análise da IA</h2>
      ${erroIa ? `<p class="erro">Última tentativa: ${esc(erroIa.motivo)}</p>` : ''}
      <p class="vazio">${!iaLigada ? 'A IA está desligada (IA_HABILITADA no arquivo .env).'
        : c.aberto ? 'A análise roda quando o chamado for encerrado.' : 'Ainda não analisado.'}</p>
      ${!c.aberto && iaLigada ? '<div class="acoes"><button class="botao primario" id="analisar">Analisar agora</button></div>' : ''}`;
  }
  const sentimentoValido = a.sentimento_revisado ?? a.sentimento;
  const nota = a.nota_revisada ?? a.nota_qualidade;
  const criterios = Object.entries(a.criterios ?? {});
  return `<h2>${ehGestor() ? 'Análise da IA' : 'Avaliação de qualidade'} <span class="etiqueta ${esc(a.status)}">${esc(STATUS_IA[a.status])}</span></h2>
    ${a.status === 'pendente' ? '<div class="aviso-ia">Sugestão automática. Não conta nos indicadores até ser revisada pela coordenação.</div>' : ''}
    <dl class="ficha">
      <dt>Sentimento</dt><dd><span class="etiqueta ${esc(sentimentoValido)}">${esc(sentimentoValido)}</span>${a.sentimento_revisado && a.sentimento_revisado !== a.sentimento ? ` <small>(IA: ${esc(a.sentimento)})</small>` : ''}</dd>
      <dt>Nota</dt><dd><strong>${num(nota, 1)}</strong> / 10${a.nota_revisada != null && a.nota_revisada !== a.nota_qualidade ? ` <small>(IA: ${num(a.nota_qualidade, 1)})</small>` : ''}</dd>
      ${ehGestor() ? `<dt>Insatisfação</dt><dd>${a.insatisfacao ? '<span class="etiqueta negativo">sim</span>' : 'não'}</dd>
      <dt>Confiança</dt><dd>${pct(a.confianca, 1)}</dd>` : ''}
      ${a.motivos?.length ? `<dt>Motivos</dt><dd>${a.motivos.map((m) => esc(MOTIVO[m] ?? m)).join(', ')}</dd>` : ''}
    </dl>
    <p>${esc(a.resumo)}</p>
    <div class="criterios">${criterios.map(([k, v]) => `<div class="criterio"><span>${esc(CRITERIO[k] ?? k)}</span>
      <div class="barra"><span data-largura="${Number(v) * 10}"></span></div><span class="num">${num(v)}</span></div>`).join('')}</div>
    ${a.pontos_melhoria?.length ? `<h2>Pontos de melhoria</h2><ul>${a.pontos_melhoria.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
    ${ehGestor() && a.evidencias?.length ? `<h2>Evidências</h2>${a.evidencias.map((e) => `<div class="evidencia"><q>${esc(e.trecho)}</q><br><small>${esc(e.justificativa)}</small></div>`).join('')}` : ''}
    ${a.observacao_revisao ? `<p class="nota"><strong>Revisão:</strong> ${esc(a.observacao_revisao)}</p>` : ''}
    <p class="nota">${a.revisor ? `Revisado por ${esc(a.revisor)} em ${dataHora(a.revisado_em)} · ` : ''}${ehGestor() ? `Modelo ${esc(a.modelo)} · prompt ${esc(a.versao_prompt)} · ${dataHora(a.analisado_em)}` : ''}</p>
    ${ehGestor() ? (a.status === 'pendente'
    ? `<div class="acoes"><button class="botao verde" data-decisao="aprovada">Aprovar</button><button class="botao" data-decisao="ajustada">Ajustar...</button>
        <button class="botao perigo" data-decisao="descartada">Descartar...</button><button class="botao" id="analisar">Reanalisar</button></div>`
    : '<div class="acoes"><button class="botao" data-decisao="reabrir">Reabrir revisão</button></div>') : ''}`;
}

// Enquanto a análise está na fila, consulta o chamado a cada 3 s e redesenha só o painel da IA
// (a conversa não é recarregada, para não perder a posição de leitura).
function acompanharAnalise(chamadoId) {
  const hash = location.hash;
  setTimeout(async () => {
    if (location.hash !== hash || !$('#painel-ia')) return;
    try {
      const { chamado, analise, erroIa, situacaoIa } = await api(`/api/chamados/${encodeURIComponent(chamadoId)}`);
      if (location.hash !== hash) return;
      $('#painel-ia').innerHTML = painelIa(chamado, analise, erroIa, situacaoIa);
      ligarPainelIa(chamadoId, analise, situacaoIa);
      if (!situacaoIa) aviso(analise ? 'Análise da IA concluída.' : 'A análise da IA falhou; veja o motivo no painel.', !analise);
    } catch {
      acompanharAnalise(chamadoId);
    }
  }, 3_000);
}

function ligarPainelIa(chamadoId, analise, situacao) {
  aplicarLarguras($('#painel-ia'));
  if (situacao) acompanharAnalise(chamadoId);
  $('#analisar')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Enviando...';
    try {
      const { situacao: nova } = await api(`/api/chamados/${encodeURIComponent(chamadoId)}/analisar`, { method: 'POST', body: {} });
      $('#painel-ia').innerHTML = `<h2>Análise da IA</h2><p class="aviso-ia"><span class="girando"></span> ${SITUACAO_IA[nova ?? 'na_fila']}</p>`;
      acompanharAnalise(chamadoId);
    } catch (err) {
      aviso(err.message, true);
      e.target.disabled = false;
      e.target.textContent = 'Tentar de novo';
    }
  });
  $$('[data-decisao]').forEach((b) => b.addEventListener('click', () => revisar(chamadoId, b.dataset.decisao, analise, rotear)));
}

async function revisar(chamadoId, decisao, analise, depois) {
  const enviar = async (corpo) => {
    await api(`/api/analises/${encodeURIComponent(chamadoId)}/revisar`, { method: 'POST', body: { decisao, ...corpo } });
    aviso('Revisão registrada.');
    await atualizarStatus();
    depois();
  };
  if (decisao === 'aprovada' || decisao === 'reabrir') return enviar({}).catch((e) => aviso(e.message, true));
  if (decisao === 'descartada') {
    return abrirDialogo(`<h2>Descartar análise</h2><p>A análise deixa de contar nos indicadores e nos sinais de insatisfação.</p>
      <label>Motivo (obrigatório)<textarea name="observacao" required></textarea></label>`, enviar);
  }
  abrirDialogo(`<h2>Ajustar análise</h2>
    <label>Sentimento<select name="sentimento">${['positivo', 'neutro', 'negativo'].map((s) => `<option ${s === analise?.sentimento ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
    <label>Nota de qualidade (0 a 10)<input type="number" name="nota" min="0" max="10" step="0.5" value="${analise?.nota_qualidade ?? ''}"></label>
    <label>O que foi ajustado e por quê (obrigatório)<textarea name="observacao" required></textarea></label>`, enviar);
}

// --- Revisão da IA ------------------------------------------------------------

paginas.revisao = async () => {
  if (!ehGestor()) { location.hash = '#/painel'; return; }
  const status = estado.statusRevisao ?? 'pendente';
  const { itens, placar } = await api(`/api/revisao?status=${status}`);
  pagina.innerHTML = `<div class="cabecalho"><div><h1>Revisão das análises da IA</h1>
      <p>A IA sugere; a coordenação decide. Só análises aprovadas ou ajustadas entram nos indicadores. Insatisfação e baixa confiança aparecem primeiro.</p></div>
      <div class="filtros"><label>Mostrar<select id="status-revisao">${Object.entries(STATUS_IA).map(([k, v]) => `<option value="${k}" ${k === status ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div></div>
    ${placar.length ? `<div class="cartao grade-espaco-baixo"><h2>Assertividade por modelo</h2><div class="tabela-envolve"><table>
      <thead><tr><th>Modelo</th><th class="num">Revisadas</th><th class="num">Aprovadas sem ajuste</th><th class="num">Ajustadas</th><th class="num">Descartadas</th></tr></thead>
      <tbody>${placar.map((p) => `<tr><td><code>${esc(p.modelo)}</code></td><td class="num">${num(p.revisadas)}</td>
        <td class="num">${num(p.aprovadas)} (${pct(p.aprovadas, p.revisadas)})</td><td class="num">${num(p.ajustadas)}</td><td class="num">${num(p.descartadas)}</td></tr>`).join('')}</tbody></table></div>
      <p class="nota">Quanto maior a aprovação sem ajuste, mais o modelo concorda com a coordenação.</p></div>` : ''}
    <div class="cartao">${itens.length && status === 'pendente' ? `<div class="barra-lote"><span id="qtd-selecionadas">Nenhuma selecionada</span>
        <button class="botao verde" id="aprovar-lote" disabled>Aprovar selecionadas</button></div>` : ''}
      ${itens.length ? `<div class="tabela-envolve"><table>
      <thead><tr>${status === 'pendente' ? '<th class="marcar"><input type="checkbox" id="marcar-todas" aria-label="Selecionar todas"></th>' : ''}<th>Protocolo</th><th>Técnico</th><th>Sentimento</th><th class="num">Nota</th><th class="num">Confiança</th><th>Resumo</th>${status === 'pendente' ? '<th></th>' : '<th>Revisado em</th>'}</tr></thead>
      <tbody>${itens.map((a) => `<tr data-id="${esc(a.chamado_id)}">
        ${status === 'pendente' ? `<td class="marcar"><input type="checkbox" class="marcar-analise" value="${esc(a.chamado_id)}" aria-label="Selecionar ${esc(a.protocolo ?? '')}"></td>` : ''}
        <td><a href="#/conversa/${encodeURIComponent(a.chamado_id)}">${esc(a.protocolo ?? a.chamado_id)}</a><br><small>${dataHora(a.iniciado_em)}</small></td>
        <td>${esc(a.tecnico ?? '—')}</td>
        <td><span class="etiqueta ${esc(a.sentimento_revisado ?? a.sentimento)}">${esc(a.sentimento_revisado ?? a.sentimento)}</span>${a.insatisfacao ? ' <span class="etiqueta negativo">insatisfação</span>' : ''}</td>
        <td class="num">${num(a.nota_revisada ?? a.nota_qualidade, 1)}</td><td class="num">${pct(a.confianca, 1)}</td>
        <td>${esc(a.resumo)}</td>
        ${status === 'pendente' ? `<td><div class="acoes"><button class="botao verde" data-decisao="aprovada">Aprovar</button><a class="botao" href="#/conversa/${encodeURIComponent(a.chamado_id)}">Abrir</a></div></td>` : `<td>${dataHora(a.revisado_em)}</td>`}
      </tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Nada por aqui.</p>'}
      <p class="nota">Para ajustar ou descartar, abra a conversa e leia o contexto completo antes de decidir.</p></div>`;
  $('#status-revisao').addEventListener('change', (e) => { estado.statusRevisao = e.target.value; rotear(); });
  $$('[data-decisao]').forEach((b) => b.addEventListener('click', () => revisar(b.closest('tr').dataset.id, 'aprovada', null, rotear)));
  ligarSelecaoEmLote();
};

// Seleção múltipla: marcar uma a uma ou todas pelo cabeçalho, e aprovar de uma vez (com confirmação).
function ligarSelecaoEmLote() {
  const todas = $('#marcar-todas');
  if (!todas) return;
  const caixas = $$('.marcar-analise');
  const selecionadas = () => caixas.filter((c) => c.checked).map((c) => c.value);
  const atualizar = () => {
    const n = selecionadas().length;
    $('#qtd-selecionadas').textContent = n ? `${n} de ${caixas.length} selecionada(s)` : 'Nenhuma selecionada';
    $('#aprovar-lote').disabled = !n;
    $('#aprovar-lote').textContent = n ? `Aprovar ${n} selecionada(s)` : 'Aprovar selecionadas';
    todas.checked = n === caixas.length;
    todas.indeterminate = n > 0 && n < caixas.length;
    caixas.forEach((c) => c.closest('tr').classList.toggle('selecionada', c.checked));
  };
  todas.addEventListener('change', () => { caixas.forEach((c) => { c.checked = todas.checked; }); atualizar(); });
  caixas.forEach((c) => c.addEventListener('change', atualizar));
  $('#aprovar-lote').addEventListener('click', () => {
    const ids = selecionadas();
    abrirDialogo(`<h2>Aprovar ${ids.length} análise(s)?</h2>
      <p>As análises aprovadas passam a contar nos indicadores como a IA sugeriu. Cada aprovação fica registrada na auditoria em seu nome.</p>
      <p class="nota">Para ajustar ou descartar, desmarque a análise e abra a conversa.</p>`, async () => {
      const r = await api('/api/analises/aprovar-lote', { method: 'POST', body: { ids } });
      aviso(`${r.aprovadas} análise(s) aprovada(s).${r.ignoradas ? ` ${r.ignoradas} já tinham sido revisadas.` : ''}`);
      await atualizarStatus();
      rotear();
    });
  });
}

// --- Sincronização e conferência ---------------------------------------------

paginas.sincronizacao = async () => {
  if (!ehGestor()) { location.hash = '#/painel'; return; }
  await atualizarStatus();
  const s = estado.status;
  const { itens } = await api('/api/execucoes');
  pagina.innerHTML = `<div class="cabecalho"><div><h1>Sincronização e conferência</h1><p>Integração com a API do Digisac e validação dos indicadores.</p></div></div>
    <div class="grade-2-iguais">
      <div class="cartao"><h2>Integração Digisac</h2>
        <dl class="ficha"><dt>Situação</dt><dd>${s.digisacConfigurado ? '<span class="etiqueta ok">configurado</span>' : '<span class="etiqueta erro">não configurado</span> — preencha o .env'}</dd>
          <dt>Frequência</dt><dd>a cada ${num(s.intervaloMinutos)} min</dd><dt>Última</dt><dd>${dataHora(s.ultimaSincronizacao)}</dd>
          <dt>IA</dt><dd>${s.iaHabilitada ? `ativa (${esc(s.modeloIa)})` : 'desativada'}</dd>
          <dt>Retenção</dt><dd>${s.retencaoDias ? `texto das conversas guardado por ${num(s.retencaoDias)} dias` : 'sem limite'}</dd></dl>
        <div class="acoes"><button class="botao primario" id="sync" ${s.digisacConfigurado && !s.sincronizando ? '' : 'disabled'}>Sincronizar agora</button>
          <button class="botao" id="sync-completo" ${s.digisacConfigurado && !s.sincronizando ? '' : 'disabled'}>Ressincronizar período inicial</button></div>
      </div>
      <div class="cartao"><h2>Conferir indicadores com o Digisac</h2>
        <p class="nota">Compara nossos números com a estatística oficial (<code>/dashboard/general</code>) no mesmo período. Diferenças apontam chamados não sincronizados ou regras de cálculo diferentes.</p>
        <form class="filtros" id="form-conferir"><label>De<input type="date" name="de" value="${estado.filtro.de}"></label><label>Até<input type="date" name="ate" value="${estado.filtro.ate}"></label><button class="botao primario">Conferir</button></form>
        <div id="resultado-conferencia"></div>
      </div>
    </div>
    <div class="cartao grade-espaco-baixo"><h2>Departamentos monitorados</h2>
      <p class="nota">Só os chamados destes departamentos são sincronizados e entram nos indicadores. Ao incluir um departamento, a próxima sincronização busca o histórico inicial dele.</p>
      <form id="form-deps"><div id="lista-deps" class="lista-deps"><p class="vazio">Carregando...</p></div>
        <p class="erro" id="erro-deps"></p>
        <div class="acoes"><button class="botao primario">Salvar seleção</button><button class="botao" type="button" id="atualizar-deps">Atualizar lista do Digisac</button></div></form>
    </div>
    <div class="cartao"><h2>Histórico de sincronizações</h2>${itens.length ? `<div class="tabela-envolve"><table>
      <thead><tr><th>Início</th><th>Fim</th><th>Situação</th><th class="num">Chamados</th><th class="num">Mensagens</th><th class="num">Avaliações</th><th class="num">Análises IA</th><th>Erro</th></tr></thead>
      <tbody>${itens.map((e) => `<tr><td>${dataHora(e.inicio)}</td><td>${dataHora(e.fim)}</td><td><span class="etiqueta ${esc(e.status)}">${esc(e.status)}</span></td>
        <td class="num">${num(e.chamados)}</td><td class="num">${num(e.mensagens)}</td><td class="num">${num(e.avaliacoes)}</td><td class="num">${num(e.analises)}</td><td>${esc(e.erro ?? '')}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="vazio">Nenhuma sincronização ainda.</p>'}</div>`;

  const carregarDeps = async (atualizar) => {
    const { itens } = await api(`/api/departamentos${atualizar ? '?atualizar=1' : ''}`);
    $('#lista-deps').innerHTML = itens.length
      ? itens.map((d) => `<label class="opcao"><input type="checkbox" name="ids" value="${esc(d.id)}" ${d.monitorado ? 'checked' : ''}>
          ${esc(d.nome)} <small>${d.chamados ? `${num(d.chamados)} chamado(s)` : ''}</small></label>`).join('')
      : '<p class="vazio">Nenhum departamento carregado. Clique em "Atualizar lista do Digisac".</p>';
  };
  carregarDeps(false).catch((e) => { $('#lista-deps').innerHTML = `<p class="erro">${esc(e.message)}</p>`; });
  $('#atualizar-deps').addEventListener('click', () => carregarDeps(true).then(() => aviso('Lista atualizada.')).catch((e) => aviso(e.message, true)));
  $('#form-deps').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/departamentos', { method: 'POST', body: { ids: new FormData(e.target).getAll('ids') } });
      estado.filtro.departamento = '';
      estado.filtrosDisponiveis = await api('/api/filtros');
      aviso('Seleção salva. Clique em "Sincronizar agora" para buscar os chamados.');
      $('#erro-deps').textContent = '';
    } catch (err) { $('#erro-deps').textContent = err.message; }
  });

  const disparar = async (completo) => {
    try {
      await api('/api/sincronizar', { method: 'POST', body: { completo } });
      aviso('Sincronização iniciada. Acompanhe no rodapé do menu.');
      setTimeout(rotear, 1500);
    } catch (e) { aviso(e.message, true); }
  };
  $('#sync').addEventListener('click', () => disparar(false));
  $('#sync-completo').addEventListener('click', () => disparar(true));
  $('#form-conferir').addEventListener('submit', async (e) => {
    e.preventDefault();
    const alvo = $('#resultado-conferencia');
    alvo.innerHTML = '<p class="vazio">Consultando o Digisac...</p>';
    try {
      const r = await api('/api/conferir', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      alvo.innerHTML = tabelaConferencia(r);
    } catch (err) { alvo.innerHTML = `<p class="erro">${esc(err.message)}</p>`; }
  });
};

// A resposta de /dashboard/general não tem formato documentado: mostramos nossos
// números lado a lado com todos os campos numéricos que o Digisac devolver.
function tabelaConferencia({ local, digisac }) {
  const planos = {};
  const achatar = (obj, prefixo = '') => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) achatar(v, `${prefixo}${k}.`);
      else if (typeof v === 'number') planos[`${prefixo}${k}`] = v;
    }
  };
  achatar(digisac);
  return `<table><thead><tr><th>Nosso indicador</th><th class="num">Valor</th></tr></thead><tbody>
      <tr><td>Chamados abertos no período</td><td class="num">${num(local.chamados)}</td></tr>
      <tr><td>Encerrados</td><td class="num">${num(local.encerrados)}</td></tr>
      <tr><td>Em aberto</td><td class="num">${num(local.abertos)}</td></tr>
      <tr><td>1ª resposta média</td><td class="num">${duracao(local.primeira_resposta_media_seg)}</td></tr>
      <tr><td>Duração média</td><td class="num">${duracao(local.duracao_media_seg)}</td></tr></tbody></table>
    <h2 class="grade-espaco">Números do Digisac</h2>
    ${!digisac ? '<p class="vazio">Digisac não configurado.</p>' : digisac.erro ? `<p class="erro">${esc(digisac.erro)}</p>`
    : Object.keys(planos).length ? `<table><tbody>${Object.entries(planos).map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td class="num">${num(v, Number.isInteger(v) ? 0 : 2)}</td></tr>`).join('')}</tbody></table>`
      : `<pre>${esc(JSON.stringify(digisac, null, 2).slice(0, 3000))}</pre>`}
    <p class="nota">Compare as contagens com a linha "Soma dos departamentos". Tempos do Digisac estão em segundos e as médias dele
      dividem pelo total de chamados (inclusive os abertos); as nossas consideram só os encerrados (duração) e só chamados iniciados
      pelo cliente (1ª resposta). A conferência fica registrada na auditoria.</p>`;
}

// --- Usuários (admin) ---------------------------------------------------------

paginas.usuarios = async () => {
  if (!ehAdmin()) { location.hash = '#/painel'; return; }
  const { itens, tecnicos } = await api('/api/usuarios');
  const PERFIL = { admin: 'Administrador', coordenador: 'Coordenação', tecnico: 'Técnico' };
  pagina.innerHTML = `<div class="cabecalho"><div><h1>Usuários do painel</h1><p>Técnicos veem apenas os próprios atendimentos e só as avaliações já revisadas.</p></div>
      <button class="botao primario" id="novo">Novo usuário</button></div>
    <div class="cartao"><div class="tabela-envolve"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Técnico Digisac</th><th>Situação</th><th></th></tr></thead>
      <tbody>${itens.map((u) => `<tr><td>${esc(u.nome)}</td><td>${esc(u.email)}</td><td>${esc(PERFIL[u.perfil])}</td>
        <td>${esc(tecnicos.find((t) => t.id === u.tecnico_id)?.nome ?? '—')}</td><td>${u.ativo ? 'Ativo' : 'Inativo'}</td>
        <td><button class="link" data-editar="${u.id}">Editar</button></td></tr>`).join('')}</tbody></table></div></div>`;

  const formulario = (u = {}) => abrirDialogo(`<h2>${u.id ? 'Editar' : 'Novo'} usuário</h2>
    <label>Nome<input name="nome" required value="${esc(u.nome ?? '')}"></label>
    <label>E-mail<input name="email" type="email" required value="${esc(u.email ?? '')}"></label>
    <label>Perfil<select name="perfil">${Object.entries(PERFIL).map(([k, v]) => `<option value="${k}" ${k === u.perfil ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Técnico no Digisac (obrigatório para perfil Técnico)<select name="tecnico_id"><option value="">—</option>
      ${tecnicos.map((t) => `<option value="${esc(t.id)}" ${t.id === u.tecnico_id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
    <label>${u.id ? 'Nova senha (deixe em branco para manter)' : 'Senha inicial (mín. 10 caracteres)'}<input name="senha" type="password" autocomplete="new-password" ${u.id ? '' : 'required minlength="10"'}></label>
    ${u.id ? `<label>Situação<select name="ativo"><option value="sim" ${u.ativo ? 'selected' : ''}>Ativo</option><option value="nao" ${u.ativo ? '' : 'selected'}>Inativo</option></select></label>` : ''}`,
  async (dados) => {
    await api('/api/usuarios', { method: 'POST', body: { ...dados, id: u.id, ativo: dados.ativo !== 'nao' } });
    aviso('Usuário salvo.');
    rotear();
  });
  $('#novo').addEventListener('click', () => formulario());
  $$('[data-editar]').forEach((b) => b.addEventListener('click', () => formulario(itens.find((u) => u.id === Number(b.dataset.editar)))));
};

// --- Auditoria (admin) --------------------------------------------------------

paginas.auditoria = async () => {
  if (!ehAdmin()) { location.hash = '#/painel'; return; }
  const { itens } = await api('/api/auditoria');
  pagina.innerHTML = `<div class="cabecalho"><div><h1>Auditoria</h1><p>Últimos 300 eventos: acessos, leituras de conversa, revisões da IA, exportações e alterações de usuários.</p></div></div>
    <div class="cartao"><div class="tabela-envolve"><table><thead><tr><th>Quando</th><th>Usuário</th><th>Ação</th><th>Alvo</th><th>Detalhe</th><th>IP</th></tr></thead>
    <tbody>${itens.map((a) => `<tr><td>${dataHora(a.quando)}</td><td>${esc(a.usuario ?? '—')}</td><td><code>${esc(a.acao)}</code></td>
      <td>${esc(a.alvo ?? '')}</td><td><small>${esc((a.detalhe ?? '').slice(0, 160))}</small></td><td>${esc(a.ip ?? '')}</td></tr>`).join('')}</tbody></table></div></div>`;
};

// --- Gestão da equipe (web/gestao.js) -------------------------------------------

registrarGestao({ paginas, estado, pagina, $, $$, esc, num, duracao, dataHora, pct, api, aviso, abrirDialogo, grafico, COR,
  mapaDeCalor, pintarCalor, aplicarLarguras, ehGestor, rotear, listaChamados });

// --- Início -------------------------------------------------------------------

(async () => {
  try {
    const { usuario } = await api('/api/eu');
    estado.usuario = usuario;
    await iniciarApp();
  } catch {
    mostrarLogin();
  }
  setInterval(() => estado.usuario && atualizarStatus(), 60_000);
})();
