// Cria ou redefine um usuário do painel pela linha de comando.
// Uso: npm run usuario -- --email fulano@teknorte.com.br --nome "Fulano" --perfil admin
//      (a senha é pedida no terminal; ou passe --senha)
import { createInterface } from 'node:readline/promises';
import { db } from './db.mjs';
import { gerarHash, validarSenha } from './auth.mjs';

const arg = (nome) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const rl = createInterface({ input: process.stdin, output: process.stdout });
const email = arg('email') ?? (await rl.question('E-mail: '));
const nome = arg('nome') ?? (await rl.question('Nome: '));
const perfil = arg('perfil') ?? (process.argv.includes('--admin') ? 'admin' : await rl.question('Perfil (admin/coordenador/tecnico): '));
const senha = arg('senha') ?? (await rl.question('Senha (mín. 10 caracteres): '));
rl.close();

if (!['admin', 'coordenador', 'tecnico'].includes(perfil)) { console.error('Perfil inválido'); process.exit(1); }
const erro = validarSenha(senha);
if (erro) { console.error(erro); process.exit(1); }
if (perfil === 'tecnico') console.log('Lembre de vincular o técnico ao usuário do Digisac na tela Usuários.');

db.prepare(`INSERT INTO usuarios (email, nome, perfil, senha_hash) VALUES (?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET nome = excluded.nome, perfil = excluded.perfil, senha_hash = excluded.senha_hash, ativo = 1`)
  .run(email.trim(), nome.trim(), perfil, gerarHash(senha));
db.prepare("INSERT INTO auditoria (acao, alvo, detalhe) VALUES ('usuario_cli', ?, ?)").run(email.trim(), JSON.stringify({ perfil }));
console.log(`Usuário ${email} (${perfil}) pronto.`);
