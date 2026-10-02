import '@/styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { applyTheme, cachedTheme } from './lib/theme';

async function boot() {
  // Light unless this browser remembers a saved dark preference; /me is authoritative once loaded.
  applyTheme(cachedTheme() ?? 'light');
  if (import.meta.env.VITE_MOCK_API === 'true') {
    const { startMocking } = await import('./mocks/browser');
    await startMocking();
  }
  const el = document.getElementById('root');
  if (!el) throw new Error('#root not found');
  createRoot(el).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
