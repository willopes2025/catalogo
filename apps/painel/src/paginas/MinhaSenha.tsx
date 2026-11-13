import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, lerSessao } from '../api';
import { Campo, Erro, Topo } from '../componentes/ui';

export function MinhaSenha() {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [repete, setRepete] = useState('');
  const eu = useQuery({ queryKey: ['eu'], queryFn: () => api<{ trocarSenha: boolean }>('/auth/eu') });
  const trocar = useMutation({ mutationFn: () => api('/auth/trocar-senha', { corpo: { atual, nova } }), onSuccess: () => { setAtual(''); setNova(''); setRepete(''); eu.refetch(); } });
  const s = lerSessao();
  return (
    <>
      <Topo eb="Meu perfil" titulo="Trocar senha" sub={`${s?.usuario.nome} · ${s?.usuario.email}`} />
      {eu.data?.trocarSenha && <div className="aviso alerta" style={{ maxWidth: 440, marginBottom: 14 }}>Sua senha é provisória. Crie uma senha sua para liberar o sistema.</div>}
      <div className="cartao coluna" style={{ maxWidth: 440 }}>
        <Campo rotulo="Senha atual"><input type="password" autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} /></Campo>
        <Campo rotulo="Nova senha" ajuda="Pelo menos 10 caracteres"><input type="password" autoComplete="new-password" value={nova} onChange={(e) => setNova(e.target.value)} /></Campo>
        <Campo rotulo="Repita a nova senha" erro={repete && repete !== nova ? 'As senhas não conferem' : undefined}><input type="password" autoComplete="new-password" value={repete} onChange={(e) => setRepete(e.target.value)} /></Campo>
        {trocar.isSuccess && <div className="aviso ok">Senha trocada.</div>}
        {trocar.error && <Erro erro={trocar.error} />}
        <button className="botao" disabled={!atual || nova.length < 10 || nova !== repete || trocar.isPending} onClick={() => trocar.mutate()}>Trocar senha</button>
      </div>
    </>
  );
}
