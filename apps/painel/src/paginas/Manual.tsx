import { useState } from 'react';
import { Topo } from '../componentes/ui';

interface Secao { id: string; titulo: string; passos: { t: string; d: string }[]; dicas?: string[] }

/** Manual de uso: um passo a passo curto por rotina, para a equipe consultar no dia a dia. */
const SECOES: Secao[] = [
  {
    id: 'primeiro',
    titulo: 'Primeiro acesso',
    passos: [
      { t: 'Entre com o e-mail e a senha provisória', d: 'A senha provisória é entregue por quem criou o seu usuário. Ela aparece uma única vez para quem cria.' },
      { t: 'Troque a senha', d: 'No menu lateral, embaixo do seu nome, clique em "Trocar senha". Use pelo menos 8 caracteres.' },
      { t: 'Veja só o que é seu', d: 'O menu mostra apenas os módulos que o seu grupo pode ver. Se faltar algo, peça à Diretoria em Configurações → Grupos e permissões.' },
    ],
  },
  {
    id: 'candidatas',
    titulo: 'Candidatas: do anúncio à aprovação',
    passos: [
      { t: 'Divulgue o formulário', d: 'Em Candidatas, "Copiar link do formulário". Nos anúncios, acrescente ?utm_source=instagram&utm_campaign=nome-da-campanha ao link: o sistema mostra de onde vem cada candidata e quantas foram aprovadas.' },
      { t: 'Faça o primeiro contato', d: 'Abra o cartão da candidata, toque em WhatsApp (a mensagem já vem pronta), anote o que combinaram e marque a data de retorno.' },
      { t: 'Mova pelo quadro', d: 'Novas → Em contato → Entrevista → Documentos. Recusa sempre com o motivo.' },
      { t: 'Aprove', d: '"Aprovar e criar representante" cria o cadastro com o limite inicial das regras e abre a ficha para completar CPF, endereço e contrato.' },
    ],
  },
  {
    id: 'portal',
    titulo: 'Portal da representante (app)',
    passos: [
      { t: 'Mande o acesso', d: 'Na ficha da representante, "Acesso ao portal" e depois "Enviar pelo WhatsApp". O link vale 7 dias e funciona uma vez; depois ela entra com o CPF e um código que chega no e-mail.' },
      { t: 'O que ela vê', d: 'A maleta com fotos e preços, a data do acerto, as parcelas com Pix copia e cola, as vendas e a comissão de cada mês, e o botão para compartilhar o catálogo.' },
      { t: 'Pré-baixa', d: 'Ela marca o que já vendeu; no acerto isso aparece para conferência.' },
      { t: 'Pedidos de peças', d: 'Ela escolhe peças do depósito; o pedido chega em Maletas › Pedidos das representantes, onde você monta a maleta ou responde.' },
      { t: 'Instalar no celular', d: 'No Android aparece "Instalar o app"; no iPhone, Compartilhar › Adicionar à Tela de Início.' },
    ],
  },
  {
    id: 'rede',
    titulo: 'Cadastrar uma representante',
    passos: [
      { t: 'Rede → Nova representante', d: 'Preencha CPF, telefone, endereço e duas referências. O CPF é validado e não pode repetir.' },
      { t: 'Consulte o crédito', d: 'Na ficha, use "Consultar na Assertiva" (quando a integração estiver ligada). O resultado fica guardado na ficha.' },
      { t: 'Defina o limite e o nível', d: 'O limite inicial vem das Regras do consignado; dá para mudar na ficha. O nível define a comissão.' },
      { t: 'Contrato', d: 'Na aba Documentos, gere o contrato e envie o link de assinatura pelo WhatsApp. Ela assina pelo celular.' },
    ],
  },
  {
    id: 'maleta',
    titulo: 'Montar e entregar uma maleta',
    passos: [
      { t: 'Maletas → Nova maleta', d: 'Escolha a representante. Se ela estiver bloqueada (atraso, limite, contrato), o sistema mostra o motivo e não deixa seguir.' },
      { t: 'Bipe as peças', d: 'Cada bipe soma uma peça. O valor total aparece ao lado do limite disponível.' },
      { t: 'Imprima', d: 'Na maleta, imprima a lista de separação (sem valores, para o estoque) e o pedido (com valores, para a representante assinar).' },
      { t: 'Promissória e NF-e de remessa', d: 'Gere a promissória para assinatura e, se for o caso, a nota de remessa em consignação.' },
    ],
    dicas: ['A maleta vira um "local" de estoque: as peças saem do depósito e ficam no nome da representante até o acerto.'],
  },
  {
    id: 'acerto',
    titulo: 'Fazer o acerto',
    passos: [
      { t: 'Abra a maleta e clique em "Fazer acerto"', d: 'Bipe as peças que voltaram. O que não voltou conta como vendido.' },
      { t: 'Marque perdas', d: 'Peça perdida ou quebrada pela representante é cobrada conforme a regra (preço de custo ou de venda).' },
      { t: 'Confira o cálculo', d: 'O sistema mostra vendido, comissão, multa e juros de atraso e o valor a pagar. Escolha à vista ou parcelado.' },
      { t: 'Feche', d: 'Ao fechar, o estoque volta para o depósito, as parcelas entram no Financeiro e o limite é revisto automaticamente.' },
    ],
  },
  {
    id: 'loja',
    titulo: 'Vender na loja ou no evento',
    passos: [
      { t: 'Lojas → Abrir o caixa', d: 'Informe o troco inicial. Cada local tem um caixa por vez.' },
      { t: 'Bipe as peças e receba', d: 'Aceita várias formas no mesmo pagamento (Pix + dinheiro, por exemplo). O troco é calculado.' },
      { t: 'Nota da cliente', d: 'Na venda, emita a NFC-e. O recibo pode ser impresso ou enviado.' },
      { t: 'Feche o caixa', d: 'Conte forma por forma. A diferença fica registrada.' },
    ],
    dicas: ['Devolução vira crédito para a cliente e pode pagar outra compra.', 'Cancelar só no mesmo dia; depois disso, use devolução.'],
  },
  {
    id: 'estoque',
    titulo: 'Estoque, inventário e etiquetas',
    passos: [
      { t: 'Entrada de mercadoria', d: 'Estoque → Entrada. Bipe as peças e informe a chave da nota do fornecedor.' },
      { t: 'Transferência', d: 'Do depósito para a loja ou para o evento, e de volta.' },
      { t: 'Inventário', d: 'Estoque → Inventário e ajuste. Escolha o local, bipe tudo o que está lá e clique em "Conferir diferenças". No inventário completo, o que não foi bipado é zerado. Informe o motivo e grave.' },
      { t: 'Etiquetas', d: 'Estoque → Etiquetas. Bipe as peças (ou carregue tudo de um local), ajuste as quantidades e imprima. Tamanho e conteúdo em Configurações → Avisos e regras.' },
      { t: 'Rastreio', d: 'Bipe qualquer peça para ver onde ela está e todo o caminho que fez.' },
    ],
  },
  {
    id: 'garantia',
    titulo: 'Garantia e conserto',
    passos: [
      { t: 'Garantia → Nova ordem', d: 'Bipe a peça e informe o nº da venda ou da maleta: a cliente e a data da compra vêm sozinhas, e o sistema avisa se está fora do prazo.' },
      { t: 'Assistência', d: 'Se precisar, envie para a assistência com a previsão de volta.' },
      { t: 'Decida', d: 'Troca (bipe a peça nova e escolha de onde sai), conserto, devolução ao fornecedor ou recusa com o motivo. A peça com defeito vai para o local "Avarias e garantia".' },
      { t: 'Conserto pago', d: 'Ao concluir, o valor recebido entra no Financeiro.' },
    ],
  },
  {
    id: 'financeiro',
    titulo: 'Financeiro e cobrança',
    passos: [
      { t: 'Contas a receber', d: 'Parcelas dos acertos e vendas a prazo. Gere Pix ou boleto pelo Asaas; a baixa é automática quando a cliente paga.' },
      { t: 'Contas a pagar', d: 'Fornecedores, despesas e comissões fechadas.' },
      { t: 'Baixa manual', d: 'Para pagamentos fora do Asaas, informe a data e o valor recebido.' },
    ],
  },
  {
    id: 'comissoes',
    titulo: 'Fechar as comissões do mês',
    passos: [
      { t: 'Comissões → escolha o mês', d: 'A prévia mostra cada vendedora com o vendido menos as devoluções, o percentual e a meta.' },
      { t: 'Feche o mês', d: 'Gera uma conta a pagar por pessoa, com vencimento no dia configurado do mês seguinte.' },
      { t: 'Errou?', d: 'Enquanto nenhuma comissão foi paga, "Reabrir o mês" cancela as contas e permite fechar de novo.' },
    ],
  },
  {
    id: 'avisos',
    titulo: 'Avisos automáticos',
    passos: [
      { t: 'Configurações → Avisos e regras', d: 'Ligue os avisos, escolha a hora e quantos dias antes lembrar o acerto e a parcela.' },
      { t: 'Resumo da equipe', d: 'Informe os e-mails que recebem, toda manhã, o resumo de maletas atrasadas, parcelas vencidas e garantias paradas.' },
      { t: 'Enviar agora', d: 'O botão envia na hora o que estiver pendente. Cada aviso sai uma vez só.' },
    ],
  },
  {
    id: 'implantacao',
    titulo: 'Implantação: o que falta para começar',
    passos: [
      { t: 'Configurações › Implantação', d: 'Mostra o que falta: CNPJs, integrações, NCM dos produtos, textos jurídicos, usuários, senhas provisórias e importação do Jueri.' },
      { t: 'Integrações', d: 'Quando a Aritana tiver os acessos (e-mail, Asaas, Focus NFe, Assertiva), preencha em Configurações › Integrações e use "Testar conexão".' },
      { t: 'Confirmações', d: 'Itens que só a Aritana pode garantir (certificado A1, CFOPs do contador, jurídico, regras) são marcados como "Feito" por quem confirmou.' },
      { t: 'Apagar os dados de teste', d: 'No dia da virada, a Diretoria apaga os dados de teste (digitando APAGAR) e importa os dados reais.' },
    ],
  },
  {
    id: 'seguranca',
    titulo: 'Segurança e auditoria',
    passos: [
      { t: 'Permissões por grupo', d: 'Cada grupo tem ver, criar, editar e excluir por módulo. Dê só o necessário.' },
      { t: 'Auditoria', d: 'Configurações → Auditoria mostra quem fez o quê e quando: acertos, ajustes de estoque, mudanças de regras, cancelamentos.' },
      { t: 'Quem sai da empresa', d: 'Desative o usuário em Configurações → Usuários. O histórico continua.' },
      { t: 'Cópia de segurança', d: 'O banco é copiado todo dia de madrugada no servidor e as cópias ficam 30 dias.' },
    ],
  },
  {
    id: 'suporte',
    titulo: 'Precisa de ajuda?',
    passos: [
      { t: 'Suporte → Novo chamado', d: 'Descreva o que aconteceu, em qual tela, e anexe um print se puder. A Wide responde pelo próprio chamado.' },
    ],
  },
];

export function Manual() {
  const [ativa, setAtiva] = useState(SECOES[0].id);
  const s = SECOES.find((x) => x.id === ativa)!;
  return (
    <>
      <Topo eb="Ajuda" titulo="Manual de uso" sub="O passo a passo de cada rotina, para consultar no dia a dia" acoes={<button className="botao claro" onClick={() => window.print()}>Imprimir esta parte</button>} />
      <div className="manual">
        <nav className="manual-indice" aria-label="Rotinas">
          {SECOES.map((x) => (
            <button key={x.id} className={x.id === ativa ? 'ativo' : ''} onClick={() => setAtiva(x.id)}>{x.titulo}</button>
          ))}
        </nav>
        <article className="cartao">
          <h2 style={{ marginTop: 0 }}>{s.titulo}</h2>
          <ol className="manual-passos">
            {s.passos.map((p, i) => (
              <li key={i}><b>{p.t}</b><p>{p.d}</p></li>
            ))}
          </ol>
          {s.dicas && (
            <div className="aviso ok" style={{ marginTop: 12 }}>
              {s.dicas.map((d, i) => <div key={i}>{d}</div>)}
            </div>
          )}
        </article>
      </div>
    </>
  );
}
