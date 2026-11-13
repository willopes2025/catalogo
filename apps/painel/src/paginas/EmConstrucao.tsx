import { useParams } from 'react-router-dom';
import { MODULOS } from '@aritana/regras';
import { Topo } from '../componentes/ui';

const PROXIMO: Record<string, string> = {
  cadastros: 'Clientes, fornecedores, transportadoras e assistências técnicas.',
  vendas: 'Revenda, vendas avulsas e devoluções.',
  lojas: 'Frente de caixa, caixas, pontos de venda e metas da loja.',
  garantia: 'Garantias, ordens de serviço e serviços.',
  comissoes: 'Comissões do mês por representante e vendedora.',
  fiscal: 'Emissão de NF-e e NFC-e pelo emissor fiscal.',
  relatorios: 'Desempenho, acertos, produtos, vendas e financeiro.',
  suporte: 'Chamados com a Wide e status do sistema.',
};

export function EmConstrucao() {
  const { modulo } = useParams();
  const m = MODULOS.find((x) => x.chave === modulo);
  return (
    <>
      <Topo eb={`Versão ${m?.versao ?? 1}`} titulo={m?.nome ?? 'Página não encontrada'} />
      <div className="cartao vazio">
        <h2 style={{ marginBottom: 8 }}>Em construção</h2>
        <p>{(modulo && PROXIMO[modulo]) ?? 'Este módulo faz parte das próximas etapas.'}</p>
      </div>
    </>
  );
}
