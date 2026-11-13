import { useState } from 'react';
import { api, ErroApi } from '../api';

interface DadosCpf {
  nome: string | null; nascimento: string | null; genero: string | null; telefones: string[]; emails: string[];
  endereco: { cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null } | null;
}

/** Busca o CPF na Assertiva e preenche só os campos que vierem; nada é salvo até clicar em Salvar. */
export function BotaoAssertiva({ cpf, aplicar }: { cpf?: string | null; aplicar: (dados: Record<string, unknown>) => void }) {
  const [estado, setEstado] = useState<{ carregando?: boolean; msg?: string; erro?: boolean }>({});
  async function buscar() {
    const c = (cpf ?? '').replace(/\D/g, '');
    if (c.length !== 11) return setEstado({ msg: 'Digite o CPF primeiro.', erro: true });
    setEstado({ carregando: true });
    try {
      const d = await api<DadosCpf>(`/integracoes/assertiva/cpf/${c}`);
      const e = d.endereco;
      const novo: Record<string, unknown> = {};
      const por = (k: string, v: unknown) => { if (v) novo[k] = v; };
      por('nome', d.nome); por('nascimento', d.nascimento); por('telefone1', d.telefones[0]); por('telefone2', d.telefones[1]); por('email', d.emails[0]);
      if (d.genero) novo.genero = /^f/i.test(d.genero) ? 'Feminino' : /^m/i.test(d.genero) ? 'Masculino' : undefined;
      if (e) { por('cep', e.cep); por('logradouro', e.logradouro); por('numero', e.numero); por('complemento', e.complemento); por('bairro', e.bairro); por('cidade', e.cidade); por('uf', e.uf); }
      aplicar(novo);
      setEstado({ msg: `${Object.keys(novo).length} campos preenchidos. Confira e salve.` });
    } catch (err) {
      setEstado({ msg: err instanceof ErroApi ? err.dados.mensagem : 'Não foi possível consultar.', erro: true });
    }
  }
  return (
    <div className="coluna" style={{ gap: 4 }}>
      <button type="button" className="botao claro" onClick={buscar} disabled={estado.carregando}>{estado.carregando ? 'Consultando…' : 'Buscar pela Assertiva'}</button>
      {estado.msg && <span className="muted" style={{ color: estado.erro ? 'var(--erro)' : undefined }}>{estado.msg}</span>}
    </div>
  );
}
