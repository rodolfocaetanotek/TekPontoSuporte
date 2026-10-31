// Testes das regras que definem os indicadores e a proteção de dados.
// Usa um banco temporário para não tocar em dados/tek-ponto.db.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.ARQUIVO_BANCO = path.join(mkdtempSync(path.join(tmpdir(), 'tekponto-')), 'teste.db');
process.env.DIGISAC_URL = '';
process.env.IA_HABILITADA = 'nao';
process.env.GROQ_API_KEY = 'chave-de-teste';

const { metricasDoChamado, mediana, painel } = await import('../src/indicadores.mjs');
const { mascarar, transcrever, consultarModelo, ErroPararFila } = await import('../src/ia.mjs');
const { transcreverArquivo } = await import('../src/transcricao.mjs');
const { autorDaMensagem, textoDaMensagem, gravarChamado, gravarMensagens } = await import('../src/sync.mjs');
const { db } = await import('../src/db.mjs');
const auth = await import('../src/auth.mjs');
const { gerarHash, conferirSenha, entrar } = auth;

const m = (autor, minuto) => ({ autor, quando: new Date(Date.UTC(2026, 9, 1, 12, minuto)).toISOString() });

test('primeira resposta ignora comentário interno e conta a partir do robô', () => {
  const r = metricasDoChamado({ aberto: 0, iniciado_em: m('x', 0).quando, encerrado_em: m('x', 40).quando },
    [m('cliente', 0), m('bot', 1), m('comentario', 3), m('cliente', 5), m('tecnico', 12), m('tecnico', 20)]);
  assert.equal(r.primeira_resposta_seg, 11 * 60);
  assert.equal(r.duracao_seg, 40 * 60);
  assert.deepEqual([r.msgs_cliente, r.msgs_tecnico, r.msgs_bot], [2, 2, 1]);
});

test('contato ativo (técnico escreveu antes do cliente) não tem primeira resposta', () => {
  const r = metricasDoChamado({ aberto: 1 }, [m('tecnico', 0), m('cliente', 10), m('tecnico', 15)]);
  assert.equal(r.primeira_resposta_seg, null);
  assert.equal(r.duracao_seg, null, 'chamado aberto não tem duração');
});

test('sem resposta humana, primeira resposta fica vazia (não zero)', () => {
  assert.equal(metricasDoChamado({ aberto: 1 }, [m('cliente', 0), m('bot', 1)]).primeira_resposta_seg, null);
});

test('mediana', () => {
  assert.equal(mediana([5, 1, 3]), 3);
  assert.equal(mediana([4, 1, 3, 2]), 2.5);
  assert.equal(mediana([null, undefined]), null);
});

test('classificação do autor das mensagens do Digisac', () => {
  assert.equal(autorDaMensagem({ isFromMe: false }), 'cliente');
  assert.equal(autorDaMensagem({ isFromMe: true, userId: 'u1' }), 'tecnico');
  assert.equal(autorDaMensagem({ isFromMe: true, isFromBot: true }), 'bot');
  assert.equal(autorDaMensagem({ isFromMe: true }), 'bot');
  assert.equal(autorDaMensagem({ isFromMe: true, userId: 'u1', isComment: true }), 'comentario');
  assert.equal(autorDaMensagem({ type: 'ticket' }), 'sistema');
  assert.equal(textoDaMensagem({ type: 'image', text: '' }), '[imagem]');
});

test('LGPD: dados pessoais são mascarados antes de ir para a IA', () => {
  const t = mascarar('CPF 123.456.789-09, CNPJ 12.345.678/0001-90, fone (43) 99876-5432, +55 43 3322-1100, mail joao.silva@empresa.com.br');
  assert.doesNotMatch(t, /\d{3}\.\d{3}|\d{4}-\d{4}|@/);
  assert.match(t, /\[CPF\].*\[CNPJ\].*\[TELEFONE\].*\[TELEFONE\].*\[EMAIL\]/);
  assert.equal(mascarar('Marcação das 08:00 às 17:48, matrícula 1234'), 'Marcação das 08:00 às 17:48, matrícula 1234');
  assert.equal(mascarar('CNPJ 11.222.333.0001-81'), 'CNPJ [CNPJ]'); // ponto no lugar da barra
});

test('transcrição identifica papéis e não usa o nome do cliente', () => {
  const t = transcrever([{ autor: 'cliente', quando: m('x', 0).quando, texto: 'oi' }, { autor: 'comentario', quando: m('x', 1).quando, texto: 'nota' }]);
  assert.match(t, /CLIENTE: oi/);
  assert.match(t, /COMENTÁRIO INTERNO: nota/);
});

test('IA recebe a conversa enxuta: sem [ticket], sem nota da IA do Digisac, menu do robô curto', () => {
  const t = transcrever([
    { autor: 'bot', quando: m('x', 0).quando, texto: 'Bem vindo(a) a Teknorte Sistemas, selecione uma das opções abaixo para ser redirecionado(a) para um departamento' },
    { autor: 'sistema', quando: m('x', 1).quando, texto: '[ticket]' },
    { autor: 'cliente', quando: m('x', 2).quando, texto: 'o ponto   bloqueou\n\nCNPJ 11.222.333.0001-81' },
    { autor: 'bot', tipo: 'ia-csat', quando: m('x', 3).quando, texto: '**Nota**: 5 - Muito satisfeito' },
  ]);
  assert.doesNotMatch(t, /\[ticket\]|Muito satisfeito|departamento/);
  assert.match(t, /ROBÔ: Bem vindo.{0,80}…/);
  assert.match(t, /CLIENTE: o ponto bloqueou CNPJ \[CNPJ\]/);
  assert.equal(t.match(/^--- /gm).length, 1); // data só uma vez
});

test('indicadores só usam análises da IA revisadas por pessoa', () => {
  db.prepare("INSERT INTO departamentos (id, nome, monitorado) VALUES ('d1', 'Suporte Ponto', 1)").run();
  db.prepare("INSERT INTO tecnicos (id, nome) VALUES ('u1', 'Técnico 1')").run();
  for (const [id, status] of [['t1', 'aprovada'], ['t2', 'pendente'], ['t3', 'descartada']]) {
    gravarChamado({ id, protocol: id, isOpen: false, departmentId: 'd1', userId: 'u1', startedAt: m('x', 0).quando, endedAt: m('x', 30).quando, updatedAt: m('x', 30).quando });
    gravarMensagens(id, [
      { id: `${id}a`, timestamp: m('x', 0).quando, text: 'ajuda', isFromMe: false },
      { id: `${id}b`, timestamp: m('x', 6).quando, text: 'olá', isFromMe: true, userId: 'u1' },
    ]);
    db.prepare(`INSERT INTO analises_ia (chamado_id, sentimento, insatisfacao, nota_qualidade, analisado_em, status)
      VALUES (?, 'negativo', 1, 3, ?, ?)`).run(id, m('x', 31).quando, status);
  }
  const r = painel({ de: m('x', -60).quando, ate: m('x', 60).quando }).resumo;
  assert.equal(r.chamados, 3);
  assert.equal(r.primeira_resposta_media_seg, 360);
  assert.equal(r.analises_revisadas, 1);
  assert.equal(r.analises_pendentes, 1);
  assert.equal(r.sentimento.negativo, 1);
  assert.equal(r.sinais_insatisfacao, 2, 'descartada não conta como sinal');
  assert.equal(r.nota_qualidade_media, 3);
});

test('departamento fora do monitoramento não entra nos indicadores', () => {
  db.prepare("INSERT INTO departamentos (id, nome, monitorado) VALUES ('d2', 'Comercial', 0)").run();
  gravarChamado({ id: 'x1', isOpen: true, departmentId: 'd2', startedAt: m('x', 1).quando, updatedAt: m('x', 1).quando });
  assert.equal(painel({ de: m('x', -60).quando, ate: m('x', 60).quando }).resumo.chamados, 3);
});

test('senha: hash scrypt e bloqueio após 5 tentativas', () => {
  const hash = gerarHash('senha-forte-123');
  assert.ok(conferirSenha('senha-forte-123', hash));
  assert.ok(!conferirSenha('outra', hash));
  db.prepare("INSERT INTO usuarios (email, nome, perfil, senha_hash) VALUES ('a@b.c', 'A', 'admin', ?)").run(hash);
  for (let i = 0; i < 5; i++) assert.ok(entrar('a@b.c', 'errada', '1.1.1.1').erro);
  assert.match(entrar('a@b.c', 'senha-forte-123', '1.1.1.1').erro, /Muitas tentativas/);
  assert.ok(entrar('a@b.c', 'senha-forte-123', '2.2.2.2').token);
});

test('primeira resposta começa quando o robô entrega o cliente ao departamento', () => {
  const r = metricasDoChamado({ aberto: 1 }, [m('cliente', 0), m('bot', 1), m('cliente', 2), m('bot', 3), m('cliente', 4), m('tecnico', 10)]);
  assert.equal(r.primeira_resposta_seg, 7 * 60, 'conta da última mensagem do robô (minuto 3), não do "bom dia" ao menu');
});

test('avaliações: separa resposta do cliente da nota gerada pela IA do Digisac', async () => {
  const { gravarAvaliacao } = await import('../src/sync.mjs');
  const tipos = new Map([['q1', 'csat']]);
  gravarAvaliacao({ id: 'v1', questionId: 'q1', ticketId: 't1', text: '5', aiGenerated: false }, tipos);
  gravarAvaliacao({ id: 'v2', questionId: 'q1', ticketId: 't1', text: '2', aiGenerated: true, aiText: 'motivo' }, tipos);
  gravarAvaliacao({ id: 'v3', questionId: 'q1', ticketId: 't1', text: '-1', aiGenerated: false }, tipos);
  gravarAvaliacao({ id: 'v4', questionId: 'q1', ticketId: 't1', text: 'no_human_context', aiGenerated: true }, tipos);
  const linhas = db.prepare("SELECT id, nota, origem, tipo FROM avaliacoes WHERE id LIKE 'v_' ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(linhas, [
    { id: 'v1', nota: 5, origem: 'cliente', tipo: 'csat' },
    { id: 'v2', nota: 2, origem: 'ia_digisac', tipo: 'csat' },
    { id: 'v3', nota: null, origem: 'cliente', tipo: 'csat' },
    { id: 'v4', nota: null, origem: 'ia_digisac', tipo: 'csat' },
  ]);
  assert.equal(painel({ de: m('x', -60).quando, ate: m('x', 60).quando }).resumo.csat_medio, 5, 'só o cliente conta no CSAT');
});

test('Groq: lê a análise em JSON e para a fila quando a cota diária acaba', async (t) => {
  const analise = { sentimento: 'negativo', intensidade: 0.7, insatisfacao: true, motivos: ['problema_nao_resolvido', 'inventado'],
    nota_qualidade: 4, criterios: { cordialidade: 8, clareza: 6, resolucao: 2, agilidade: 5, procedimento: 5 },
    resumo: 'Cobrança errada sem solução.', pontos_melhoria: [], evidencias: [], confianca: 0.8 };
  const pedidos = [];
  t.mock.method(globalThis, 'fetch', async (url, opcoes) => {
    pedidos.push({ url, corpo: JSON.parse(opcoes.body), chave: opcoes.headers.Authorization });
    return new Response(JSON.stringify({ model: 'openai/gpt-oss-120b', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(analise) } }] }));
  });
  const r = await consultarModelo('conversa', { provedor: 'groq', modelo: 'openai/gpt-oss-120b' });
  assert.equal(r.analise.sentimento, 'negativo');
  assert.deepEqual(r.analise.motivos, ['problema_nao_resolvido']); // motivo fora da lista é descartado
  assert.equal(r.modelo, 'groq/openai/gpt-oss-120b');
  assert.equal(pedidos[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(pedidos[0].chave, 'Bearer chave-de-teste');
  assert.equal(pedidos[0].corpo.response_format.type, 'json_schema');

  globalThis.fetch.mock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(consultarModelo('conversa', { provedor: 'groq', modelo: 'openai/gpt-oss-120b' }), ErroPararFila);
});

test('áudio transcrito entra na conversa da IA com o que foi falado (e mascarado)', () => {
  const t = transcrever([
    { autor: 'tecnico', tipo: 'ptt', quando: m('x', 0).quando, texto: '[áudio]', transcricao: 'Copie o horário. Meu telefone é (43) 99876-5432.' },
    { autor: 'cliente', tipo: 'ptt', quando: m('x', 1).quando, texto: '[áudio]' },
  ]);
  assert.ok(t.includes('TÉCNICO (áudio transcrito): Copie o horário. Meu telefone é [TELEFONE].'), t);
  assert.ok(t.includes('CLIENTE: [áudio]'), t); // sem transcrição: só o marcador
});

test('transcrição: envia o áudio ao Whisper do Groq em português e para a fila sem cota', async (t) => {
  let pedido;
  t.mock.method(globalThis, 'fetch', async (url, opcoes) => {
    pedido = { url, corpo: opcoes.body };
    return new Response(JSON.stringify({ text: ' Bom dia, tudo certo. ' }));
  });
  const texto = await transcreverArquivo(new ArrayBuffer(8), 'recording.oga', 'audio/opus');
  assert.equal(texto, 'Bom dia, tudo certo.');
  assert.equal(pedido.url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(pedido.corpo.get('language'), 'pt');
  assert.equal(pedido.corpo.get('model'), 'whisper-large-v3-turbo');
  assert.equal(pedido.corpo.get('file').name, 'midia.ogg'); // .oga do WhatsApp vira .ogg
  globalThis.fetch.mock.mockImplementation(async () => new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(transcreverArquivo(new ArrayBuffer(8), 'a.oga', 'audio/opus'), ErroPararFila);
});

// --- Gestão da equipe (regras trazidas da Base Bruno) ---------------------------
const gestao = await import('../src/gestao.mjs');
const { mesmoNome } = await import('../src/base-goto.mjs');

test('gestão: ausência parcial vira fração da jornada (1h30 de 7h12 = 79%)', () => {
  assert.equal(gestao.fracaoDoStatus('Atestado', '09:00', '10:30', 432), 0.7917);
  assert.equal(gestao.fracaoDoStatus('Férias', null, null, 432), 0);
  assert.equal(gestao.fracaoDoStatus('Meio período', null, null, 432), 0.5);
  assert.throws(() => gestao.fracaoDoStatus('Inventado', null, null, 432));
});

test('gestão: liga o nome do Digisac ao atendente da GoTo', () => {
  assert.ok(mesmoNome('Carlos Souza', 'Carlos Eduardo Lima Souza'));
  assert.ok(mesmoNome('Mário Ângelo', 'Mario Angelo Prado Neves'));
  assert.ok(mesmoNome('Lúcia Prado', 'Lucia Prado Neves'));
  assert.ok(!mesmoNome('Carlos Souza', 'Carlos Eduardo Silva'));
  assert.ok(!mesmoNome('Prado Neves', 'Lucia Prado Neves')); // primeiro nome diferente
});

test('gestão: meta do dia segue disponibilidade, feriado e meta por período; produção soma chat e voz', () => {
  db.prepare("INSERT INTO tecnicos (id, nome, na_equipe, meta_padrao, goto_agente, situacao) VALUES ('g1', 'Ana Teste', 1, 10, 'Ana Maria Teste', 'Ativo')").run();
  db.prepare("INSERT INTO feriados (dia, descricao, tipo, ativo) VALUES ('2026-11-02', 'Finados', 'nacional', 1), ('2026-11-03', 'Ponto facultativo', 'facultativo', 1)").run();
  db.prepare("INSERT INTO metas_periodo (tecnico_id, desde, meta) VALUES ('g1', '2026-11-05', 20)").run();
  db.prepare("INSERT INTO disponibilidade (tecnico_id, dia, status, fracao) VALUES ('g1', '2026-11-04', 'Meio período', 0.5)").run();
  db.prepare("INSERT INTO ligacoes (id, fila, agente, inicio, dia, hora, espera_seg, total_seg) VALUES ('l1', 'Ponto Eletrônico', 'Ana Maria Teste', '2026-11-04T13:00:00Z', '2026-11-04', 10, 8, 120)").run();
  db.prepare("INSERT INTO chamados (id, protocolo, departamento_id, tecnico_id, aberto, iniciado_em, encerrado_em, msgs_cliente) VALUES ('cg1', 'G1', 'd1', 'g1', 0, '2026-11-04T12:00:00Z', '2026-11-04T14:00:00Z', 3)").run();
  const [linha] = gestao.grade('2026-11-02', '2026-11-08', gestao.equipe().filter((t) => t.id === 'g1'));
  const dia = (d) => linha.dias.find((x) => x.dia === d);
  assert.equal(dia('2026-11-02').util, false);            // feriado nacional
  assert.equal(dia('2026-11-03').util, true);             // facultativo conta como útil
  assert.equal(dia('2026-11-03').meta, 10);               // meta padrão
  assert.equal(dia('2026-11-04').meta, 5);                // meio período: 10 × 0,5
  assert.equal(dia('2026-11-05').meta, 20);               // meta por período a partir do dia 5
  assert.equal(dia('2026-11-07').util, false);            // sábado
  assert.equal(dia('2026-11-04').chats, 1);
  assert.equal(dia('2026-11-04').ligacoes, 1);
  const r = gestao.resumir(linha);
  assert.equal(r.dias_uteis, 4);
  assert.equal(r.meta, 10 + 5 + 20 + 20);
  assert.equal(r.realizado, 2);
});

test('acesso do técnico: senha provisória legível e login avisa que precisa trocar', () => {
  const { senhaProvisoria, gerarHash, entrar: entrarComo, validarSenha } = auth;
  const senha = senhaProvisoria();
  assert.match(senha, /^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  assert.doesNotMatch(senha, /[01OlI]/);              // sem caracteres que se confundem ao ditar
  assert.equal(validarSenha(senha), null);           // passa na regra de tamanho mínimo
  db.prepare("INSERT INTO usuarios (email, nome, perfil, tecnico_id, senha_hash, deve_trocar_senha) VALUES ('novo.tecnico@exemplo.invalid', 'Novo Técnico', 'tecnico', 'g1', ?, 1)").run(gerarHash(senha));
  const r = entrarComo('novo.tecnico@exemplo.invalid', senha, '10.0.0.9');
  assert.equal(r.usuario.deve_trocar_senha, true);
  assert.equal(r.usuario.perfil, 'tecnico');
  assert.ok(db.prepare("SELECT ultimo_acesso FROM usuarios WHERE email = 'novo.tecnico@exemplo.invalid'").get().ultimo_acesso);
});

test('senha padrão aceita 6 caracteres; a senha pessoal continua exigindo 10', () => {
  assert.equal(auth.validarSenha('Tek123', auth.MINIMO_SENHA_PADRAO), null);
  assert.match(auth.validarSenha('Tek12', auth.MINIMO_SENHA_PADRAO), /6 caracteres/);
  assert.match(auth.validarSenha('Tek123'), /10 caracteres/);
});
