import React from 'react';
import ReactDOM from 'react-dom/client';
import { bootstrapRuntimeContext } from '@/lib/runtime-context';

async function start() {
  await bootstrapRuntimeContext();
  const { default: App } = await import('./App');

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();

