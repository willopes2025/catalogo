import { strFromU8, unzipSync } from 'fflate';

/** Tipos aceitos como anexo do assistente (o resto é recusado com a lista na mensagem). */
export const TIPOS_ANEXO: Record<string, 'imagem' | 'pdf' | 'texto' | 'docx' | 'xlsx' | 'video' | 'audio'> = {
  'image/jpeg': 'imagem',
  'image/png': 'imagem',
  'image/webp': 'imagem',
  'image/gif': 'imagem',
  'application/pdf': 'pdf',
  'text/plain': 'texto',
  'text/csv': 'texto',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'audio/mpeg': 'audio',
  'audio/mp4': 'audio',
  'audio/x-m4a': 'audio',
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  'audio/wav': 'audio',
};

/** Tipo pelo nome, quando o navegador não diz (ex.: .csv no Windows vem vazio ou como "application/vnd.ms-excel"). */
export function tipoPeloNome(nome: string, mime: string) {
  const m = mime.split(';')[0].trim().toLowerCase();
  if (TIPOS_ANEXO[m]) return m;
  const ext = nome.split('.').pop()?.toLowerCase() ?? '';
  const porExt: Record<string, string> = { csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/x-m4a', ogg: 'audio/ogg', wav: 'audio/wav', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  return porExt[ext] ?? null;
}

const desescapar = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Texto de um .docx (parágrafos do word/document.xml). */
export function textoDocx(conteudo: Buffer) {
  const z = unzipSync(new Uint8Array(conteudo), { filter: (f) => f.name === 'word/document.xml' });
  const xml = z['word/document.xml'] ? strFromU8(z['word/document.xml']) : '';
  return desescapar(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Coluna "AB" → índice 27 (base 0 = 26). */
const indiceColuna = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** Planilha .xlsx em texto (CSV com ";"), até 3 abas e 500 linhas por aba. */
export function textoXlsx(conteudo: Buffer) {
  const z = unzipSync(new Uint8Array(conteudo), { filter: (f) => f.name === 'xl/sharedStrings.xml' || f.name === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) });
  const compartilhadas = z['xl/sharedStrings.xml'] ? [...strFromU8(z['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => desescapar([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))) : [];
  const nomesAbas = z['xl/workbook.xml'] ? [...strFromU8(z['xl/workbook.xml']).matchAll(/<sheet [^>]*name="([^"]+)"/g)].map((m) => desescapar(m[1])) : [];
  const abas = Object.keys(z)
    .filter((n) => n.startsWith('xl/worksheets/'))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
    .slice(0, 3);
  const saida: string[] = [];
  abas.forEach((aba, i) => {
    const xml = strFromU8(z[aba]);
    const linhas: string[] = [];
    for (const l of [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 500)) {
      const cel: string[] = [];
      for (const c of l[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const tipo = /t="(\w+)"/.exec(attrs)?.[1];
        const bruto = c[2] ? (/<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(c[2])?.[1] ?? '') : '';
        const valor = tipo === 's' ? (compartilhadas[Number(bruto)] ?? '') : desescapar(bruto);
        const col = ref ? indiceColuna(ref) : cel.length;
        while (cel.length < col) cel.push('');
        cel[col] = valor.includes(';') ? `"${valor.replace(/"/g, '""')}"` : valor;
      }
      if (cel.some((x) => x !== '')) linhas.push(cel.join(';'));
    }
    saida.push(`### Aba ${nomesAbas[i] ?? i + 1}\n${linhas.join('\n')}`);
  });
  return saida.join('\n\n').trim();
}
