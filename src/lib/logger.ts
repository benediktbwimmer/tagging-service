import pino from 'pino';
import { getConfig } from '../config';

const { LOG_LEVEL, NODE_ENV } = getConfig();

function resolveTransport() {
  if (NODE_ENV !== 'development') {
    return undefined;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require.resolve('pino-pretty');
    return {
      target: 'pino-pretty',
      options: { colorize: true }
    } as const;
  } catch (err) {
    return undefined;
  }
}

export const logger = pino({
  level: LOG_LEVEL,
  transport: resolveTransport()
});
