import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * Política de privacidade pública (endereço pedido pela Play Store e pela App Store).
 * Rascunho escrito para o sistema: a Aritana deve revisar com o jurídico/contabilidade antes de publicar o app.
 */
export function Privacidade() {
  const q = useQuery({ queryKey: ['privacidade'], queryFn: () => api<{ empresa: string; cnpj: string | null; cidade: string | null; email: string | null }>('/publico/privacidade') });
  const e = q.data;
  const nome = e?.empresa ?? 'Aritana Semijoias';
  const contato = e?.email ? <a href={`mailto:${e.email}`}>{e.email}</a> : 'os canais de atendimento da Aritana';
  return (
    <div className="publico" style={{ maxWidth: 760, lineHeight: 1.6 }}>
      <h1>Política de privacidade</h1>
      <p className="muted">{nome}{e?.cnpj ? ` · CNPJ ${e.cnpj}` : ''}{e?.cidade ? ` · ${e.cidade}` : ''}</p>
      <p>Esta política explica como a {nome} trata os dados pessoais no aplicativo e no portal da representante, no catálogo das consultoras e nos formulários do site, conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018).</p>

      <h2>Quais dados usamos</h2>
      <ul>
        <li><b>Representantes e consultoras:</b> nome, CPF, telefone, e-mail, endereço, dados do contrato, maletas, vendas, acertos, parcelas e pontos.</li>
        <li><b>Clientes que pedem pelo catálogo ou preenchem formulários:</b> nome, WhatsApp, cidade, endereço de entrega (quando pedido) e as peças escolhidas.</li>
        <li><b>Aparelho:</b> no aplicativo, um código do celular para enviar notificações. Não usamos a localização do GPS, a câmera nem os contatos do celular.</li>
      </ul>

      <h2>Para que usamos</h2>
      <ul>
        <li>Cumprir o contrato com a representante: maletas, acertos, cobranças, comissões e documentos.</li>
        <li>Atender os pedidos das clientes e encaminhar cada contato para a consultora mais perto da cidade informada.</li>
        <li>Enviar avisos pelo WhatsApp, e-mail e notificações do aplicativo sobre pedidos, compromissos e parcelas.</li>
        <li>Cumprir obrigações legais e fiscais (notas fiscais, registros contábeis).</li>
      </ul>

      <h2>Com quem compartilhamos</h2>
      <p>Só com os serviços necessários para o funcionamento: hospedagem do sistema, envio de mensagens de WhatsApp e e-mail, cobrança (boleto e Pix), emissão de notas fiscais, notificações (Google Firebase e Apple) e, quando a consultora atende o contato, com a própria consultora. Não vendemos dados pessoais.</p>
      <p>Parte do atendimento pelo WhatsApp pode ser feita com ajuda de inteligência artificial. Nesse caso, as mensagens da conversa são processadas por um serviço de IA contratado (Anthropic) só para escrever as respostas. A qualquer momento você pode pedir para falar com uma pessoa da equipe.</p>

      <h2>Por quanto tempo guardamos</h2>
      <p>Enquanto durar a relação com a Aritana e, depois, pelo prazo exigido por lei para documentos fiscais, contábeis e contratuais.</p>

      <h2 id="excluir">Seus direitos e como pedir a exclusão</h2>
      <p>Você pode pedir a qualquer momento acesso, correção ou exclusão dos seus dados, ou retirar a autorização de contato, por {contato}. Informe seu nome e telefone. Excluímos tudo o que não precisarmos guardar por obrigação legal e confirmamos o atendimento em até 15 dias.</p>
      <p>Para deixar de receber notificações, desative-as nas configurações do celular ou toque em "Sair" no aplicativo.</p>

      <h2>Segurança</h2>
      <p>Os dados ficam em servidor com acesso restrito, conexão protegida (HTTPS) e senhas e chaves guardadas cifradas.</p>

      <p className="muted" style={{ marginTop: 32 }}>Última atualização: novembro de 2026.</p>
    </div>
  );
}
