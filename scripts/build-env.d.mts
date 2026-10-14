export function parseDotEnv(text: string): Record<string, string>;
export function decodeJwtPayload(token: string): Record<string, unknown> | null;
export function validateSupabaseConfig(config: { url?: string; anonKey?: string }): string[];
export function resolveBuildEnv(options: {
  production: boolean;
  cwd?: string;
  env?: Record<string, string | undefined>;
}): Promise<{ url: string; anonKey: string; warnings: string[] }>;
