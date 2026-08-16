import type { AuthState } from '$lib/server/auth/identity.ts';

declare global {
	namespace App {
		interface Locals {
			auth: AuthState;
		}
		interface PageData {
			auth?: AuthState;
		}
	}
}

export {};
