// Lista os departamentos do Digisac para escolher DIGISAC_DEPARTAMENTOS no .env.
// Uso: npm run departamentos
import { digisacConfigurado } from './config.mjs';
import { listarDepartamentos } from './digisac.mjs';

if (!digisacConfigurado()) {
  console.error('Preencha DIGISAC_URL e DIGISAC_TOKEN no .env');
  process.exit(1);
}
try {
  for await (const d of listarDepartamentos()) console.log(`${d.id}  ${d.name}${d.archivedAt ? '  (arquivado)' : ''}`);
} catch (e) {
  console.error('ERRO:', e.message);
  process.exit(1);
}
