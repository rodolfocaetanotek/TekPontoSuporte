// Transcrição de áudios e vídeos das conversas (Whisper no Groq, plano gratuito), para a análise
// da IA considerar o que foi falado. O arquivo é baixado do Digisac só em memória e enviado ao
// Groq; aqui fica guardado apenas o texto (em mensagens.transcricao, apagado junto com a mensagem
// pela retenção da LGPD).
import { config } from './config.mjs';
import { db } from './db.mjs';
import { arquivoDaMensagem } from './digisac.mjs';
import { ErroPararFila } from './ia.mjs';

export const TIPOS_DE_MIDIA = ['ptt', 'audio', 'video'];
const LIMITE_BYTES = 25 * 1024 * 1024; // limite do plano gratuito do Groq

// O Groq reconhece o formato pela extensão; o WhatsApp manda voz como .oga (Ogg/Opus).
const EXTENSAO = { oga: 'ogg', opus: 'ogg', mpga: 'mp3' };

async function baixar(url) {
  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`Digisac não entregou o arquivo (HTTP ${resp.status})`);
  const tamanho = Number(resp.headers.get('content-length'));
  if (tamanho > LIMITE_BYTES) throw new Error(`Arquivo de ${Math.round(tamanho / 1048576)} MB passa do limite de 25 MB`);
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > LIMITE_BYTES) throw new Error(`Arquivo de ${Math.round(bytes.byteLength / 1048576)} MB passa do limite de 25 MB`);
  return bytes;
}

export async function transcreverArquivo(bytes, nome, mimetype, tentativa = 1) {
  if (!config.ia.groqChave) throw new ErroPararFila('Falta GROQ_API_KEY no .env para transcrever áudios');
  const ext = (nome.split('.').pop() ?? '').toLowerCase();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimetype || 'application/octet-stream' }), `midia.${EXTENSAO[ext] ?? (ext || 'ogg')}`);
  form.append('model', config.ia.modeloTranscricao);
  form.append('language', 'pt');
  form.append('temperature', '0');
  form.append('response_format', 'json');
  const resp = await fetch(`${config.ia.groqUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.ia.groqChave}` },
    body: form,
    signal: AbortSignal.timeout(180_000),
  });
  if (resp.status === 429) {
    const espera = Number(resp.headers.get('retry-after')) || 0;
    if (espera && espera <= 60 && tentativa <= 3) {
      await new Promise((ok) => setTimeout(ok, espera * 1000));
      return transcreverArquivo(bytes, nome, mimetype, tentativa + 1);
    }
    throw new ErroPararFila('Cota gratuita de transcrição do Groq atingida; a fila retoma sozinha mais tarde');
  }
  if (resp.status === 401) throw new ErroPararFila('Groq recusou a chave: confira GROQ_API_KEY no .env');
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`Transcrição: ${json.error?.message ?? `HTTP ${resp.status}`}`);
  return String(json.text ?? '').trim();
}

// Transcreve as mídias ainda sem texto de um chamado. Falha em uma mídia não impede a análise:
// o motivo fica em transcricao_erro e a conversa segue com o marcador "[áudio]".
export async function transcreverChamado(chamadoId, { log = () => {} } = {}) {
  if (!config.ia.transcreverMidia) return 0;
  const midias = db.prepare(`SELECT id, tipo FROM mensagens WHERE chamado_id = ? AND tipo IN (${TIPOS_DE_MIDIA.map(() => '?').join(',')})
    AND transcricao IS NULL AND transcricao_erro IS NULL ORDER BY quando`).all(chamadoId, ...TIPOS_DE_MIDIA);
  let feitas = 0;
  for (const m of midias) {
    try {
      const arquivo = await arquivoDaMensagem(m.id);
      if (!arquivo?.url) throw new Error('Mensagem sem arquivo no Digisac');
      const bytes = await baixar(arquivo.url);
      const texto = await transcreverArquivo(bytes, arquivo.name ?? arquivo.publicFilename ?? 'midia.ogg', arquivo.mimetype);
      db.prepare('UPDATE mensagens SET transcricao = ? WHERE id = ?').run(texto || '(sem fala)', m.id);
      feitas++;
    } catch (e) {
      if (e instanceof ErroPararFila) throw e;
      log(`Transcrição: falha na mensagem ${m.id}: ${e.message}`);
      db.prepare('UPDATE mensagens SET transcricao_erro = ? WHERE id = ?').run(e.message.slice(0, 300), m.id);
    }
  }
  return feitas;
}
