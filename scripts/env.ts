// The scripts share the web server's loader so that a variable resolves the
// same way whether it came from systemd, the shell, or the .env file.
export { loadEnvFile as loadEnv } from '../src/lib/server/env.ts';
