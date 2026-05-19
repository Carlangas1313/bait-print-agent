import pino from 'pino';

/**
 * Logger central. En dev usa pino-pretty con colores, en prod (NODE_ENV=production)
 * sale en JSON estructurado para que sea machine-parseable.
 */
export function createLogger(level: string = 'info') {
  const isDev = process.env.NODE_ENV !== 'production';

  return pino({
    level,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname'
        }
      }
    })
  });
}

export type Logger = ReturnType<typeof createLogger>;
