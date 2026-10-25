import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin } from './Admin.tsx';
import { lang, t } from '../i18n.ts';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles.css';
import './admin.css';

document.documentElement.lang = lang() === 'en' ? 'en' : 'pt-BR';
document.title = t('Painel do Privatum');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
