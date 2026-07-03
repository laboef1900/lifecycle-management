import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { fetchAuthState } from '@/lib/auth';

import { App } from './app.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root element in index.html');
}

const root = createRoot(container);

void fetchAuthState().then((auth) => {
  root.render(
    <StrictMode>
      <App auth={auth} />
    </StrictMode>,
  );
});
