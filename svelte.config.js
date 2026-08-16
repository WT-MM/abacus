import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({ out: 'build' }),

		// CSP is declared here rather than as a header in hooks so that SvelteKit
		// can hash its own inline hydration scripts. Setting the header by hand
		// blocks them and the app loads but never becomes interactive.
		//
		// Plaid Link is the only third party: its script, its iframe, and its API.
		csp: {
			mode: 'auto',
			directives: {
				'default-src': ['self'],
				'script-src': ['self', 'https://cdn.plaid.com'],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:'],
				'font-src': ['self'],
				'connect-src': ['self', 'https://*.plaid.com'],
				'frame-src': ['https://cdn.plaid.com', 'https://*.plaid.com'],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'base-uri': ['none'],
				'object-src': ['none']
			}
		}

		// Origin checking stays on (the default). `tailscale serve` terminates TLS
		// and proxies to loopback, so the ORIGIN environment variable must be set
		// to the public https URL or every form POST is rejected as cross-site.
	}
};
