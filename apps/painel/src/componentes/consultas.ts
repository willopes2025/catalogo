import { useRef, useState } from 'react';
import { api } from '../api';

export interface EnderecoCep { cep: string; logradouro: string | null; bairro: string | null; cidade: string | null; uf: string | null }
export interface DadosCnpj extends EnderecoCep {
  cnpj: string; razaoSocial: string | null; nomeFantasia: string | null; inscricaoEstadual: string | null;
  numero: string | null; complemento: string | null; telefone: string | null; email: string | null; situacao: string | null;
}

const TAMANHO = { cep: 8, cnpj: 14 } as const;

/**
 * Preenchimento automático: chame `buscar` a cada tecla do campo. Quando o CEP (8 números) ou o
 * CNPJ (14) fica completo, consulta e entrega os dados para `aplicar`. `aviso` vai embaixo do campo.
 */
export function useConsulta<T extends 'cep' | 'cnpj'>(tipo: T) {
  type Dados = T extends 'cep' ? EnderecoCep : DadosCnpj;
  const [aviso, setAviso] = useState<{ texto: string; erro?: boolean; alvo?: string } | null>(null);
  const ultimo = useRef('');
  const buscar = (valor: string, aplicar: (d: Dados) => void, alvo?: string) => {
    const n = (valor ?? '').replace(/\D/g, '');
    if (n.length !== TAMANHO[tipo]) {
      // Apagou ou está digitando: some o aviso e libera consultar o mesmo número de novo.
      if (ultimo.current) { ultimo.current = ''; setAviso(null); }
      return;
    }
    if (n === ultimo.current) return;
    ultimo.current = n;
    setAviso({ texto: tipo === 'cep' ? 'Buscando o endereço…' : 'Buscando os dados da empresa…', alvo });
    api<Dados>(`/consultas/${tipo}/${n}`)
      .then((d) => {
        if (ultimo.current !== n) return; // a pessoa já digitou outro número
        aplicar(d);
        const situacao = tipo === 'cnpj' ? (d as DadosCnpj).situacao : null;
        setAviso(situacao && !/ativa/i.test(situacao) ? { texto: `Dados preenchidos. Atenção: situação na Receita "${situacao}".`, erro: true, alvo } : { texto: tipo === 'cep' ? 'Endereço preenchido. Confira e complete o número.' : 'Dados preenchidos pela Receita. Confira.', alvo });
      })
      .catch((e: Error) => {
        if (ultimo.current === n) setAviso({ texto: e.message || 'Não deu para consultar agora. Preencha à mão.', erro: true, alvo });
      });
  };
  return { buscar, aviso };
}

/** Só preenche o que está vazio (não apaga o que a pessoa já digitou). */
export function soVazios<T extends Record<string, unknown>>(atual: T, novos: Record<string, unknown>): T {
  const r: Record<string, unknown> = { ...atual };
  for (const [k, v] of Object.entries(novos)) if (v !== null && v !== undefined && v !== '' && (r[k] === null || r[k] === undefined || r[k] === '')) r[k] = v;
  return r as T;
}
