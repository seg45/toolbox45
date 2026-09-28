import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/base.css';
import '../styles/theme.css';
import '../styles/components.css';
import '../styles/login.css';
import LoginPage from './LoginPage';

// Rodapé "Developed by SEG45" — irmão de .login-card (não dentro dela),
// mesmo layout do login.html original (ver css/login.css .login-body/
// .login-credit).
function LoginPageWithCredit() {
  return (
    <>
      <LoginPage />
      <a className="login-credit" href="https://seg45.com.br" target="_blank" rel="noopener noreferrer">
        <span className="sb-credit-txt">Developed by SEG45</span>
      </a>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LoginPageWithCredit />
  </React.StrictMode>
);
