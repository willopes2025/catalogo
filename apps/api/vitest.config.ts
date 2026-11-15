import { defineConfig } from 'vitest/config';

// Testes de unidade ficam em src/. O de ponta a ponta (test/e2e.test.mjs) roda com node --test via test/rodar-e2e.sh.
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
