import React from 'react';
import ReactDOM from 'react-dom/client';
import '../styles/base.css';
import '../styles/theme.css';
import '../styles/layout.css';
import '../styles/components.css';
import { AuthProvider } from '../lib/auth';
import { AppShell } from '../components/AppShell';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  </React.StrictMode>
);
