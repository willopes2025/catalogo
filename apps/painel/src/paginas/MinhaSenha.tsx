import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, lerSessao } from '../api';
import { Campo, Erro, Topo } from '../componentes/ui';

export function MinhaSenha() {
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [repete, setRepete] = useState('');
  const eu = useQuery({ queryKey: ['eu'], queryFn: () => api<{ trocarSenha: boolean }>('/auth/eu') });
  const navegar = useNavigate();
  const trocar = useMutation({ mutationFn: () => api('/auth/trocar-senha', { corpo: { atual, nova } }), onSuccess: () => { const era = eu.data?.trocarSenha; setAtual(''); setNova(''); setRepete(''); eu.refetch(); if (era) navegar('/'); } });
  const s = lerSessao();
  const [ver, setVer] = useState(false);
  const provisoria = !!eu.data?.trocarSenha;
  return (
    <>
      <Topo eb="Meu perfil" titulo="Trocar senha" sub={`${s?.usuario.nome} · ${s?.usuario.email}`} />
      {eu.data?.trocarSenha && <div className="aviso alerta" style={{ maxWidth: 440, marginBottom: 14 }}>Sua senha é provisória. Crie uma senha sua para liberar o sistema.</div>}
      <div className="cartao coluna" style={{ maxWidth: 440 }}>
        {!provisoria && <Campo rotulo="Senha atual"><input type={ver ? 'text' : 'password'} autoComplete="current-password" value={atual} onChange={(e) => setAtual(e.target.value)} /></Campo>}
        <Campo rotulo={provisoria ? 'Crie a sua senha' : 'Nova senha'} ajuda="Pelo menos 8 caracteres"><input type={ver ? 'text' : 'password'} autoComplete="new-password" autoFocus={provisoria} value={nova} onChange={(e) => setNova(e.target.value)} /></Campo>
        <Campo rotulo="Repita a nova senha" erro={repete && repete !== nova ? 'As senhas não conferem' : undefined}><input type={ver ? 'text' : 'password'} autoComplete="new-password" value={repete} onChange={(e) => setRepete(e.target.value)} /></Campo>
        {trocar.isSuccess && <div className="aviso ok">Senha trocada.</div>}
        {trocar.error && <Erro erro={trocar.error} />}
        <label className="check"><input type="checkbox" checked={ver} onChange={(e) => setVer(e.target.checked)} /> Mostrar a senha</label>
        <button className="botao" disabled={(!provisoria && !atual) || nova.length < 8 || nova !== repete || trocar.isPending} onClick={() => trocar.mutate()}>{provisoria ? 'Salvar e entrar' : 'Trocar senha'}</button>
      </div>
    </>
  );
}
