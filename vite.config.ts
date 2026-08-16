import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	// Bind to loopback only. The Tailscale identity header is trusted, so the
	// app must never be reachable except through the `tailscale serve` proxy.
	server: { host: '127.0.0.1', port: 5173 },
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'node'
	}
});
