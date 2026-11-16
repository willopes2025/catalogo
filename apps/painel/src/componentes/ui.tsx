import { useState, type ReactNode } from 'react';
import { ErroApi } from '../api';

export function Topo({ eb, titulo, acoes, sub }: { eb?: ReactNode; titulo: string; acoes?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="topo">
      <div>
        {eb && <div className="eb">{eb}</div>}
        <h1>{titulo}</h1>
        {sub && <p className="muted" style={{ marginTop: 4 }}>{sub}</p>}
      </div>
      {acoes && <div className="acoes">{acoes}</div>}
    </div>
  );
}

export function Indicador({ rotulo, valor, detalhe, tipo }: { rotulo: string; valor: ReactNode; detalhe?: ReactNode; tipo?: 'destaque' | 'atencao' }) {
  return (
    <div className={`cartao indicador ${tipo ?? ''}`}>
      <div className="rotulo">{rotulo}</div>
      <div className="valor">{valor}</div>
      {detalhe && <div className="detalhe">{detalhe}</div>}
    </div>
  );
}

export function Abas<T extends string>({ abas, ativa, mudar }: { abas: [T, string][]; ativa: T; mudar: (a: T) => void }) {
  return (
    <div className="abas" role="tablist">
      {abas.map(([chave, nome]) => (
        <button key={chave} role="tab" aria-selected={ativa === chave} className={ativa === chave ? 'ativa' : ''} onClick={() => mudar(chave)}>
          {nome}
        </button>
      ))}
    </div>
  );
}

/** Nome que a pessoa vê na tela para cada campo que o servidor pode recusar. */
const ROTULOS: Record<string, string> = {
  nome: 'Nome', nomeSocial: 'Nome social', cpf: 'CPF', cnpj: 'CNPJ', cpfCnpj: 'CPF/CNPJ', documento: 'CPF/CNPJ', rg: 'RG', pis: 'PIS / NIS', nascimento: 'Nascimento',
  telefone: 'Telefone', telefone1: 'Telefone', telefone2: 'Telefone 2', celular: 'Celular', email: 'E-mail', cep: 'CEP', endereco: 'Endereço', numero: 'Número', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF',
  empresaId: 'Empresa', cargo: 'Cargo', departamento: 'Setor', tipoContrato: 'Tipo de contrato', salario: 'Salário', ctps: 'CTPS', matriculaEsocial: 'Matrícula no eSocial', escalaId: 'Escala de horário',
  dataAdmissao: 'Admissão', dadosBancarios: 'Dados bancários', observacao: 'Observações', acesso: 'Acesso ao sistema', grupoId: 'Nível de acesso', senha: 'Senha',
  valor: 'Valor', preco: 'Preço', quantidade: 'Quantidade', data: 'Data', vencimento: 'Vencimento', descricao: 'Descrição', titulo: 'Título', motivo: 'Motivo', tipo: 'Tipo', inicio: 'Início', fim: 'Fim',
  pessoaId: 'Pessoa', produtoId: 'Produto', clienteId: 'Cliente', representanteId: 'Representante', responsavelId: 'Responsável', itens: 'Itens', pagamentos: 'Pagamentos', _: 'Dados enviados',
};
/** "dadosBancarios.pix" → "Dados bancários › Pix"; campo desconhecido vira texto legível ("limiteCredito" → "Limite credito"). */
export function rotuloCampo(caminho: string) {
  return caminho
    .split('.')
    .filter((p) => !/^\d+$/.test(p))
    .map((p) => ROTULOS[p] ?? p.replace(/Id$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ (.)/g, (m) => m.toLowerCase()))
    .join(' › ');
}

/** Campos recusados pelo servidor, para destacar cada um no formulário. */
export function camposComErro(erro: unknown): Record<string, string> {
  return erro instanceof ErroApi ? erro.dados.campos ?? {} : {};
}

export function Erro({ erro }: { erro: unknown }) {
  if (!erro) return null;
  const e = erro instanceof ErroApi ? erro : null;
  // O mesmo campo pode vir duas vezes (o e-mail da ficha e o do acesso): mostra uma vez só.
  const vistos = new Set<string>();
  const campos = Object.entries(e?.dados.campos ?? {}).filter(([c, m]) => {
    const chave = `${c.split('.').pop()}|${m}`;
    return vistos.has(chave) ? false : !!vistos.add(chave);
  });
  return (
    <div className="aviso erro" role="alert">
      {campos.length ? 'Não deu para salvar. Confira:' : (e?.dados.mensagem ?? (erro as Error).message ?? 'Erro inesperado')}
      {/* Diz qual campo e por quê: nem toda tela consegue destacar o campo. */}
      {campos.length > 0 && (
        <ul>
          {campos.map(([c, m]) => (
            <li key={c}><b>{rotuloCampo(c)}:</b> {m}</li>
          ))}
        </ul>
      )}
      {e?.dados.motivos && (
        <ul>
          {e.dados.motivos.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Campo({ rotulo, erro, ajuda, children, className }: { rotulo: string; erro?: string; ajuda?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`campo ${erro ? 'com-erro' : ''} ${className ?? ''}`}>
      <label>{rotulo}</label>
      {children}
      {erro ? <span className="erro-campo">{erro}</span> : ajuda ? <span className="ajuda">{ajuda}</span> : null}
    </div>
  );
}

export function Carregando() {
  return <div className="vazio">Carregando…</div>;
}

export function StatusMaleta({ status, diasAtraso }: { status: string; diasAtraso?: number }) {
  if (status === 'aberta' && diasAtraso && diasAtraso > 0) return <span className="etiqueta erro">{diasAtraso} dias de atraso</span>;
  const mapa: Record<string, [string, string]> = { aberta: ['ok', 'Aberta'], acertada: ['neutra', 'Acertada'], cancelada: ['neutra', 'Cancelada'] };
  const [c, t] = mapa[status] ?? ['neutra', status];
  return <span className={`etiqueta ${c}`}>{t}</span>;
}

export function StatusPessoa({ status, bloqueado }: { status: string; bloqueado?: boolean }) {
  if (bloqueado) return <span className="etiqueta erro">Bloqueada</span>;
  const mapa: Record<string, [string, string]> = { ativo: ['ok', 'Ativa'], triagem: ['alerta', 'Em triagem'], inativo: ['neutra', 'Inativa'], recusado: ['erro', 'Recusada'] };
  const [c, t] = mapa[status] ?? ['neutra', status];
  return <span className={`etiqueta ${c}`}>{t}</span>;
}

export function useConfirmar() {
  const [msg, setMsg] = useState<string | null>(null);
  return { msg, setMsg };
}
