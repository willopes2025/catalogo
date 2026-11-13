import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, salvarSessao, type Sessao } from '../api';
import { Erro } from '../componentes/ui';

export function Entrar() {
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<unknown>(null);
  const [enviando, setEnviando] = useState(false);
  const navegar = useNavigate();

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const s = await api<Sessao & { trocarSenha?: boolean }>('/auth/login', { corpo: { email, senha } });
      salvarSessao({ token: s.token, usuario: s.usuario });
      navegar(s.trocarSenha ? '/minha-senha' : '/');
    } catch (err) {
      setErro(err);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="login">
      <div className="lado">
        <img src="/logo-creme.png" alt="Aritana Semijoias" />
        <h1>Matriz, representantes, lojas e eventos num só sistema.</h1>
        <p style={{ color: '#d9cfc1', fontSize: 13 }}>Plataforma Aritana · Wide Inteligência Comercial</p>
      </div>
      <form onSubmit={enviar}>
        <h2>Entrar</h2>
        <div className="campo">
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="campo">
          <label htmlFor="senha">Senha</label>
          <input id="senha" type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} required />
        </div>
        <Erro erro={erro} />
        <button className="botao" disabled={enviando}>
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
