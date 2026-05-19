import pino from 'pino';

/**
 * Detecta si estamos corriendo dentro de un Single Executable Application (SEA).
 *
 * Cuando el agente esta empaquetado como .exe via Node SEA, el transport
 * `pino-pretty` no funciona porque depende de worker_threads que SEA no soporta
 * bien (carga el modulo desde el filesystem, pero el modulo no existe afuera
 * del binary). En ese caso caemos a JSON estructurado puro, que se ve menos
 * lindo pero es 100% robusto y machine-parseable.
 *
 * Para detectar SEA usamos la API oficial `node:sea` introducida en Node 20.12.
 * Si no esta disponible, asumimos que estamos en dev/tsx/node normal.
 */
function isRunningInSea(): boolean {
  try {
    // require() en runtime para no romper el bundle si el modulo no existe.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sea = require('node:sea');
    return typeof sea?.isSea === 'function' ? sea.isSea() : false;
  } catch {
    return false;
  }
}

/**
 * Logger central. En dev usa pino-pretty con colores; en prod (NODE_ENV=production
 * o corriendo desde el .exe empaquetado) sale en JSON estructurado.
 */
export function createLogger(level: string = 'info') {
  const isDev = process.env.NODE_ENV !== 'production';
  const inSea = isRunningInSea();
  const usePretty = isDev && !inSea;

  return pino({
    level,
    ...(usePretty && {
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
