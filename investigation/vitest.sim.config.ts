import { defineConfig } from 'vitest/config';
// Separate config so `npm test` (unit tests) never picks these up.
export default defineConfig({
	resolve: { extensions: ['.ts', '.mts', '.js', '.mjs', '.json'] },
	test: { include: ['investigation/sim/*.sim.ts'], root: process.env.SIM_ROOT ?? process.cwd() },
});
