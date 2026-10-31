# Tek Ponto - Suporte Gestão

Plataforma de gestão dos atendimentos do **Suporte de Ponto Eletrônico da Tek Norte** no Digisac:
sincroniza chamados e conversas pela API, calcula indicadores de produtividade por técnico,
permite consultar as conversas e usa IA (Claude) para sugerir sentimento, sinais de insatisfação
e nota de qualidade — **sempre sujeitos à revisão da coordenação**.

Node.js 22.5+ (testado no 24), SQLite embutido (`node:sqlite`), sem Docker e sem banco externo.
Dependências: `@anthropic-ai/sdk` e `chart.js` (copiado para `web/vendor/`). IA local: Ollama portátil em `.tools/` (fora do versionamento).

## Como usar

```bash
npm install
copy .env.exemplo .env          # preencha DIGISAC_URL, DIGISAC_TOKEN e ANTHROPIC_API_KEY
npm run usuario -- --admin      # cria o primeiro administrador (pede e-mail, nome e senha)
npm start                       # ou dê dois cliques em painel.cmd → http://localhost:4250
```

Com o Digisac configurado, o servidor sincroniza 5 s após subir e depois a cada
`SINCRONIZAR_A_CADA_MINUTOS`. Também dá para sincronizar pela tela **Sincronização e conferência**
ou por linha de comando (`npm run sincronizar`, `npm run sincronizar:completo`). Para agendar sem
deixar o painel aberto, aponte o Agendador de Tarefas do Windows para `sincronizar.cmd`.

**Só quer ver a interface?** `npm run demo` gera ~580 chamados fictícios e um usuário
`demo@tekponto.local` (a senha aparece no terminal). Remova com `npm run demo -- --limpar`
antes de ligar o Digisac — enquanto houver dados de demonstração, uma faixa amarela avisa.

Testes: `npm test`.

## Telas

| Tela | Quem vê | O que tem |
|---|---|---|
| Dashboard Geral | todos | KPIs do chat e da voz, chamados por dia, sentimento, mapa de calor, assuntos, técnicos, motivos de insatisfação |
| Dashboard Técnicos | coordenação | por técnico: escala, disponibilidade, meta, chat, voz, realizado, atingimento, TMA voz, pausas, 1ª resposta, CSAT, qualidade |
| Dashboard Individual | todos (técnico vê só a si) | KPIs do técnico, dia a dia (chat + voz × meta), faixa de presença, pausas, ausências, atendimentos |
| Dashboard Gestão | coordenação | meta da equipe, projeção do período, disponibilidade, nível de serviço da voz, IA a revisar, semana a semana, alertas, ranking, absenteísmo |
| Rankings | coordenação | Ranking Digisac (chamados, encerrados, 1ª resposta, TMA, CSAT com 3+ respostas, qualidade IA) e Ranking de ligações (ligações, tempo em conversa, TMA, espera, pausas); ordena por qualquer critério, top 3 destacado; versão resumida no Dashboard Gestão. Função **Apoio** não entra (`FUNCOES_FORA_DO_RANKING` em `src/rotas-gestao.mjs`) |
| Conversas | todos (técnico vê só as suas) | busca (inclui o que foi falado nos áudios), conversa com áudio/vídeo/imagem |
| GoTo / Voz | coordenação | fila Ponto Eletrônico: ligações, TME, nível de serviço (≤ 20 s), TMA, por dia, por hora, por atendente, pausas |
| Análise de chamadas | coordenação | cada ligação com espera e duração, faixas de TMA e de espera, filtros, CSV |
| Revisão da IA | coordenação | fila de análises pendentes; aprovar (uma ou várias), ajustar ou descartar |
| Técnicos | coordenação | cadastro da equipe: na equipe, situação, matrícula, função, admissão, jornada, meta padrão, atendente na GoTo |
| Disponibilidade | coordenação | grade mês × técnico; lança férias, atestado, folga, banco de horas (parcial por horário) |
| Calendário | todos (técnico vê só as suas ausências) | feriados, ausências, trocas de escala e técnicos disponíveis por dia |
| Escalas | coordenação | horários de trabalho e escala de cada técnico com vigência e histórico |
| Metas por período | coordenação | meta diária a partir de uma data (por técnico ou toda a equipe), histórico |
| Feriados | coordenação | por ano; tipos nacional, estadual, municipal, facultativo, empresa |
| Sincronização e conferência | coordenação | status, histórico de execuções, conferência com a estatística oficial do Digisac |
| Usuários / Auditoria | administrador | contas, perfis, vínculo com o técnico do Digisac; trilha de auditoria |

## Gestão da equipe e voz (GoTo)

`src/base-goto.mjs`, `src/gestao.mjs`, `src/rotas-gestao.mjs`, `web/gestao.js`. O modelo veio da
**Base Bruno** (`BASE_GOTO_PASTA`), o banco SQLite do sistema de gestão das outras áreas, que
recebe as ligações da API da GoTo. O arquivo mais recente da pasta é aberto **só para leitura** e
reimportado sozinho a cada ciclo quando muda (ou em GoTo/Voz > Reimportar; `node src/base-goto.mjs`).

- **Importado**: ligações da fila `BASE_GOTO_FILA` (Ponto Eletrônico; espera = `time_in_queue_ms`,
  TMA = conversa + pós), pausas dos atendentes dessa fila, as 4 escalas-padrão e os feriados
  (2024–2028). Escalas e feriados só completam o que falta: edições feitas aqui prevalecem.
- **Não importado, de propósito**: salários, senhas, feedbacks de RH, atrasos e os dados de
  AT/Fiscal/Folha. **Abandonos** também não: na base eles não indicam a fila (os sem área misturam
  Ponto, Administrativo e Legal One). A base não tem ligações do Ponto em agosto/2026; a tela avisa
  dias úteis sem nenhuma ligação.
- **Vínculo GoTo ↔ Digisac**: pelo nome (mesmo primeiro nome e todas as partes do nome mais curto
  no mais longo, sem acento: "Carlos Souza" = "Carlos Eduardo Lima Souza"). Os 6 técnicos foram
  ligados automaticamente; corrija em Técnicos. O vínculo é aplicado na consulta (não exige reimportar).
- **Dia útil**: segunda a sexta que não é feriado ativo. Feriado **facultativo** conta como útil.
- **Disponibilidade**: sem lançamento = Presente (100%). Meio período = 50%; férias, folga, DayOff,
  ausente = 0. Atestado, banco de horas e treinamento podem ser parciais: com horário, fração =
  1 − horas ausentes ÷ jornada (padrão 7h12, como na Base Bruno; 1h30 → 79%). Um período (ex.:
  férias) é lançado só nos dias úteis.
- **Meta do dia** = meta do dia lançada na disponibilidade, ou meta vigente (Metas por período; senão a
  meta padrão do técnico) × fração disponível. **Sem meta cadastrada, não há atingimento** (não
  inventamos meta). Antes da data de admissão não há meta.
- **Produção (realizado)** = chamados do Digisac **encerrados** no dia com mensagem do cliente
  (departamentos monitorados) + ligações atendidas na fila do Ponto. (O Dashboard Geral continua
  contando chamados pela data de **abertura**; por isso os números podem diferir.)
- **Projeção** (Dashboard Gestão): realizado + ritmo médio dos dias úteis passados × dias úteis restantes.
- **Alertas**: atingimento < 80% ou disponibilidade < 70% dos dias úteis (com 5+ dias úteis).
- **Permissões/LGPD**: tudo que grava é da coordenação e vai para a auditoria. O técnico vê o próprio
  dashboard e, no calendário, só as próprias ausências (a observação de atestado só a coordenação vê).

## Como cada indicador é calculado

As regras estão em `src/indicadores.mjs` e cobertas por `test/regras.test.mjs`.

- **Período**: pela data de **abertura** do chamado, em horário de Brasília.
- **1ª resposta (TME)**: tempo que o cliente esperou por um humano. Começa na última mensagem do
  robô (menu) antes do técnico — ou na 1ª mensagem do cliente, se não houve robô — e termina na
  1ª mensagem de um técnico. Comentários internos, reações e mensagens do sistema não contam.
  Contato ativo (técnico escreveu primeiro) e chamado sem resposta humana ficam vazios (não zero).
  Validado em 29/10/2026: Suporte Resolutivo, outubro, 336 s aqui × 333 s no Digisac.
- **Duração (TMA)**: do início ao encerramento; só chamados encerrados.
- **Técnico do chamado**: o `userId` atual do chamado no Digisac (quem estava com ele por último).
  Transferências são contadas, mas o chamado não é rateado entre técnicos.
- **CSAT**: média das notas 1–5 **dadas pelos clientes** na pesquisa do Digisac (`/answers`).
  O `/answers` também traz notas que a IA do próprio Digisac gera sozinha (`aiGenerated: true`,
  bem mais severas); elas ficam separadas (`origem = 'ia_digisac'`), aparecem como referência no
  KPI e na conversa, mas **não entram no CSAT**. Notas inválidas (`-1`, `no_human_context`) são ignoradas.
- **Sentimento, nota de qualidade e motivos**: só entram análises **aprovadas ou ajustadas** por
  uma pessoa. Valores ajustados substituem os da IA. Pendentes aparecem à parte.
- **Sinais de insatisfação**: análises da IA (pendentes ou revisadas, exceto descartadas) que
  marcaram insatisfação — é uma fila de atenção, não um indicador de desempenho.
- **Departamentos**: só os marcados em **Sincronização e conferência > Departamentos monitorados**
  (vários; a escolha da tela prevalece sobre `DIGISAC_DEPARTAMENTOS` do .env). Os filtros do painel
  também aceitam vários departamentos. `npm run departamentos` lista os do Digisac.

### Validação contra o Digisac

Em **Sincronização e conferência > Conferir indicadores**, o sistema calcula os números locais e
consulta `GET /api/v1/dashboard/general` no mesmo período, mostrando os dois lado a lado (cada
conferência fica registrada). Divergência na contagem de chamados indica sincronização incompleta
(rode a ressincronização). As **médias de tempo do Digisac dividem pelo total de chamados,
inclusive os abertos** (verificado: Implantação, 81.875 s ÷ 48 = 1.706 s), por isso a duração média
de lá é menor que a nossa, que considera só encerrados. Por chamado, a duração bate com
`metrics.ticketTime`. A conferência consulta cada departamento monitorado e soma as contagens.

## Inteligência Artificial

`src/ia.mjs`. Para cada chamado **encerrado** com mensagens do cliente, envia a transcrição a um
modelo e recebe JSON validado por esquema: sentimento, intensidade, insatisfação, motivos (lista
fechada), nota 0–10, cinco critérios (cordialidade, clareza, resolução, agilidade, procedimento),
resumo, pontos de melhoria, evidências literais e confiança. O prompt instrui a não penalizar o
técnico por fatores fora do controle dele e a baixar a confiança em conversas curtas ou ambíguas.

### Provedores (`IA_PROVEDOR`)

- **`groq` (padrão, gratuito, na nuvem)**: [Groq](https://console.groq.com), API no formato
  OpenAI, modelo aberto `openai/gpt-oss-120b`. Todo o processamento é lá: aqui é só uma chamada
  HTTP, e cada análise leva segundos. A chamada sai do servidor do painel (a chave fica no
  `.env`, nunca no navegador), então a análise automática funciona com o painel fechado.
  Plano gratuito: ~1.000 pedidos e ~200 mil tokens por dia por organização (~3 mil tokens por
  análise); ao bater o limite a fila para e retoma sozinha no ciclo seguinte. LGPD: os termos do
  Groq proíbem treinar modelos com os dados enviados; ligue **Zero Data Retention** em
  Settings > Data Controls. CPF, CNPJ, telefone e e-mail são mascarados antes do envio.
  (O Gemini gratuito foi descartado: o Google declara usar os dados do plano gratuito.)
- **Áudios e vídeos** (`src/transcricao.mjs`, `IA_TRANSCREVER_MIDIA=sim`): antes de cada análise,
  as mensagens `ptt`/`audio`/`video` do chamado são transcritas pelo Whisper do Groq
  (`whisper-large-v3-turbo`, português, plano gratuito: arquivos até 25 MB, ~8 h de áudio/dia).
  O arquivo vem do Digisac (link assinado buscado na hora), passa só pela memória e não é gravado;
  fica salvo apenas o texto, em `mensagens.transcricao` (apagado junto com a mensagem pela
  retenção). A transcrição entra na conversa da IA como "(áudio transcrito)", já mascarada, e
  aparece no balão da conversa como "Transcrição automática". Falha numa mídia não impede a
  análise (o motivo fica em `transcricao_erro`). Imagens não são analisadas.
  Medido: 3 áudios + 1 vídeo transcritos em 3,5 s.
- **Ouvir/ver na conversa**: áudios e vídeos têm player no balão, imagens aparecem em miniatura
  e documentos têm link para baixar (`GET /api/mensagens/:id/midia`). O arquivo continua no
  Digisac: o servidor busca o link assinado na hora (guardado 5 min), repassa o conteúdo com
  suporte a Range (avançar/voltar) e não grava nada. Mesmas permissões da conversa (técnico só
  as suas) e registro `ver_midia` na auditoria. Nada é baixado antes do play (`preload="none"`,
  imagens com `loading="lazy"`). Voz do WhatsApp (`audio/opus`) é entregue como `audio/ogg`.
- **`ollama` (gratuito, open source, local)**: [Ollama](https://ollama.com) (MIT) rodando nesta
  máquina, versão portátil em `.tools/ollama` (nada instalado no sistema), com o modelo
  **Qwen3** (Apache 2.0). A conversa **não sai do computador**. Suba com `ia-local.cmd`
  (porta 11434, só local) antes do painel. Modelos: `qwen3:14b` (padrão) ou `qwen3:8b`.
  Neste notebook (i5-1335U, sem GPU) o gargalo é o processador: o 14B lê ~7 tokens/s e escreve
  ~1,7 tokens/s. Por isso a conversa vai enxuta (sem `[ticket]`, reações e a nota da IA do
  Digisac; menu do robô em uma linha; mensagens cortadas em 400 caracteres), a resposta tem
  limite de tamanho, a janela de contexto é fixa em degraus (mudar a cada conversa recarrega o
  modelo). `IA_THREADS` define quantos núcleos a IA usa: medido no 14B, 2 núcleos = leitura
  5,0 / escrita 1,2 tokens/s; automático (6) = 6,2 / 1,6; 10 = 7,6 / 1,8. Em uso: 2, para não
  pesar no computador.
- **Automática ao fim de cada atendimento**: a sincronização roda a cada
  `SINCRONIZAR_A_CADA_MINUTOS` (padrão 2; a consulta incremental leva ~1 s) e cada chamado recém
  encerrado entra na fila da IA, na ordem de encerramento. **Sem retroativo**: só entram chamados
  encerrados depois que a análise automática foi ligada (data gravada no banco em
  `estado.ia_analisar_desde`). A IA tem fila própria, separada da sincronização (que não espera
  por ela). "Analisar agora" na conversa fura a fila — serve também para um chamado antigo; a
  tela mostra "na fila"/"analisando" e atualiza sozinha.
  Em 15 conversas reais (out/2026) o 14B acertou 9 de 10 contra a nota do cliente, e o 8B 8 de 10.
  CSAT 1 não serve de referência: há 29 notas 1 contra 2 notas 2, e a maioria é de cliente que
  agradeceu e foi atendido (escala lida ao contrário).
- **`anthropic`**: Claude (`claude-opus-5-5`), pago e na nuvem; precisa de `ANTHROPIC_API_KEY`.
  Usa `fallbacks: "default"` (se o modelo recusar, a API tenta outro).

### Medindo a assertividade

- `npm run comparar-ia -- --modelos=qwen3:8b,qwen3:14b --n=10` roda os modelos nas mesmas conversas
  reais (sem gravar análises) e compara com a **nota que o próprio cliente deu**: CSAT 1–2 deve gerar
  insatisfação/negativo, CSAT 5 não. Gera `dados/comparacao-ia-AAAA-MM-DD.html`.
- Na tela **Revisão da IA**, o placar por modelo mostra quanto a coordenação aprovou sem ajuste.

### Revisão humana e rastreabilidade

- Toda análise nasce `pendente`. Ajustar ou descartar exige justificativa; tudo vai para a
  auditoria com o valor anterior. Técnicos só veem avaliações já revisadas. Uma análise revisada
  não é sobrescrita (é preciso reabrir a revisão).
- Cada análise guarda modelo (`ollama/qwen3:14b`, `claude-opus-5-5`...), versão do prompt e data.
- Falhas (JSON inválido, conversa longa demais, Ollama parado) ficam em `erros_ia` e são tentadas
  de novo após 1 dia; a tela da conversa mostra o motivo.

## Segurança e LGPD

- **Acesso**: login próprio (scrypt), sessão em cookie `HttpOnly; SameSite=Strict`, bloqueio após 5
  senhas erradas em 15 min, senha mínima de 10 caracteres. Por padrão o servidor só escuta em
  `127.0.0.1`; para abrir na rede interna use `HOST=0.0.0.0` (e de preferência um proxy com HTTPS).
- **Perfis**: administrador, coordenação, técnico (vê só os próprios atendimentos).
- **Auditoria**: login (inclusive falhas), abertura de cada conversa, revisões da IA, exportações,
  conferências, sincronizações manuais e alterações de usuários (tela Auditoria).
- **Minimização para a IA**: antes de enviar, CPF, CNPJ, telefones e e-mails são mascarados
  (`mascarar()` em `src/ia.mjs`) e o nome do cliente não é enviado — só os papéis
  (CLIENTE/TÉCNICO/ROBÔ). Pela política comercial da Anthropic, dados da API não são usados para
  treinar modelos; confirme o enquadramento com o encarregado de dados (DPO) da Tek Norte.
- **Retenção**: o texto das conversas é apagado do banco local após `RETENCAO_MENSAGENS_DIAS`;
  métricas e análises permanecem.
- **Segredos** ficam só no `.env` (fora do versionamento). Cabeçalhos CSP, `X-Frame-Options` e
  `nosniff` em todas as respostas.

## Integração Digisac

Referência: <https://documenter.getpostman.com/view/24605757/2sA3BhfaDg>. Cliente em `src/digisac.mjs`.

| Uso | Endpoint |
|---|---|
| Autenticação | token pessoal (Bearer) ou `POST /api/v1/oauth/token` (grant `password`) |
| Técnicos / departamentos | `GET /api/v1/users`, `GET /api/v1/departments` |
| Chamados (incremental por `updatedAt`) | `GET /api/v1/tickets?query={where, include: contact, ticketTopics, ticketTransfers}` |
| Mensagens | `GET /api/v1/messages?query={where: {ticketId}}` |
| Pesquisa de satisfação | `GET /api/v1/answers` |
| Conferência | `GET /api/v1/dashboard/general` |

Listagens usam `?query=` (JSON estilo Sequelize) com `page`/`perPage`; o cliente aceita resposta
`{data, lastPage}` ou array, repete em 429/5xx com espera e renova o token OAuth em 401.

**A documentação do Digisac não traz exemplos de resposta.** Os campos usados
(`isFromMe`, `isFromBot`, `isComment`, `userId`, `startedAt`, `endedAt`, `ticketTopics`, e o valor da
nota em `/answers`) foram inferidos das consultas da própria coleção. Na primeira sincronização real,
confira na tela de uma conversa se cliente/técnico/robô aparecem nos lugares certos e se as notas de
CSAT batem com o Digisac. O JSON original de cada chamado fica em `chamados.bruto` para ajustes.

## Estrutura

```
src/config.mjs       .env e padrões
src/db.mjs           esquema SQLite, auditoria
src/digisac.mjs      cliente da API Digisac
src/sync.mjs         sincronização incremental, retenção
src/indicadores.mjs  regras de cálculo e agregações
src/ia.mjs           análise com Claude, mascaramento LGPD
src/auth.mjs         senhas, sessões, perfis
src/server.mjs       API HTTP + arquivos da interface
src/usuario.mjs      cria/redefine usuário pela linha de comando
src/demo.mjs         dados fictícios
web/                 interface (HTML/CSS/JS sem framework)
test/                testes (node --test)
```
