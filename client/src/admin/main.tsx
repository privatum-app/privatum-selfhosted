import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Admin } from './Admin.tsx';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../styles.css';
import './admin.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
