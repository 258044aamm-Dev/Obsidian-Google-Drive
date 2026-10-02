import { defineConfig } from 'vitest/config';
export default defineConfig({
	test: { include: ['investigation/interop/interop.mixed.ts'], environment: 'node', testTimeout: 60000, fileParallelism: false },
});
