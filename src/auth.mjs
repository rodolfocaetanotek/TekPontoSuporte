// Login local com senha (scrypt) e sessão em cookie HttpOnly.
// Perfis: admin (tudo + usuários), coordenador (tudo, revisa IA), tecnico (só os próprios atendimentos).
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';
import { db } from './db.mjs';

export function gerarHash(senha) {
  const sal = randomBytes(16);
  return `scrypt$${sal.toString('hex')}$${scryptSync(senha, sal, 64).toString('hex')}`;
}

export function conferirSenha(senha, hash) {
  const [, salHex, chaveHex] = String(hash).split('$');
  if (!salHex || !chaveHex) return false;
  const chave = Buffer.from(chaveHex, 'hex');
  return timingSafeEqual(scryptSync(senha, Buffer.from(salHex, 'hex'), chave.length), chave);
}

export function validarSenha(senha) {
  if (String(senha).length < 10) return 'A senha precisa ter pelo menos 10 caracteres';
  return null;
}

// Bloqueio simples contra força bruta: 5 erros em 15 min por e-mail+IP.
const tentativas = new Map();
function bloqueado(chave) {
  const t = tentativas.get(chave);
  return t && t.n >= 5 && Date.now() - t.desde < 15 * 60_000;
}
function falhou(chave) {
  const t = tentativas.get(chave);
  if (!t || Date.now() - t.desde > 15 * 60_000) tentativas.set(chave, { n: 1, desde: Date.now() });
  else t.n++;
}

export function entrar(email, senha, ip) {
  const chave = `${String(email).toLowerCase()}|${ip}`;
  if (bloqueado(chave)) return { erro: 'Muitas tentativas. Aguarde 15 minutos.' };
  const u = db.prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1').get(String(email).trim());
  if (!u || !conferirSenha(String(senha), u.senha_hash)) {
    falhou(chave);
    return { erro: 'E-mail ou senha inválidos' };
  }
  tentativas.delete(chave);
  const token = randomBytes(32).toString('base64url');
  const expira = new Date(Date.now() + config.sessaoHoras * 3600_000).toISOString();
  db.prepare('DELETE FROM sessoes WHERE expira_em < ?').run(new Date().toISOString());
  db.prepare('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES (?, ?, ?)').run(token, u.id, expira);
  return { token, usuario: publico(u) };
}

export function sair(token) {
  db.prepare('DELETE FROM sessoes WHERE token = ?').run(token);
}

export function usuarioDaSessao(token) {
  if (!token) return null;
  const u = db.prepare(`SELECT u.* FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.token = ? AND s.expira_em > ? AND u.ativo = 1`).get(token, new Date().toISOString());
  return u ? publico(u) : null;
}

export function publico(u) {
  return { id: u.id, email: u.email, nome: u.nome, perfil: u.perfil, tecnico_id: u.tecnico_id, ativo: !!u.ativo };
}

export const podeGerir = (u) => u.perfil === 'admin' || u.perfil === 'coordenador';
// Técnico só enxerga os próprios atendimentos; os demais perfis veem tudo.
export const escopoTecnico = (u) => (u.perfil === 'tecnico' ? u.tecnico_id ?? '__nenhum__' : null);
