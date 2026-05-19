import { z } from 'zod';

/**
 * Valida el .env del agente con zod. Si falta algo o tiene el formato
 * incorrecto, abortamos al inicio con un mensaje claro en lugar de
 * crashear más tarde con un error opaco.
 */
const ConfigSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  BAIT_AGENT_ID: z.string().uuid(),
  BAIT_RESTAURANT_ID: z.string().uuid(),
  BAIT_LOCATION_ID: z.string().uuid(),
  BAIT_AGENT_MODE: z.enum(['console', 'usb']).default('console'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(30)
});

export type AgentConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AgentConfig {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('❌ Configuración inválida. Revisar .env contra .env.example:');
    for (const issue of parsed.error.issues) {
      console.error(`   · ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}
