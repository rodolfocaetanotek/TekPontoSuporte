// Dados FICTÍCIOS para conhecer a interface antes de ligar o Digisac.
// Uso: npm run demo            (gera)
//      npm run demo -- --limpar (remove tudo que começa com "demo-")
import { randomBytes } from 'node:crypto';
import { db, transacao, gravarEstado, agora } from './db.mjs';
import { gravarChamado, gravarMensagens } from './sync.mjs';
import { gerarHash } from './auth.mjs';

function limpar() {
  transacao(() => {
    for (const t of ['analises_ia', 'erros_ia', 'avaliacoes', 'mensagens']) {
      db.prepare(`DELETE FROM ${t} WHERE chamado_id LIKE 'demo-%'`).run();
    }
    db.prepare("DELETE FROM chamados WHERE id LIKE 'demo-%'").run();
    // Metas, escalas e disponibilidade saem em cascata com os técnicos; voz não tem vínculo direto.
    db.prepare("DELETE FROM ligacoes WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM pausas WHERE agente LIKE '% (GoTo demo)'").run();
    db.prepare("DELETE FROM contatos WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM tecnicos WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM departamentos WHERE id LIKE 'demo-%'").run();
    db.prepare("DELETE FROM usuarios WHERE email = 'demo@tekponto.local'").run();
  });
  gravarEstado('demonstracao', null);
  console.log('Dados de demonstração removidos.');
}

if (process.argv.includes('--limpar')) { limpar(); process.exit(0); }

let semente = 42;
const aleatorio = () => ((semente = (semente * 1664525 + 1013904223) % 4294967296) / 4294967296);
const escolher = (lista) => lista[Math.floor(aleatorio() * lista.length)];
const entre = (a, b) => a + aleatorio() * (b - a);

const TECNICOS = [
  ['demo-t1', 'Ana Exemplo', 0.9], ['demo-t2', 'Bruno Exemplo', 0.75], ['demo-t3', 'Carla Exemplo', 0.85],
  ['demo-t4', 'Diego Exemplo', 0.6], ['demo-t5', 'Elisa Exemplo', 0.8],
];
const ASSUNTOS = ['Relógio não comunica', 'Espelho de ponto', 'Banco de horas', 'Cadastro de funcionário', 'Exportação AFD/AEJ', 'Integração com a folha', 'Marcação ausente'];
const EMPRESAS = ['Padaria Modelo', 'Transportes Fictícios', 'Clínica Exemplo', 'Metalúrgica Demo', 'Mercado Teste', 'Escola Simulada', 'Hotel Ilustrativo'];

const CONVERSAS = {
  boa: [
    ['cliente', 'Bom dia! O relógio parou de enviar as marcações desde ontem.'],
    ['bot', 'Olá! Seu atendimento foi encaminhado ao Suporte de Ponto.'],
    ['tecnico', 'Bom dia! Vou verificar. Pode me confirmar o número de série do REP?'],
    ['cliente', 'É o que fica na recepção, série final 4471.'],
    ['tecnico', 'Obrigado. Ajustei o IP de comunicação e forcei a coleta. As marcações de ontem já aparecem no sistema?'],
    ['cliente', 'Apareceram sim! Muito obrigado, resolveu rápido.'],
    ['tecnico', 'Que ótimo! Qualquer coisa estamos à disposição.'],
  ],
  neutra: [
    ['cliente', 'Como gero o arquivo AFD do mês passado?'],
    ['tecnico', 'Olá! Em Relatórios > Fiscal > AFD, escolha o período e clique em Gerar.'],
    ['cliente', 'Ok.'],
  ],
  ruim: [
    ['cliente', 'Já é a terceira vez que abro chamado sobre o banco de horas errado.'],
    ['bot', 'Olá! Seu atendimento foi encaminhado ao Suporte de Ponto.'],
    ['cliente', 'Alguém vai responder?'],
    ['tecnico', 'Boa tarde, qual o problema?'],
    ['cliente', 'O mesmo de sempre, o saldo do funcionário não bate. Já expliquei para outro atendente.'],
    ['comentario', 'Cliente reincidente, verificar regra de compensação.'],
    ['tecnico', 'Vou transferir para o setor responsável.'],
    ['cliente', 'Péssimo. Ninguém resolve e eu que tenho que ficar explicando de novo.'],
  ],
};

transacao(() => {
  db.prepare("INSERT OR REPLACE INTO departamentos (id, nome, monitorado) VALUES ('demo-dep', 'Suporte Ponto (DEMONSTRAÇÃO)', 1)").run();
  for (const [id, nome] of TECNICOS) db.prepare('INSERT OR REPLACE INTO tecnicos (id, nome, email, ativo) VALUES (?, ?, ?, 1)').run(id, nome, `${id}@exemplo.invalid`);

  const hoje = Date.now();
  let n = 0;
  for (let dia = 60; dia >= 0; dia--) {
    const data = new Date(hoje - dia * 86400_000);
    const semana = data.getDay();
    if (semana === 0) continue;
    const volume = semana === 6 ? 3 : Math.round(entre(8, 16));
    for (let i = 0; i < volume; i++) {
      n++;
      const [tecId, , qualidade] = escolher(TECNICOS);
      const hora = Math.round(entre(8, 18));
      const inicio = new Date(data);
      inicio.setUTCHours(hora + 3, Math.floor(entre(0, 59)), 0, 0);
      const sorte = aleatorio();
      const tipo = sorte < qualidade * 0.75 ? 'boa' : sorte < qualidade ? 'neutra' : 'ruim';
      const aberto = dia === 0 && aleatorio() < 0.4;
      const espera = tipo === 'ruim' ? entre(15, 70) : entre(1, 12);
      let t = inicio.getTime();
      const msgs = CONVERSAS[tipo].map(([autor, texto], k) => {
        t += (autor === 'tecnico' && k <= 3 ? espera : entre(1, 6)) * 60_000;
        return {
          id: `demo-m${n}-${k}`, timestamp: new Date(t).toISOString(), text: texto, type: autor === 'comentario' ? 'comment' : 'chat',
          isFromMe: autor !== 'cliente', isFromBot: autor === 'bot', isComment: autor === 'comentario', userId: autor === 'tecnico' ? tecId : null,
        };
      });
      const fim = new Date(t + 60_000).toISOString();
      const contatoId = `demo-c${(n % 40) + 1}`;
      gravarChamado({
        id: `demo-${n}`, protocol: `DEMO${String(n).padStart(5, '0')}`, isOpen: aberto, contactId: contatoId,
        departmentId: 'demo-dep', userId: tecId, startedAt: inicio.toISOString(), endedAt: aberto ? null : fim, updatedAt: fim,
        ticketTopics: [{ name: escolher(ASSUNTOS) }], ticketTransfers: tipo === 'ruim' ? [{}, {}] : [],
        contact: { id: contatoId, name: `Contato Fictício ${(n % 40) + 1}`, data: { number: '5500000000000' }, person: { name: escolher(EMPRESAS) } },
      });
      gravarMensagens(`demo-${n}`, msgs);

      if (!aberto && aleatorio() < 0.45) {
        const nota = tipo === 'boa' ? Math.round(entre(4, 5)) : tipo === 'neutra' ? Math.round(entre(3, 5)) : Math.round(entre(1, 2));
        db.prepare("INSERT OR REPLACE INTO avaliacoes (id, chamado_id, tecnico_id, tipo, nota, respondido_em, origem) VALUES (?, ?, ?, ?, ?, ?, 'cliente')")
          .run(`demo-a${n}`, `demo-${n}`, tecId, 'csat', nota, fim);
      }
      if (!aberto && aleatorio() < 0.7) {
        const sentimento = { boa: 'positivo', neutra: 'neutro', ruim: 'negativo' }[tipo];
        const notaQ = { boa: entre(8, 10), neutra: entre(6, 8), ruim: entre(2, 5) }[tipo];
        const status = dia > 7 ? escolher(['aprovada', 'aprovada', 'aprovada', 'ajustada']) : 'pendente';
        db.prepare(`INSERT OR REPLACE INTO analises_ia (chamado_id, sentimento, intensidade, insatisfacao, motivos, nota_qualidade, criterios,
            resumo, pontos_melhoria, evidencias, confianca, modelo, versao_prompt, analisado_em, status, revisado_em, observacao_revisao)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demonstracao', 'demo', ?, ?, ?, ?)`)
          .run(`demo-${n}`, sentimento, entre(0.3, 0.9), tipo === 'ruim' ? 1 : 0,
            JSON.stringify(tipo === 'ruim' ? ['reincidencia', 'demora_na_resposta', 'excesso_de_transferencias'] : []),
            Math.round(notaQ * 10) / 10,
            JSON.stringify({ cordialidade: Math.round(notaQ), clareza: Math.round(notaQ), resolucao: Math.round(notaQ), agilidade: Math.round(notaQ), procedimento: Math.round(notaQ) }),
            tipo === 'ruim' ? 'Cliente reincidente sobre banco de horas; primeira resposta demorou e o chamado foi transferido sem solução.'
              : tipo === 'boa' ? 'Falha de comunicação do REP resolvida pelo técnico no primeiro contato; cliente agradeceu.'
                : 'Dúvida pontual sobre geração do AFD respondida de forma objetiva.',
            JSON.stringify(tipo === 'ruim' ? ['Cumprimentar e consultar o histórico do cliente antes de pedir que repita o problema.', 'Avisar o cliente do motivo e do prazo antes de transferir.'] : []),
            JSON.stringify(tipo === 'ruim' ? [{ trecho: 'Péssimo. Ninguém resolve', justificativa: 'Insatisfação explícita no encerramento' }] : [{ trecho: CONVERSAS[tipo].at(-1)[1], justificativa: 'Encerramento da conversa' }]),
            entre(0.6, 0.95), new Date(t + 120_000).toISOString(), status, status === 'pendente' ? null : agora(),
            status === 'ajustada' ? 'Ajuste de demonstração' : null);
      }
    }
  }
  console.log(`${n} chamados fictícios gerados.`);

  // Gestão e voz fictícias: equipe, escalas, metas, ausências, ligações e pausas da GoTo.
  const FUNCOES = ['Técnico', 'Técnico', 'Técnico', 'Técnico', 'Apoio Gestão'];
  TECNICOS.forEach(([id, nome], i) => db.prepare("UPDATE tecnicos SET na_equipe = 1, situacao = 'Ativo', funcao = ?, goto_agente = ? WHERE id = ?")
    .run(FUNCOES[i], `${nome} (GoTo demo)`, id));
  if (!db.prepare('SELECT COUNT(*) n FROM escalas').get().n) {
    for (const [nome, ini, fim] of [['Escala 1', '08:00', '16:42'], ['Escala 2', '08:30', '17:12'], ['Escala 3', '09:00', '17:42'], ['Escala 4', '09:30', '18:12']]) {
      db.prepare('INSERT INTO escalas (nome, hora_inicio, hora_fim) VALUES (?, ?, ?)').run(nome, ini, fim);
    }
  }
  const escalas = db.prepare('SELECT id FROM escalas ORDER BY hora_inicio').all().map((e) => e.id);
  const diaIso = (atras) => new Date(hoje - atras * 86400_000 - 3 * 3600_000).toISOString().slice(0, 10);
  TECNICOS.forEach(([id], i) => {
    db.prepare('INSERT OR REPLACE INTO tecnico_escalas (tecnico_id, escala_id, desde, motivo) VALUES (?, ?, ?, ?)').run(id, escalas[i % escalas.length], diaIso(60), 'Demonstração');
    db.prepare('INSERT OR REPLACE INTO metas_periodo (tecnico_id, desde, meta, observacao) VALUES (?, ?, ?, ?)').run(id, diaIso(60), [6, 5, 6, 5, 4][i], 'Demonstração');
  });
  const ausencia = (id, atras, status, fracao, extra = {}) => db.prepare(`INSERT OR REPLACE INTO disponibilidade
    (tecnico_id, dia, status, fracao, hora_inicio_ausencia, hora_fim_ausencia, observacao) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, diaIso(atras), status, fracao, extra.inicio ?? null, extra.fim ?? null, extra.obs ?? null);
  for (let d = 22; d >= 18; d--) ausencia('demo-t5', d, 'Férias', 0);
  ausencia('demo-t4', 9, 'Atestado', 0.7917, { inicio: '09:00', fim: '10:30', obs: 'Consulta (demonstração)' });
  ausencia('demo-t2', 4, 'Folga', 0);
  ausencia('demo-t3', 2, 'Treinamento', 0.5, { inicio: '13:00', fim: '16:36' });

  let nLig = 0;
  for (let dia = 60; dia >= 0; dia--) {
    const data = new Date(hoje - dia * 86400_000);
    if ([0, 6].includes(data.getDay())) continue;
    for (const [id, nome, qualidade] of TECNICOS) {
      if (db.prepare('SELECT 1 FROM disponibilidade WHERE tecnico_id = ? AND dia = ? AND fracao = 0').get(id, diaIso(dia))) continue;
      const agente = `${nome} (GoTo demo)`;
      for (let k = Math.round(entre(1, 6) * qualidade); k > 0; k--) {
        const inicio = new Date(data);
        inicio.setUTCHours(Math.round(entre(8, 17)) + 3, Math.floor(entre(0, 59)), 0, 0);
        const espera = aleatorio() < 0.85 ? entre(2, 20) : entre(20, 180);
        const conversa = entre(30, aleatorio() < 0.8 ? 420 : 1500);
        db.prepare(`INSERT OR REPLACE INTO ligacoes (id, fila, agente, inicio, dia, hora, espera_seg, conversa_seg, pos_seg, total_seg, resultado)
          VALUES (?, 'Ponto Eletrônico', ?, ?, ?, ?, ?, ?, 12, ?, 'COMPLETED')`)
          .run(`demo-l${++nLig}`, agente, inicio.toISOString(), diaIso(dia), inicio.getUTCHours() - 3, Math.round(espera), Math.round(conversa), Math.round(conversa) + 12);
      }
      db.prepare('INSERT INTO pausas (agente, dia, motivo, duracao_seg, quantidade) VALUES (?, ?, ?, ?, ?)').run(agente, diaIso(dia), 'Pausa Obrigatoria - 10 Minutos', 1200, 2);
      if (aleatorio() < 0.5) db.prepare('INSERT INTO pausas (agente, dia, motivo, duracao_seg, quantidade) VALUES (?, ?, ?, ?, ?)').run(agente, diaIso(dia), 'Agua / Cafe / Toilet', Math.round(entre(120, 600)), 1);
      if (aleatorio() < 0.1) db.prepare('INSERT INTO pausas (agente, dia, motivo, duracao_seg, quantidade) VALUES (?, ?, ?, ?, ?)').run(agente, diaIso(dia), 'Reuniao', 1800, 1);
    }
  }
  console.log(`${nLig} ligações fictícias geradas (fila Ponto Eletrônico).`);
});

gravarEstado('demonstracao', 'sim');
const existe = db.prepare('SELECT COUNT(*) n FROM usuarios').get().n;
if (!existe) {
  const senha = randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO usuarios (email, nome, perfil, senha_hash) VALUES ('demo@tekponto.local', 'Demonstração', 'admin', ?)").run(gerarHash(senha));
  console.log(`Usuário de demonstração: demo@tekponto.local  senha: ${senha}`);
}
console.log('Para remover depois: npm run demo -- --limpar');
