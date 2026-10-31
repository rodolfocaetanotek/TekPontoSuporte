// Telas da gestão da equipe: dashboards (técnicos, individual, gestão), GoTo/Voz, análise de
// chamadas, cadastro de técnicos, disponibilidade, calendário, escalas, metas e feriados.
// Recebe as utilidades do app.js por parâmetro (sem import circular).
// Atenção à CSP: nada de style="" no HTML; larguras via data-largura (aplicarLarguras).

export function registrarGestao(ctx) {
  const { paginas, estado, pagina, $, $$, esc, num, duracao, dataHora, pct, api, aviso, abrirDialogo, grafico, COR,
    mapaDeCalor, pintarCalor, aplicarLarguras, ehGestor, rotear, listaChamados } = ctx;

  // --- Utilidades ------------------------------------------------------------

  const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
  const inicioDoMes = (d = hoje()) => `${d.slice(0, 7)}-01`;
  const fimDoMes = (mes) => new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 0)).toISOString().slice(0, 10);
  const mesAnterior = (mes) => { const d = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)) - 2, 1)); return d.toISOString().slice(0, 7); };
  const mesSeguinte = (mes) => { const d = new Date(Date.UTC(Number(mes.slice(0, 4)), Number(mes.slice(5)), 1)); return d.toISOString().slice(0, 7); };
  const nomeDoMes = (mes) => { const t = new Date(`${mes}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }); return t[0].toUpperCase() + t.slice(1); };
  const diaCurto = (d) => d.split('-').reverse().slice(0, 2).join('/');
  const diaLongo = (d) => d.split('-').reverse().join('/');
  const seg = (s) => (s == null ? '—' : s < 60 ? `${Math.round(s)} s` : duracao(s));
  const horas = (s) => (s == null ? '—' : `${num(s / 3600, 1)} h`);
  const percentual = (v) => (v == null ? '—' : `${num(v * 100, 0)}%`);
  const nomeDoDia = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

  estado.periodoGestao ??= { de: inicioDoMes(), ate: hoje() };
  estado.mesGestao ??= hoje().slice(0, 7);

  const SIGLA = { 'Presente': 'P', 'Meio período': '½', 'Férias': 'FE', 'Folga': 'FO', 'DayOff': 'DO', 'Ausente': 'AU', 'Atestado': 'AT', 'Banco de horas': 'BH', 'Treinamento': 'TR' };
  const CLASSE = { 'Presente': 'presente', 'Meio período': 'parcial', 'Férias': 'ferias', 'Folga': 'folga', 'DayOff': 'folga', 'Ausente': 'ausente', 'Atestado': 'atestado', 'Banco de horas': 'parcial', 'Treinamento': 'treino' };

  function filtroPeriodo({ extra = '' } = {}) {
    const p = estado.periodoGestao;
    return `<form class="filtros" id="filtro-periodo">
      <label>De<input type="date" name="de" value="${p.de}" required></label>
      <label>Até<input type="date" name="ate" value="${p.ate}" required></label>
      ${extra}
      <button class="botao primario">Aplicar</button>
      <div class="periodo-rapido"><button type="button" class="link" data-rapido="mes">Este mês</button> · <button type="button" class="link" data-rapido="anterior">Mês passado</button> · <button type="button" class="link" data-rapido="30">30 dias</button></div>
    </form>`;
  }

  function ligarPeriodo(aoAplicar = rotear) {
    const form = $('#filtro-periodo');
    if (!form) return;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      estado.periodoGestao = { de: d.de, ate: d.ate };
      aoAplicar(d);
    });
    $$('[data-rapido]', form).forEach((b) => b.addEventListener('click', () => {
      const h = hoje();
      if (b.dataset.rapido === 'mes') estado.periodoGestao = { de: inicioDoMes(h), ate: h };
      if (b.dataset.rapido === 'anterior') { const m = mesAnterior(h.slice(0, 7)); estado.periodoGestao = { de: `${m}-01`, ate: fimDoMes(m) }; }
      if (b.dataset.rapido === '30') estado.periodoGestao = { de: new Date(Date.now() - 29 * 86400_000).toISOString().slice(0, 10), ate: h };
      rotear();
    }));
  }

  const kpi = (rotulo, valor, detalhe = '', classe = '') => `<div class="kpi ${classe}"><div class="rotulo">${rotulo}</div><div class="valor">${valor}</div><div class="detalhe">${detalhe}</div></div>`;
  const classeAtingimento = (a) => (a == null ? '' : a >= 1 ? 'verde' : a < 0.8 ? 'alerta' : '');
  const barraAtingimento = (a) => (a == null ? '<span class="nota">sem meta</span>'
    : `<div class="barra-meta ${a >= 1 ? 'ok' : a < 0.8 ? 'baixo' : ''}"><span data-largura="${Math.min(100, a * 100)}"></span></div><small>${percentual(a)}</small>`);

  function avisoSemMeta(lista) {
    if (!lista?.length) return '';
    return `<div class="aviso-faixa">Sem meta cadastrada: ${lista.map(esc).join(', ')}. O atingimento só aparece depois de definir a meta em <a href="#/metas">Metas por período</a> (ou a meta padrão em <a href="#/equipe">Técnicos</a>).</div>`;
  }

  // --- Rankings (Digisac e ligações) -----------------------------------------
  // Cada critério diz se maior é melhor. Sem valor (ou CSAT com menos de 3 respostas) vai para
  // o fim, sem posição, para não premiar quem quase não teve avaliação.
  const MIN_CSAT = 3;
  const CRITERIOS = {
    digisac: [
      { chave: 'chamados', rotulo: 'Chamados', fmt: (v) => num(v), maior: true },
      { chave: 'encerrados', rotulo: 'Encerrados', fmt: (v) => num(v), maior: true },
      { chave: 'primeira_resposta_seg', rotulo: '1ª resposta', fmt: duracao, maior: false },
      { chave: 'duracao_seg', rotulo: 'Duração (TMA)', fmt: duracao, maior: false },
      { chave: 'csat', rotulo: 'CSAT', fmt: (v, x) => `${num(v, 2)} <small>(${num(x.csat_respostas)})</small>`, maior: true, valido: (x) => x.csat_respostas >= MIN_CSAT },
      { chave: 'qualidade', rotulo: 'Qualidade IA', fmt: (v, x) => (v == null ? '—' : `${num(v, 1)} <small>(${num(x.revisadas)})</small>`), maior: true },
    ],
    ligacoes: [
      { chave: 'ligacoes', rotulo: 'Ligações', fmt: (v) => num(v), maior: true },
      { chave: 'conversa_seg', rotulo: 'Tempo em conversa', fmt: horas, maior: true },
      { chave: 'tma_seg', rotulo: 'TMA', fmt: seg, maior: false },
      { chave: 'espera_seg', rotulo: 'Espera média', fmt: seg, maior: false },
      { chave: 'pausas_seg', rotulo: 'Pausas', fmt: (v, x) => `${horas(v)} <small>(${num(x.pausas_qtd)})</small>`, maior: false },
    ],
  };
  const TITULO_RANKING = { digisac: 'Ranking Digisac (chat)', ligacoes: 'Ranking de ligações (GoTo)' };
  estado.rankingCriterio ??= { digisac: 'chamados', ligacoes: 'ligacoes' };

  function ordenarRanking(tipo, itens) {
    const c = CRITERIOS[tipo].find((x) => x.chave === estado.rankingCriterio[tipo]) ?? CRITERIOS[tipo][0];
    const valido = (x) => x[c.chave] != null && (!c.valido || c.valido(x));
    const com = itens.filter(valido).sort((a, b) => (c.maior ? b[c.chave] - a[c.chave] : a[c.chave] - b[c.chave]));
    return { criterio: c, ordenados: [...com.map((x, i) => ({ ...x, posicao: i + 1 })), ...itens.filter((x) => !valido(x)).map((x) => ({ ...x, posicao: null }))] };
  }

  function montarRanking(alvo, tipo, itens, { compacto = false } = {}) {
    const desenhar = () => {
      const { criterio, ordenados } = ordenarRanking(tipo, itens);
      const colunas = CRITERIOS[tipo].filter((c) => !compacto || c.chave === criterio.chave || ['chamados', 'ligacoes', 'csat', 'tma_seg'].includes(c.chave));
      const valores = ordenados.filter((x) => x.posicao).map((x) => x[criterio.chave]);
      const max = Math.max(...valores, 0);
      const min = Math.min(...valores, Infinity);
      // Barra: 100% para o melhor (maior ou menor, conforme o critério).
      const largura = (v) => (v == null || !valores.length ? 0 : criterio.maior ? (max ? (v / max) * 100 : 0) : (v ? (min / v) * 100 : 100));
      const total = tipo === 'digisac' ? itens.reduce((s, x) => s + (x.chamados ?? 0), 0) : itens.reduce((s, x) => s + (x.ligacoes ?? 0), 0);
      alvo.innerHTML = `<div class="cabeca-ranking"><h2>${TITULO_RANKING[tipo]}</h2>
          <label>Ordenar por<select class="sel-criterio">${CRITERIOS[tipo].map((c) => `<option value="${c.chave}" ${c.chave === criterio.chave ? 'selected' : ''}>${c.rotulo} (${c.maior ? 'maior' : 'menor'} primeiro)</option>`).join('')}</select></label></div>
        ${ordenados.length ? `<div class="tabela-envolve"><table class="ranking">
          <thead><tr><th>#</th><th>Técnico</th>${colunas.map((c) => `<th class="num ordenavel ${c.chave === criterio.chave ? 'ativa' : ''}" data-criterio="${c.chave}">${c.rotulo}</th>`).join('')}<th></th></tr></thead>
          <tbody>${ordenados.map((x) => `<tr class="${x.id ? 'clicavel' : ''}" ${x.id ? `data-ir="${esc(x.id)}"` : ''}>
            <td>${x.posicao ? `<span class="posicao ${['', 'ouro', 'prata', 'bronze'][x.posicao] ?? ''}">${x.posicao}º</span>` : '<span class="nota">—</span>'}</td>
            <td>${esc(x.nome)}${x.id ? '' : ' <span class="etiqueta pendente">sem vínculo</span>'}</td>
            ${colunas.map((c) => `<td class="num ${c.chave === criterio.chave ? 'destaque' : ''}">${x[c.chave] == null ? '—' : c.fmt(x[c.chave], x)}</td>`).join('')}
            <td><div class="barra"><span data-largura="${x.posicao ? largura(x[criterio.chave]) : 0}"></span></div></td></tr>`).join('')}</tbody></table></div>
          <p class="nota">Total no período: ${num(total)} ${tipo === 'digisac' ? 'chamados (data de abertura)' : 'ligações na fila do Ponto'}.
            ${criterio.chave === 'csat' ? ` No CSAT só entra na classificação quem teve pelo menos ${MIN_CSAT} respostas de clientes.` : ''}
            ${criterio.chave === 'qualidade' ? ' Qualidade só conta análises da IA revisadas pela coordenação.' : ''} Clique no título de uma coluna para ordenar por ela.</p>`
    : '<p class="vazio">Sem dados no período.</p>'}`;
      aplicarLarguras(alvo);
      $('.sel-criterio', alvo).addEventListener('change', (e) => { estado.rankingCriterio[tipo] = e.target.value; desenhar(); });
      $$('th[data-criterio]', alvo).forEach((th) => th.addEventListener('click', () => { estado.rankingCriterio[tipo] = th.dataset.criterio; desenhar(); }));
      $$('tr[data-ir]', alvo).forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/individual/${encodeURIComponent(tr.dataset.ir)}`; }));
    };
    desenhar();
  }

  // Posição de um técnico em cada métrica (Dashboard Individual): "2º de 6", valor e média da equipe.
  // A média sai sem o complemento entre parênteses (nº de respostas/pausas), que é individual.
  const MEDIA_SIMPLES = { csat: (v) => num(v, 2), qualidade: (v) => num(v, 1), pausas_seg: horas };
  function cartaoPosicoes(posicoes, funcao) {
    if (!posicoes) return funcao ? `<div class="aviso-faixa">Função ${esc(funcao)}: não entra nos rankings. Os indicadores abaixo continuam valendo.</div>` : '';
    const bloco = (tipo) => {
      const linhas = posicoes[tipo].map((p) => {
        const c = CRITERIOS[tipo].find((x) => x.chave === p.chave);
        const x = { ...(p.extra ?? {}), [p.chave]: p.valor };
        return `<tr><td>${esc(c.rotulo)} <small class="nota">${p.maior ? 'maior é melhor' : 'menor é melhor'}</small></td>
          <td class="num">${p.valor == null ? '—' : c.fmt(p.valor, x)}</td>
          <td>${p.posicao ? `<span class="posicao ${['', 'ouro', 'prata', 'bronze'][p.posicao] ?? ''}">${p.posicao}º</span> <small>de ${p.total}</small>` : `<small class="nota">${esc(p.motivo)}</small>`}</td>
          <td class="num"><small>${p.media == null ? '—' : (MEDIA_SIMPLES[p.chave] ?? c.fmt)(p.media, {})}</small></td></tr>`;
      }).join('');
      return `<div><h3 class="titulo-secao">${TITULO_RANKING[tipo]}</h3><table class="ranking"><thead><tr><th>Métrica</th><th class="num">Valor</th><th>Posição</th><th class="num">Média da equipe</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
    };
    const lideres = Object.values(posicoes).flat().filter((p) => p.posicao === 1).length;
    return `<div class="cartao grade-espaco-baixo"><h2>Posição nos rankings${lideres ? ` <span class="etiqueta ok">1º em ${lideres} métrica(s)</span>` : ''}</h2>
      <div class="grade-2-iguais">${bloco('digisac')}${bloco('ligacoes')}</div>
      <p class="nota">Comparação com a equipe do Ponto no mesmo período. No CSAT só entra quem teve pelo menos ${MIN_CSAT} respostas de clientes.${ehGestor() ? ' <a href="#/rankings">Ver rankings completos →</a>' : ''}</p></div>`;
  }

  paginas.rankings = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const d = await api(`/api/rankings?${qs(estado.periodoGestao)}`);
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Rankings</h1><p>Classificação dos técnicos no Digisac (chat) e nas ligações da fila do Ponto (GoTo).</p></div>${filtroPeriodo()}</div>
      <div class="cartao" id="ranking-digisac"></div>
      <div class="cartao grade-espaco" id="ranking-ligacoes"></div>`;
    ligarPeriodo();
    montarRanking($('#ranking-digisac'), 'digisac', d.digisac);
    montarRanking($('#ranking-ligacoes'), 'ligacoes', d.ligacoes);
  };

  // --- Dashboard Técnicos ----------------------------------------------------

  paginas['dash-tecnicos'] = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const p = estado.periodoGestao;
    const [d, chat] = await Promise.all([api(`/api/dashboard/tecnicos?${qs(p)}`), api(`/api/painel?${qs({ de: p.de, ate: p.ate })}`)]);
    const chatPorId = new Map(chat.tecnicos.filter((t) => t.id).map((t) => [t.id, t]));
    const t = d.tecnicos;
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Dashboard Técnicos</h1><p>Meta x realizado (chat + voz), disponibilidade e qualidade de cada técnico no período.</p></div>${filtroPeriodo()}</div>
      ${avisoSemMeta(t.filter((x) => x.meta == null).map((x) => x.nome))}
      ${t.length ? `<div class="cartao"><div class="tabela-envolve"><table>
        <thead><tr><th>Técnico</th><th>Escala</th><th class="num">Disponib.</th><th class="num">Meta</th><th class="num">Chat</th><th class="num">Voz</th><th class="num">Realizado</th><th>Atingimento</th>
          <th class="num">Por dia disp.</th><th class="num">TMA voz</th><th class="num">Pausas</th><th class="num">1ª resp. chat</th><th class="num">CSAT</th><th class="num">Qualidade IA</th></tr></thead>
        <tbody>${t.map((x) => { const c = chatPorId.get(x.id); return `<tr class="clicavel" data-ir="${esc(x.id)}">
          <td>${esc(x.nome)}</td><td>${x.escala ? `${esc(x.escala.nome)} <small>${esc(x.escala.hora_inicio)}–${esc(x.escala.hora_fim)}</small>` : '—'}</td>
          <td class="num">${percentual(x.disponibilidade)}</td><td class="num">${num(x.meta, 0)}</td><td class="num">${num(x.chats)}</td><td class="num">${num(x.ligacoes)}</td>
          <td class="num"><strong>${num(x.realizado)}</strong></td><td>${barraAtingimento(x.atingimento)}</td>
          <td class="num">${num(x.media_por_dia_disponivel, 1)}</td><td class="num">${seg(x.voz?.tma_medio_seg)}</td><td class="num">${horas(x.voz?.pausas_seg)}</td>
          <td class="num">${duracao(c?.primeira_resposta_media_seg)}</td><td class="num">${num(c?.csat_medio, 2)}</td><td class="num">${num(c?.nota_qualidade_media, 1)}</td></tr>`; }).join('')}</tbody></table></div>
        <p class="nota">Chat = chamados do Digisac encerrados no período. Voz = ligações atendidas na fila do Ponto (GoTo). Clique num técnico para o dashboard individual.</p></div>
      <div class="cartao grade-espaco"><h2>Meta x realizado</h2><div class="grafico"><canvas id="g-meta"></canvas></div></div>`
    : '<div class="cartao"><p class="vazio">Nenhum técnico marcado como da equipe. Marque-os em <a href="#/equipe">Técnicos</a>.</p></div>'}`;
    ligarPeriodo();
    aplicarLarguras();
    $$('tr[data-ir]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/individual/${encodeURIComponent(tr.dataset.ir)}`; }));
    if (!t.length) return;
    grafico($('#g-meta'), {
      type: 'bar',
      data: {
        labels: t.map((x) => x.nome),
        datasets: [
          { label: 'Chat', data: t.map((x) => x.chats), backgroundColor: COR.laranja, stack: 'r', borderRadius: 3 },
          { label: 'Voz', data: t.map((x) => x.ligacoes), backgroundColor: COR.verde, stack: 'r', borderRadius: 3 },
          { label: 'Meta', data: t.map((x) => x.meta), backgroundColor: COR.cinza, stack: 'm', borderRadius: 3 },
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
  };

  // --- Dashboard Individual --------------------------------------------------

  paginas.individual = async (id) => {
    if (!ehGestor()) id = estado.usuario.tecnico_id;
    const p = estado.periodoGestao;
    const d = await api(`/api/dashboard/individual?${qs({ ...p, tecnico: id ?? '' })}`);
    const seletor = ehGestor() ? `<label>Técnico<select id="sel-tecnico"><option value="">Escolha...</option>${d.equipe.map((t) => `<option value="${esc(t.id)}" ${t.id === id ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>` : '';
    if (!d.tecnico) {
      pagina.innerHTML = `<div class="cabecalho"><div><h1>Dashboard Individual</h1><p>${ehGestor() ? 'Escolha um técnico.' : 'Seu usuário ainda não está ligado a um técnico do Digisac. Peça à coordenação.'}</p></div>${filtroPeriodo({ extra: seletor })}</div>`;
      ligarPeriodo();
      $('#sel-tecnico')?.addEventListener('change', (e) => { location.hash = `#/individual/${encodeURIComponent(e.target.value)}`; });
      return;
    }
    const chat = await api(`/api/painel?${qs({ de: p.de, ate: p.ate, tecnico: d.tecnico.id })}`);
    const r = d.resumo;
    const cr = chat.resumo;
    const v = d.voz.resumo;
    const ausencias = Object.entries(r.ausencias);
    pagina.innerHTML = `<div class="cabecalho"><div>${ehGestor() ? '<a href="#/dash-tecnicos">← Dashboard Técnicos</a>' : ''}<h1>${esc(d.tecnico.nome)}</h1>
        <p>${[d.tecnico.funcao, d.tecnico.matricula && `matrícula ${d.tecnico.matricula}`, r.escala && `${r.escala.nome} (${r.escala.hora_inicio}–${r.escala.hora_fim})`].filter(Boolean).map(esc).join(' · ') || 'Dashboard individual'}</p></div>
        ${filtroPeriodo({ extra: seletor })}</div>
      <div class="grade-kpi">
        ${kpi('Realizado', num(r.realizado), `${num(r.chats)} chat · ${num(r.ligacoes)} voz`)}
        ${kpi('Meta do período', num(r.meta, 0), r.meta == null ? 'sem meta cadastrada' : `${num(r.dias_uteis)} dias úteis`)}
        ${kpi('Atingimento', percentual(r.atingimento), r.meta == null ? '—' : `${num(r.realizado)} de ${num(r.meta, 0)}`, classeAtingimento(r.atingimento))}
        ${kpi('Disponibilidade', percentual(r.disponibilidade), `${num(r.dias_disponiveis, 1)} de ${num(r.dias_uteis)} dias úteis`, r.disponibilidade != null && r.disponibilidade < 0.8 ? 'alerta' : 'verde')}
        ${kpi('Por dia disponível', num(r.media_por_dia_disponivel, 1), 'atendimentos (chat + voz)')}
        ${kpi('1ª resposta no chat', duracao(cr.primeira_resposta_media_seg), `mediana ${duracao(cr.primeira_resposta_mediana_seg)}`)}
        ${kpi('CSAT', num(cr.csat_medio, 2), `${num(cr.csat_respostas)} resposta(s)`, 'verde')}
        ${kpi('Qualidade (IA revisada)', num(cr.nota_qualidade_media, 1), `${num(cr.analises_revisadas)} revisada(s)`, 'verde')}
        ${kpi('TMA na voz', seg(v.tma_medio_seg), `espera média ${seg(v.espera_media_seg)}`)}
        ${kpi('Pausas', horas(d.pausas.reduce((s, x) => s + x.seg, 0)), `${num(d.pausas.reduce((s, x) => s + x.qtd, 0))} pausa(s)`)}
      </div>
      ${cartaoPosicoes(d.posicoes, d.tecnico.funcao)}
      <div class="cartao"><h2>Dia a dia</h2><div class="grafico"><canvas id="g-dias"></canvas></div>
        <div class="faixa-dias">${d.dias.map((x) => `<div class="dia-mini ${x.util ? CLASSE[x.status] ?? '' : 'fechado'}" title="${esc(diaLongo(x.dia))}: ${esc(x.util ? `${x.status}${x.fracao < 1 && x.fracao > 0 ? ` (${percentual(x.fracao)})` : ''}` : x.feriado?.descricao ?? x.motivo)}">${x.dia.slice(8)}<br><small>${x.util ? SIGLA[x.status] ?? '' : ''}</small></div>`).join('')}</div></div>
      <div class="grade-2-iguais grade-espaco">
        <div class="cartao"><h2>Pausas na GoTo</h2>${d.pausas.length ? `<table><thead><tr><th>Motivo</th><th class="num">Qtd</th><th class="num">Tempo</th></tr></thead>
          <tbody>${d.pausas.map((x) => `<tr><td>${esc(x.motivo)}</td><td class="num">${num(x.qtd)}</td><td class="num">${duracao(x.seg)}</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Sem pausas no período.</p>'}</div>
        <div class="cartao"><h2>Ausências no período</h2>${ausencias.length ? `<table><tbody>${ausencias.map(([s, n]) => `<tr><td><span class="etiqueta disp-${CLASSE[s] ?? ''}">${esc(s)}</span></td><td class="num">${num(n, 1)} dia(s)</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Nenhuma ausência lançada.</p>'}
          ${ehGestor() ? '<p class="nota"><a href="#/disponibilidade">Lançar em Disponibilidade</a></p>' : ''}</div>
      </div>
      <div class="cartao grade-espaco"><h2>Atendimentos no chat</h2><div id="lista-individual"></div></div>`;
    ligarPeriodo();
    $('#sel-tecnico')?.addEventListener('change', (e) => { location.hash = `#/individual/${encodeURIComponent(e.target.value)}`; });
    grafico($('#g-dias'), {
      data: {
        labels: d.dias.map((x) => diaCurto(x.dia)),
        datasets: [
          { type: 'bar', label: 'Chat', data: d.dias.map((x) => x.chats), backgroundColor: COR.laranja, stack: 'r', borderRadius: 2 },
          { type: 'bar', label: 'Voz', data: d.dias.map((x) => x.ligacoes), backgroundColor: COR.verde, stack: 'r', borderRadius: 2 },
          ...(r.meta != null ? [{ type: 'line', label: 'Meta do dia', data: d.dias.map((x) => (x.util ? x.meta : null)), borderColor: COR.cinza, borderDash: [4, 4], pointRadius: 0, spanGaps: false }] : []),
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } },
    });
    const filtroAntes = { ...estado.filtro };
    estado.filtro.de = p.de; estado.filtro.ate = p.ate;
    await listaChamados($('#lista-individual'), { tecnico: d.tecnico.id });
    Object.assign(estado.filtro, filtroAntes);
  };

  // --- Dashboard Gestão ------------------------------------------------------

  paginas.gestao = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const d = await api(`/api/dashboard/gestao?${qs(estado.periodoGestao)}`);
    const r = d.resumo;
    const ausencias = Object.entries(d.ausencias).sort((a, b) => b[1] - a[1]);
    const ranking = d.tecnicos.filter((t) => !d.foraDoRanking.includes(t.funcao)).sort((a, b) => (b.atingimento ?? -1) - (a.atingimento ?? -1) || b.realizado - a.realizado);
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Dashboard Gestão</h1><p>Visão da coordenação: meta da equipe, projeção, absenteísmo, voz e alertas.</p></div>${filtroPeriodo()}</div>
      ${avisoSemMeta(d.semMeta)}
      <div class="grade-kpi">
        ${kpi('Equipe ativa', num(r.tecnicos), `${num(r.dias_uteis)} dias úteis no período`)}
        ${kpi('Realizado', num(r.realizado), `${num(r.chats)} chat · ${num(r.ligacoes)} voz`)}
        ${kpi('Meta da equipe', num(r.meta, 0), r.meta == null ? 'sem meta cadastrada' : 'soma das metas do dia')}
        ${kpi('Atingimento', percentual(r.atingimento), '', classeAtingimento(r.atingimento))}
        ${kpi('Projeção do período', num(r.projecao), r.dias_futuros ? `ritmo de ${num(r.dias_passados ? r.realizado / r.dias_passados : null, 1)}/dia × ${num(r.dias_futuros)} dia(s) úteis restantes${r.meta ? ` · ${percentual(r.projecao / r.meta)} da meta` : ''}` : 'período encerrado', r.meta && r.projecao != null ? classeAtingimento(r.projecao / r.meta) : '')}
        ${kpi('Disponibilidade média', percentual(r.disponibilidade), 'dias úteis com o técnico disponível', r.disponibilidade != null && r.disponibilidade < 0.85 ? 'alerta' : 'verde')}
        ${kpi('Voz: nível de serviço', percentual(d.voz.nivel_servico), `atendidas em até ${d.voz.nivel_servico_seg} s · ${num(d.voz.ligacoes)} ligações`, d.voz.nivel_servico != null && d.voz.nivel_servico < 0.8 ? 'alerta' : 'verde')}
        ${kpi('IA: a revisar', num(d.ia?.pendentes ?? 0), `${num(d.ia?.insatisfacao ?? 0)} com sinal de insatisfação`, d.ia?.insatisfacao ? 'alerta' : 'verde')}
      </div>
      <div class="grade-2">
        <div class="cartao"><h2>Semana a semana</h2><div class="grafico"><canvas id="g-semanas"></canvas></div></div>
        <div class="cartao"><h2>Alertas</h2>${d.alertas.length ? `<ul class="alertas">${d.alertas.map((a) => `<li class="${esc(a.tipo)}"><strong>${esc(a.tecnico)}</strong>: ${esc(a.texto)}</li>`).join('')}</ul>` : '<p class="vazio">Nenhum alerta no período.</p>'}
          <p class="nota">Meta abaixo de 80% ou disponibilidade abaixo de 70% dos dias úteis.</p></div>
      </div>
      <div class="grade-2-iguais grade-espaco">
        <div class="cartao"><h2>Ranking geral (chat + voz)</h2><div class="tabela-envolve"><table>
          <thead><tr><th>#</th><th>Técnico</th><th class="num">Realizado</th><th class="num">Meta</th><th>Atingimento</th><th class="num">Disponib.</th></tr></thead>
          <tbody>${ranking.map((t, i) => `<tr class="clicavel" data-ir="${esc(t.id)}"><td>${i + 1}</td><td>${esc(t.nome)}</td><td class="num">${num(t.realizado)}</td><td class="num">${num(t.meta, 0)}</td>
            <td>${barraAtingimento(t.atingimento)}</td><td class="num">${percentual(t.disponibilidade)}</td></tr>`).join('')}</tbody></table></div></div>
        <div class="cartao"><h2>Absenteísmo</h2>${ausencias.length ? `<table><thead><tr><th>Motivo</th><th class="num">Dias</th></tr></thead>
          <tbody>${ausencias.map(([s, n]) => `<tr><td><span class="etiqueta disp-${CLASSE[s] ?? ''}">${esc(s)}</span></td><td class="num">${num(n, 1)}</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Nenhuma ausência lançada no período.</p>'}
          <p class="nota">Dias úteis perdidos (ausência parcial conta proporcionalmente).</p></div>
      </div>
      <div class="grade-2-iguais grade-espaco"><div class="cartao" id="rank-digisac"></div><div class="cartao" id="rank-ligacoes"></div></div>
      <p class="nota"><a href="#/rankings">Ver os rankings completos →</a></p>`;
    ligarPeriodo();
    aplicarLarguras();
    $$('tr[data-ir]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/individual/${encodeURIComponent(tr.dataset.ir)}`; }));
    montarRanking($('#rank-digisac'), 'digisac', d.rankings.digisac, { compacto: true });
    montarRanking($('#rank-ligacoes'), 'ligacoes', d.rankings.ligacoes, { compacto: true });
    grafico($('#g-semanas'), {
      data: {
        labels: d.semanas.map((s) => `sem. ${diaCurto(s.semana)}`),
        datasets: [
          { type: 'bar', label: 'Chat', data: d.semanas.map((s) => s.chats), backgroundColor: COR.laranja, stack: 'r', borderRadius: 3 },
          { type: 'bar', label: 'Voz', data: d.semanas.map((s) => s.ligacoes), backgroundColor: COR.verde, stack: 'r', borderRadius: 3 },
          ...(d.semanas.some((s) => s.meta != null) ? [{ type: 'line', label: 'Meta', data: d.semanas.map((s) => s.meta), borderColor: COR.cinza, borderDash: [4, 4], pointRadius: 3 }] : []),
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } },
    });
  };

  // --- GoTo / Voz ------------------------------------------------------------

  function cartaoBase(base) {
    if (!base) return '<div class="aviso-faixa">A base da GoTo ainda não foi importada. Coloque o arquivo da Base Bruno na pasta configurada e clique em Reimportar.</div>';
    return `<p class="nota">Fonte: Base Bruno (<code>${esc(base.arquivo)}</code>), importada em ${dataHora(base.importado_em)} · fila "${esc(base.fila)}" · ligações de ${base.de ? diaLongo(base.de) : '—'} a ${base.ate ? diaLongo(base.ate) : '—'}.
      Abandonos não são mostrados: na base eles não indicam a fila e não dá para separar os do Ponto.
      <button class="link" id="reimportar">Reimportar agora</button></p>`;
  }

  paginas.voz = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const p = estado.periodoGestao;
    const tecnico = estado.vozTecnico ?? '';
    const d = await api(`/api/voz?${qs({ ...p, tecnico })}`);
    const r = d.resumo;
    const seletor = `<label>Técnico<select name="tecnico"><option value="">Todos</option>${d.tecnicos.map((t) => `<option value="${esc(t.id)}" ${t.id === tecnico ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>`;
    pagina.innerHTML = `<div class="cabecalho"><div><h1>GoTo / Voz</h1><p>Ligações da fila <strong>Ponto Eletrônico</strong> na GoTo (só a fila do Ponto).</p></div>${filtroPeriodo({ extra: seletor })}</div>
      ${d.diasSemDados.length ? `<div class="aviso-faixa">${num(d.diasSemDados.length)} dia(s) útil(eis) sem nenhuma ligação na base (${esc(d.diasSemDados.slice(0, 5).map(diaCurto).join(', '))}${d.diasSemDados.length > 5 ? '…' : ''}). Pode ser falta de dados na Base Bruno, não ausência de ligações.</div>` : ''}
      <div class="grade-kpi">
        ${kpi('Ligações atendidas', num(r.ligacoes), `${num(d.porDia.length)} dia(s) com ligação`)}
        ${kpi('Espera na fila (TME)', seg(r.espera_media_seg), `mediana ${seg(r.espera_mediana_seg)} · máx. ${seg(r.espera_maxima_seg)}`)}
        ${kpi('Nível de serviço', percentual(r.nivel_servico), `atendidas em até ${r.nivel_servico_seg} s`, r.nivel_servico != null && r.nivel_servico < 0.8 ? 'alerta' : 'verde')}
        ${kpi('Duração (TMA)', seg(r.tma_medio_seg), `mediana ${seg(r.tma_mediano_seg)} · conversa + pós`)}
        ${kpi('Tempo em conversa', horas(r.conversa_total_seg), 'soma do período')}
      </div>
      <div class="grade-2">
        <div class="cartao"><h2>Ligações por dia</h2><div class="grafico"><canvas id="g-voz-dia"></canvas></div></div>
        <div class="cartao"><h2>Quando os clientes ligam</h2>${mapaDeCalor(d.porHora)}<p class="nota">Horário de Brasília.</p></div>
      </div>
      <div class="grade-2 grade-espaco">
        <div class="cartao"><h2>Por atendente</h2>${d.porAgente.length ? `<div class="tabela-envolve"><table>
          <thead><tr><th>Técnico</th><th class="num">Ligações</th><th></th><th class="num">Espera média</th><th class="num">TMA</th><th class="num">Em conversa</th><th class="num">Pausas</th></tr></thead>
          <tbody>${d.porAgente.map((a) => `<tr ${a.id ? `class="clicavel" data-ir="${esc(a.id)}"` : ''}><td>${esc(a.nome)}${a.id ? '' : ' <span class="etiqueta pendente">sem vínculo</span>'}</td>
            <td class="num">${num(a.ligacoes)}</td><td><div class="barra"><span data-largura="${(a.ligacoes / Math.max(...d.porAgente.map((x) => x.ligacoes))) * 100}"></span></div></td>
            <td class="num">${seg(a.espera_media_seg)}</td><td class="num">${seg(a.tma_medio_seg)}</td><td class="num">${horas(a.conversa_total_seg)}</td><td class="num">${horas(a.pausas_seg)} <small>(${num(a.pausas_qtd)})</small></td></tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Sem ligações no período.</p>'}</div>
        <div class="cartao"><h2>Pausas por motivo</h2>${d.pausas.length ? `<table><thead><tr><th>Motivo</th><th class="num">Qtd</th><th class="num">Tempo</th></tr></thead>
          <tbody>${d.pausas.map((x) => `<tr><td>${esc(x.motivo)}</td><td class="num">${num(x.qtd)}</td><td class="num">${horas(x.seg)}</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Sem pausas no período.</p>'}</div>
      </div>
      <div class="cartao grade-espaco">${cartaoBase(d.base)} <a href="#/chamadas-voz">Ver cada ligação em Análise de chamadas →</a></div>`;
    ligarPeriodo((dados) => { estado.vozTecnico = dados.tecnico ?? ''; rotear(); });
    aplicarLarguras();
    pintarCalor();
    $$('tr[data-ir]').forEach((tr) => tr.addEventListener('click', () => { location.hash = `#/individual/${encodeURIComponent(tr.dataset.ir)}`; }));
    ligarReimportar();
    grafico($('#g-voz-dia'), {
      data: {
        labels: d.porDia.map((x) => diaCurto(x.dia)),
        datasets: [
          { type: 'bar', label: 'Ligações', data: d.porDia.map((x) => x.ligacoes), backgroundColor: COR.verde, borderRadius: 3, yAxisID: 'y' },
          { type: 'line', label: 'Espera média (s)', data: d.porDia.map((x) => Math.round(x.espera_media_seg)), borderColor: COR.laranja, pointRadius: 2, yAxisID: 'y2' },
        ],
      },
      options: { plugins: { legend: { position: 'bottom' } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } }, y2: { beginAtZero: true, position: 'right', grid: { display: false } } } },
    });
  };

  function ligarReimportar() {
    $('#reimportar')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const r = await api('/api/voz/importar', { method: 'POST', body: {} });
        aviso(`Base importada: ${num(r.ligacoes)} ligações, ${num(r.pausas)} pausas.`);
        rotear();
      } catch (err) { aviso(err.message, true); e.target.disabled = false; }
    });
  }

  // --- Análise de chamadas ---------------------------------------------------

  estado.filtroChamadas ??= { tecnico: '', espera_min: '', duracao_min: '', ordem: 'recentes' };

  paginas['chamadas-voz'] = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const f = estado.filtroChamadas;
    const eq = await api('/api/equipe');
    const equipe = eq.tecnicos.filter((t) => t.na_equipe);
    const extra = `<label>Técnico<select name="tecnico"><option value="">Todos</option>${equipe.map((t) => `<option value="${esc(t.id)}" ${t.id === f.tecnico ? 'selected' : ''}>${esc(t.nome)}</option>`).join('')}</select></label>
      <label>Espera mín. (s)<input type="number" name="espera_min" min="0" value="${esc(f.espera_min)}"></label>
      <label>Duração mín. (min)<input type="number" name="duracao_min" min="0" step="0.5" value="${esc(f.duracao_min)}"></label>
      <label>Ordem<select name="ordem">${[['recentes', 'Mais recentes'], ['longas', 'Mais longas'], ['espera', 'Maior espera'], ['curtas', 'Mais curtas']].map(([v, r]) => `<option value="${v}" ${v === f.ordem ? 'selected' : ''}>${r}</option>`).join('')}</select></label>`;
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Análise de chamadas</h1><p>Cada ligação da fila do Ponto na GoTo, com espera e duração.</p></div>${filtroPeriodo({ extra })}</div>
      <div class="grade-2-iguais">
        <div class="cartao"><h2>Duração das ligações (TMA)</h2><div class="grafico baixo"><canvas id="g-faixa-tma"></canvas></div></div>
        <div class="cartao"><h2>Espera na fila</h2><div class="grafico baixo"><canvas id="g-faixa-espera"></canvas></div></div>
      </div>
      <div class="cartao grade-espaco"><div class="barra-lote"><span id="total-chamadas"></span><a class="botao" id="exportar-chamadas" href="#">Exportar CSV</a></div><div id="lista-chamadas"><p class="vazio">Carregando...</p></div></div>`;
    ligarPeriodo((dados) => { Object.assign(estado.filtroChamadas, { tecnico: dados.tecnico ?? '', espera_min: dados.espera_min ?? '', duracao_min: dados.duracao_min ?? '', ordem: dados.ordem ?? 'recentes' }); rotear(); });
    const consulta = () => qs({ ...estado.periodoGestao, ...estado.filtroChamadas });
    $('#exportar-chamadas').addEventListener('click', (e) => { e.preventDefault(); location.href = `/api/voz/chamadas.csv?${consulta()}`; });

    const carregar = async (paginaAtual) => {
      const r = await api(`/api/voz/chamadas?${consulta()}&pagina=${paginaAtual}`);
      $('#total-chamadas').textContent = `${num(r.total)} ligação(ões) no filtro`;
      const totalPaginas = Math.max(1, Math.ceil(r.total / r.porPagina));
      $('#lista-chamadas').innerHTML = r.itens.length ? `<div class="tabela-envolve"><table>
        <thead><tr><th>Dia</th><th>Hora</th><th>Técnico</th><th class="num">Espera</th><th class="num">Conversa</th><th class="num">Pós</th><th class="num">TMA</th></tr></thead>
        <tbody>${r.itens.map((l) => `<tr><td>${diaLongo(l.dia)} <small>${nomeDoDia(l.dia)}</small></td><td>${new Date(l.inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}</td>
          <td>${esc(l.tecnico)}</td><td class="num ${l.espera_seg > 60 ? 'texto-alerta' : ''}">${seg(l.espera_seg)}</td><td class="num">${seg(l.conversa_seg)}</td><td class="num">${seg(l.pos_seg)}</td><td class="num"><strong>${seg(l.total_seg)}</strong></td></tr>`).join('')}</tbody></table></div>
        <div class="paginacao">página ${paginaAtual} de ${totalPaginas}
          <button class="botao" data-pag="${paginaAtual - 1}" ${paginaAtual <= 1 ? 'disabled' : ''}>Anterior</button>
          <button class="botao" data-pag="${paginaAtual + 1}" ${paginaAtual >= totalPaginas ? 'disabled' : ''}>Próxima</button></div>` : '<p class="vazio">Nenhuma ligação no filtro.</p>';
      $$('[data-pag]').forEach((b) => b.addEventListener('click', () => carregar(Number(b.dataset.pag))));
      return r;
    };
    const r = await carregar(1);
    const barras = (canvas, faixas, cor) => grafico(canvas, {
      type: 'bar', data: { labels: faixas.map((x) => x.rotulo), datasets: [{ label: 'Ligações', data: faixas.map((x) => x.n), backgroundColor: cor, borderRadius: 3 }] },
      options: { plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } },
    });
    barras($('#g-faixa-tma'), r.faixasTma, COR.verde);
    barras($('#g-faixa-espera'), r.faixasEspera, COR.laranja);
  };

  // --- Técnicos (cadastro) ---------------------------------------------------

  paginas.equipe = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const d = await api('/api/equipe');
    const soEquipe = estado.cadastroSoEquipe ?? true;
    const lista = d.tecnicos.filter((t) => !soEquipe || t.na_equipe);
    const jornada = (m) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Técnicos</h1><p>Cadastro da equipe do Ponto. Nome e e-mail vêm do Digisac; o resto é da gestão.</p></div>
        <div class="filtros"><label class="opcao"><input type="checkbox" id="so-equipe" ${soEquipe ? 'checked' : ''}> Só a equipe do Ponto</label></div></div>
      <div class="cartao"><div class="tabela-envolve"><table>
        <thead><tr><th>Técnico</th><th>Situação</th><th>Matrícula</th><th>Função</th><th>Admissão</th><th>Jornada</th><th class="num">Meta padrão</th><th class="num">Meta vigente</th><th>Escala</th><th>Atendente na GoTo</th><th></th></tr></thead>
        <tbody>${lista.map((t) => `<tr>
          <td>${esc(t.nome)}${t.na_equipe ? '' : ' <span class="etiqueta neutro">fora da equipe</span>'}<br><small>${esc(t.email ?? '')}</small></td>
          <td><span class="etiqueta ${t.situacao === 'Ativo' ? 'ok' : 'neutro'}">${esc(t.situacao)}</span></td>
          <td>${esc(t.matricula ?? '—')}</td><td>${esc(t.funcao ?? '—')}</td><td>${t.data_admissao ? diaLongo(t.data_admissao) : '—'}</td>
          <td>${jornada(t.jornada_min) || `<small>${jornada(d.jornadaPadraoMin)} (padrão)</small>`}</td>
          <td class="num">${num(t.meta_padrao, 0)}</td><td class="num">${num(t.meta_vigente, 0)}</td><td>${esc(t.escala ?? '—')}</td>
          <td>${t.goto_agente ? esc(t.goto_agente) : '<span class="nota">—</span>'}</td>
          <td><button class="botao" data-editar="${esc(t.id)}">Editar</button></td></tr>`).join('')}</tbody></table></div>
        <p class="nota">"Na equipe" define quem entra nos dashboards, metas e disponibilidade. O vínculo com a GoTo foi feito automaticamente pelo nome; corrija aqui se precisar.</p></div>`;
    $('#so-equipe').addEventListener('change', (e) => { estado.cadastroSoEquipe = e.target.checked; rotear(); });
    $$('[data-editar]').forEach((b) => b.addEventListener('click', () => {
      const t = d.tecnicos.find((x) => x.id === b.dataset.editar);
      const usados = new Set(d.tecnicos.filter((x) => x.id !== t.id).map((x) => x.goto_agente).filter(Boolean));
      abrirDialogo(`<h2>${esc(t.nome)}</h2>
        <label class="opcao"><input type="checkbox" name="na_equipe" value="1" ${t.na_equipe ? 'checked' : ''}> Faz parte da equipe do Ponto</label>
        <label>Situação<select name="situacao"><option ${t.situacao === 'Ativo' ? 'selected' : ''}>Ativo</option><option ${t.situacao === 'Inativo' ? 'selected' : ''}>Inativo</option></select></label>
        <div class="linha-2"><label>Matrícula<input name="matricula" value="${esc(t.matricula ?? '')}"></label><label>Função<select name="funcao"><option value="">— não informada —</option>${d.funcoes.map((f) => `<option ${f === t.funcao ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></label></div>
        <div class="linha-2"><label>Admissão<input type="date" name="data_admissao" value="${esc(t.data_admissao ?? '')}"></label><label>Jornada diária<input name="jornada" placeholder="07:12" value="${jornada(t.jornada_min)}"></label></div>
        <label>Meta padrão (atendimentos por dia)<input type="number" name="meta_padrao" min="0" step="0.5" value="${t.meta_padrao ?? ''}"><small>Usada quando não há meta por período.</small></label>
        <label>Atendente na GoTo<select name="goto_agente"><option value="">— nenhum —</option>${d.agentes.map((a) => `<option value="${esc(a.agente)}" ${a.agente === t.goto_agente ? 'selected' : ''} ${usados.has(a.agente) ? 'disabled' : ''}>${esc(a.agente)} (${num(a.ligacoes)} ligações)</option>`).join('')}</select></label>`,
      async (dados) => {
        await api(`/api/equipe/${encodeURIComponent(t.id)}`, { method: 'POST', body: { ...dados, na_equipe: dados.na_equipe === '1' } });
        estado.filtrosDisponiveis = await api('/api/filtros');
        aviso('Cadastro salvo.');
        rotear();
      });
    }));
  };

  // --- Disponibilidade -------------------------------------------------------

  function navegacaoMes(mes) {
    return `<div class="nav-mes"><button class="botao" data-mes="${mesAnterior(mes)}">‹</button><strong>${esc(nomeDoMes(mes))}</strong><button class="botao" data-mes="${mesSeguinte(mes)}">›</button>
      <button class="link" data-mes="${hoje().slice(0, 7)}">hoje</button></div>`;
  }
  const ligarNavegacaoMes = () => $$('[data-mes]').forEach((b) => b.addEventListener('click', () => { estado.mesGestao = b.dataset.mes; rotear(); }));

  paginas.disponibilidade = async () => {
    if (!ehGestor()) { location.hash = '#/calendario'; return; }
    const mes = estado.mesGestao;
    const d = await api(`/api/disponibilidade?mes=${mes}`);
    const diasMes = d.tecnicos[0]?.dias ?? [];
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Disponibilidade</h1><p>Presença de cada técnico por dia. Sem lançamento = Presente. Clique num dia para lançar férias, atestado, folga...</p></div>${navegacaoMes(mes)}</div>
      ${d.tecnicos.length ? `<div class="cartao"><div class="tabela-envolve"><table class="grade-disp">
        <thead><tr><th>Técnico</th>${diasMes.map((x) => `<th class="${x.util ? '' : 'fechado'}" title="${esc(x.feriado ?? x.motivo ?? '')}">${x.dia.slice(8)}<br><small>${nomeDoDia(x.dia).slice(0, 3)}</small></th>`).join('')}<th class="num">Disponib.</th><th class="num">Meta</th></tr></thead>
        <tbody>${d.tecnicos.map((t) => `<tr><td>${esc(t.nome)}</td>${t.dias.map((x) => (x.util
      ? `<td class="cel ${CLASSE[x.status] ?? ''} ${x.registro ? 'lancado' : ''}" data-tecnico="${esc(t.id)}" data-dia="${x.dia}" title="${esc(`${x.status}${x.fracao > 0 && x.fracao < 1 ? ` (${percentual(x.fracao)})` : ''}${x.registro?.observacao ? ` · ${x.registro.observacao}` : ''}${x.meta != null ? ` · meta ${num(x.meta, 1)}` : ''} · realizado ${x.realizado}`)}">${SIGLA[x.status] ?? ''}</td>`
      : `<td class="cel fechado" title="${esc(x.feriado ?? x.motivo ?? '')}">${x.feriado ? '★' : ''}</td>`)).join('')}
          <td class="num">${percentual(t.disponibilidade)}</td><td class="num">${num(t.meta, 0)}</td></tr>`).join('')}</tbody></table></div>
        <div class="legenda-disp">${d.status.map((s) => `<span class="etiqueta disp-${CLASSE[s] ?? ''}">${SIGLA[s]} = ${esc(s)}</span>`).join(' ')} <span class="etiqueta neutro">★ = feriado</span></div></div>`
    : '<div class="cartao"><p class="vazio">Nenhum técnico na equipe. Marque-os em <a href="#/equipe">Técnicos</a>.</p></div>'}`;
    ligarNavegacaoMes();
    $$('.cel[data-dia]').forEach((td) => td.addEventListener('click', () => {
      const t = d.tecnicos.find((x) => x.id === td.dataset.tecnico);
      const x = t.dias.find((y) => y.dia === td.dataset.dia);
      const reg = x.registro;
      abrirDialogo(`<h2>${esc(t.nome)} · ${diaLongo(x.dia)}</h2>
        <label>Status<select name="status" id="disp-status">${d.status.map((s) => `<option ${s === (reg?.status ?? 'Presente') ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
        <div class="linha-2"><label>De<input type="date" name="de" value="${x.dia}" required></label><label>Até<input type="date" name="ate" value="${x.dia}"><small>Para períodos (ex.: férias), só os dias úteis recebem o lançamento.</small></label></div>
        <div class="linha-2" id="disp-horario"><label>Ausente das<input name="hora_inicio_ausencia" placeholder="09:00" value="${esc(reg?.hora_inicio_ausencia ?? '')}"></label><label>até<input name="hora_fim_ausencia" placeholder="10:30" value="${esc(reg?.hora_fim_ausencia ?? '')}"></label></div>
        <p class="nota" id="disp-dica">Atestado, banco de horas e treinamento podem ser de parte do dia: informe o horário e a disponibilidade é calculada pela jornada.</p>
        <label>Meta só deste dia (opcional)<input type="number" name="meta_do_dia" min="0" step="0.5" value="${reg?.meta_do_dia ?? ''}"></label>
        <label>Observação<input name="observacao" maxlength="300" value="${esc(reg?.observacao ?? '')}"></label>
        ${reg ? '<p><button type="button" class="link" id="disp-remover">Remover lançamento (volta a Presente)</button></p>' : ''}`,
      async (dados) => {
        const r = await api('/api/disponibilidade', { method: 'POST', body: { ...dados, tecnico_id: t.id } });
        aviso(`Lançado em ${num(r.dias)} dia(s) · disponibilidade ${percentual(r.fracao)}.`);
        rotear();
      });
      const atualizarHorario = () => { $('#disp-horario').hidden = !d.parciais.includes($('#disp-status').value); $('#disp-dica').hidden = $('#disp-horario').hidden; };
      $('#disp-status').addEventListener('change', atualizarHorario);
      atualizarHorario();
      $('#disp-remover')?.addEventListener('click', async () => {
        try {
          await api('/api/disponibilidade/remover', { method: 'POST', body: { tecnico_id: t.id, de: x.dia } });
          $('#dialogo').close();
          aviso('Lançamento removido.');
          rotear();
        } catch (err) { $('#erro-dialogo').textContent = err.message; }
      });
    }));
  };

  // --- Calendário ------------------------------------------------------------

  paginas.calendario = async () => {
    const mes = estado.mesGestao;
    const d = await api(`/api/calendario?mes=${mes}`);
    const primeiro = new Date(`${mes}-01T12:00:00Z`).getUTCDay();
    const vazios = (primeiro + 6) % 7; // semana começa na segunda
    const hojeIso = hoje();
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Calendário</h1><p>Feriados, ausências e trocas de escala ${ehGestor() ? 'da equipe' : 'seus'} no mês.</p></div>${navegacaoMes(mes)}</div>
      <div class="cartao"><div class="calendario">
        ${['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((n) => `<div class="cal-cabeca">${n}</div>`).join('')}
        ${'<div class="cal-dia vazio"></div>'.repeat(vazios)}
        ${d.dias.map((x) => `<div class="cal-dia ${x.util ? '' : 'fechado'} ${x.dia === hojeIso ? 'hoje' : ''}">
          <div class="cal-num">${Number(x.dia.slice(8))}${x.util && x.equipe ? `<small>${num(x.disponiveis, Number.isInteger(x.disponiveis) ? 0 : 1)}/${x.equipe}</small>` : ''}</div>
          ${x.feriado ? `<div class="chip feriado ${x.feriado.tipo === 'facultativo' ? 'facultativo' : ''}" title="${esc(x.feriado.tipo)}">${esc(x.feriado.descricao)}</div>` : ''}
          ${x.ausentes.map((a) => `<div class="chip disp-${CLASSE[a.status] ?? ''}" title="${esc(`${a.tecnico}: ${a.status}${a.fracao > 0 ? ` (${percentual(a.fracao)} disponível)` : ''}${a.observacao ? ` · ${a.observacao}` : ''}`)}">${esc(a.tecnico.split(' ')[0])} · ${esc(SIGLA[a.status] ?? a.status)}</div>`).join('')}
          ${x.trocas.map((tr) => `<div class="chip escala" title="Escala a partir deste dia">${esc(tr.tecnico.split(' ')[0])} → ${esc(tr.escala)}</div>`).join('')}
        </div>`).join('')}
      </div>
      <p class="nota">Nos dias úteis, o número no canto é quantos técnicos estão disponíveis (ausência parcial conta proporcionalmente). Feriado facultativo aparece em amarelo e conta como dia útil.</p></div>`;
    ligarNavegacaoMes();
  };

  // --- Escalas ---------------------------------------------------------------

  paginas.escalas = async () => {
    if (!ehGestor()) { location.hash = '#/calendario'; return; }
    const d = await api('/api/escalas');
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Escalas</h1><p>Horários de trabalho e a escala de cada técnico, com histórico.</p></div><div class="filtros"><button class="botao primario" id="nova-escala">Nova escala</button></div></div>
      <div class="grade-2-iguais">
        <div class="cartao"><h2>Escalas cadastradas</h2><table><thead><tr><th>Escala</th><th>Horário</th><th class="num">Técnicos</th><th>Situação</th><th></th></tr></thead>
          <tbody>${d.escalas.map((e) => `<tr><td>${esc(e.nome)}</td><td>${esc(e.hora_inicio)} – ${esc(e.hora_fim)}</td><td class="num">${num(e.tecnicos)}</td>
            <td><span class="etiqueta ${e.ativo ? 'ok' : 'neutro'}">${e.ativo ? 'ativa' : 'inativa'}</span></td><td><button class="botao" data-editar-escala="${e.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>
        <div class="cartao"><h2>Atribuir escala</h2>
          <form id="form-atribuir" class="form-coluna">
            <label>Técnico<select name="tecnico_id" required><option value="">Escolha...</option>${d.equipe.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></label>
            <label>Escala<select name="escala_id" required>${d.escalas.filter((e) => e.ativo).map((e) => `<option value="${e.id}">${esc(e.nome)} (${esc(e.hora_inicio)}–${esc(e.hora_fim)})</option>`).join('')}</select></label>
            <label>A partir de<input type="date" name="desde" value="${hoje()}" required></label>
            <label>Motivo (opcional)<input name="motivo" maxlength="200" placeholder="Troca de turno, pedido do técnico..."></label>
            <p class="erro" id="erro-atribuir"></p>
            <button class="botao primario">Atribuir</button>
          </form>
          <p class="nota">A escala anterior termina na véspera, e o histórico fica guardado.</p></div>
      </div>
      <div class="cartao grade-espaco"><h2>Histórico por técnico</h2>${d.atribuicoes.length ? `<div class="tabela-envolve"><table>
        <thead><tr><th>Técnico</th><th>Escala</th><th>Horário</th><th>De</th><th>Até</th><th>Motivo</th><th></th></tr></thead>
        <tbody>${d.atribuicoes.map((a) => `<tr><td>${esc(a.tecnico)}</td><td>${esc(a.escala)}</td><td>${esc(a.hora_inicio)}–${esc(a.hora_fim)}</td><td>${diaLongo(a.desde)}</td>
          <td>${a.ate ? diaLongo(a.ate) : '<span class="etiqueta ok">vigente</span>'}</td><td>${esc(a.motivo ?? '')}</td><td><button class="link" data-remover-atribuicao="${a.id}">remover</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Nenhuma escala atribuída ainda.</p>'}</div>`;
    const editar = (e = {}) => abrirDialogo(`<h2>${e.id ? 'Editar escala' : 'Nova escala'}</h2>
      <label>Nome<input name="nome" required value="${esc(e.nome ?? '')}"></label>
      <div class="linha-2"><label>Início<input type="time" name="hora_inicio" required value="${esc(e.hora_inicio ?? '08:00')}"></label><label>Fim<input type="time" name="hora_fim" required value="${esc(e.hora_fim ?? '16:42')}"></label></div>
      <label class="opcao"><input type="checkbox" name="ativo" value="1" ${e.ativo === 0 ? '' : 'checked'}> Ativa</label>`,
    async (dados) => { await api('/api/escalas', { method: 'POST', body: { ...dados, id: e.id, ativo: dados.ativo === '1' } }); aviso('Escala salva.'); rotear(); });
    $('#nova-escala').addEventListener('click', () => editar());
    $$('[data-editar-escala]').forEach((b) => b.addEventListener('click', () => editar(d.escalas.find((e) => e.id === Number(b.dataset.editarEscala)))));
    $('#form-atribuir').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/escalas/atribuir', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        aviso('Escala atribuída.');
        rotear();
      } catch (err) { $('#erro-atribuir').textContent = err.message; }
    });
    $$('[data-remover-atribuicao]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remover esta atribuição de escala?')) return;
      try { await api(`/api/escalas/atribuicoes/${b.dataset.removerAtribuicao}/remover`, { method: 'POST', body: {} }); rotear(); } catch (err) { aviso(err.message, true); }
    }));
  };

  // --- Metas por período -----------------------------------------------------

  paginas.metas = async () => {
    if (!ehGestor()) { location.hash = '#/individual'; return; }
    const d = await api('/api/metas');
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Metas por período</h1><p>Meta diária de atendimentos (chat + voz). Vale a partir da data informada, até a próxima meta. No dia, é proporcional à disponibilidade.</p></div></div>
      <div class="grade-2-iguais">
        <div class="cartao"><h2>Meta de cada técnico</h2>${d.equipe.length ? `<table><thead><tr><th>Técnico</th><th class="num">Vigente</th><th>Desde</th><th>Próxima</th><th class="num">Padrão</th></tr></thead>
          <tbody>${d.equipe.map((t) => `<tr><td>${esc(t.nome)}</td><td class="num"><strong>${num(t.vigente?.meta ?? t.meta_padrao, 1)}</strong></td><td>${t.vigente ? diaLongo(t.vigente.desde) : t.meta_padrao != null ? '<small>meta padrão</small>' : '<span class="etiqueta pendente">sem meta</span>'}</td>
            <td>${t.proxima ? `${num(t.proxima.meta, 1)} em ${diaLongo(t.proxima.desde)}` : '—'}</td><td class="num">${num(t.meta_padrao, 1)}</td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Nenhum técnico na equipe.</p>'}</div>
        <div class="cartao"><h2>Definir meta</h2>
          <form id="form-meta" class="form-coluna">
            <label>Para<select name="tecnico_id" required><option value="equipe">Toda a equipe</option>${d.equipe.map((t) => `<option value="${esc(t.id)}">${esc(t.nome)}</option>`).join('')}</select></label>
            <label>A partir de<input type="date" name="desde" value="${inicioDoMes()}" required></label>
            <label>Meta diária (atendimentos por dia útil)<input type="number" name="meta" min="0" step="0.5" required></label>
            <label>Observação (opcional)<input name="observacao" maxlength="200" placeholder="Ex.: período de implantação"></label>
            <p class="erro" id="erro-meta"></p>
            <button class="botao primario">Salvar meta</button>
          </form>
          <p class="nota">Referência atual: no último mês a equipe fez, por técnico, a média que aparece no <a href="#/dash-tecnicos">Dashboard Técnicos</a> (coluna "Por dia disp.").</p></div>
      </div>
      <div class="cartao grade-espaco"><h2>Histórico de metas</h2>${d.historico.length ? `<div class="tabela-envolve"><table>
        <thead><tr><th>Técnico</th><th>A partir de</th><th class="num">Meta diária</th><th>Observação</th><th></th></tr></thead>
        <tbody>${d.historico.map((m) => `<tr><td>${esc(m.tecnico)}</td><td>${diaLongo(m.desde)}</td><td class="num">${num(m.meta, 1)}</td><td>${esc(m.observacao ?? '')}</td><td><button class="link" data-remover-meta="${m.id}">remover</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="vazio">Nenhuma meta cadastrada.</p>'}</div>`;
    $('#form-meta').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('/api/metas', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
        aviso(`Meta salva para ${num(r.tecnicos)} técnico(s).`);
        rotear();
      } catch (err) { $('#erro-meta').textContent = err.message; }
    });
    $$('[data-remover-meta]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remover esta meta?')) return;
      try { await api(`/api/metas/${b.dataset.removerMeta}/remover`, { method: 'POST', body: {} }); rotear(); } catch (err) { aviso(err.message, true); }
    }));
  };

  // --- Feriados --------------------------------------------------------------

  paginas.feriados = async () => {
    if (!ehGestor()) { location.hash = '#/calendario'; return; }
    const ano = estado.anoFeriados ?? hoje().slice(0, 4);
    const d = await api(`/api/feriados?ano=${ano}`);
    const anos = [...new Set([...d.anos, ano, String(Number(ano) + 1)])].sort();
    pagina.innerHTML = `<div class="cabecalho"><div><h1>Feriados</h1><p>Feriados ativos (exceto facultativos) não são dias úteis: sem meta e fora da disponibilidade.</p></div>
        <div class="filtros"><label>Ano<select id="ano-feriado">${anos.map((a) => `<option ${a === ano ? 'selected' : ''}>${a}</option>`).join('')}</select></label><button class="botao primario" id="novo-feriado">Novo feriado</button></div></div>
      <div class="cartao">${d.itens.length ? `<table><thead><tr><th>Data</th><th>Dia</th><th>Feriado</th><th>Tipo</th><th>Situação</th><th></th></tr></thead>
        <tbody>${d.itens.map((f) => `<tr><td>${diaLongo(f.dia)}</td><td>${nomeDoDia(f.dia)}</td><td>${esc(f.descricao)}</td><td>${esc(f.tipo)}</td>
          <td><span class="etiqueta ${f.ativo ? 'ok' : 'neutro'}">${f.ativo ? 'ativo' : 'inativo'}</span></td>
          <td><button class="botao" data-editar-feriado="${f.dia}">Editar</button> <button class="link" data-remover-feriado="${f.dia}">remover</button></td></tr>`).join('')}</tbody></table>` : '<p class="vazio">Nenhum feriado neste ano.</p>'}
        <p class="nota">Os feriados nacionais de 2024 a 2028 vieram da Base Bruno. Inclua os estaduais e municipais da sua cidade e os dias de folga da empresa.</p></div>`;
    $('#ano-feriado').addEventListener('change', (e) => { estado.anoFeriados = e.target.value; rotear(); });
    const editar = (f = {}) => abrirDialogo(`<h2>${f.dia ? 'Editar feriado' : 'Novo feriado'}</h2>
      <label>Data<input type="date" name="dia" required value="${esc(f.dia ?? '')}"></label>
      <label>Descrição<input name="descricao" required maxlength="120" value="${esc(f.descricao ?? '')}"></label>
      <label>Tipo<select name="tipo">${d.tipos.map((t) => `<option ${t === (f.tipo ?? 'municipal') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label class="opcao"><input type="checkbox" name="ativo" value="1" ${f.ativo === 0 ? '' : 'checked'}> Ativo</label>`,
    async (dados) => { await api('/api/feriados', { method: 'POST', body: { ...dados, ativo: dados.ativo === '1', dia_original: f.dia } }); aviso('Feriado salvo.'); rotear(); });
    $('#novo-feriado').addEventListener('click', () => editar());
    $$('[data-editar-feriado]').forEach((b) => b.addEventListener('click', () => editar(d.itens.find((f) => f.dia === b.dataset.editarFeriado))));
    $$('[data-remover-feriado]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remover este feriado?')) return;
      try { await api(`/api/feriados/${b.dataset.removerFeriado}/remover`, { method: 'POST', body: {} }); rotear(); } catch (err) { aviso(err.message, true); }
    }));
  };
}
