export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function createLogger(prefix: string): Logger {
  const write = (level: string, msg: string): void => {
    process.stderr.write(`[${prefix}] [${level}] ${msg}\n`);
  };

  return {
    info: (msg) => write('info', msg),
    warn: (msg) => write('warn', msg),
    error: (msg) => write('error', msg),
    debug: (msg) => {
      if (process.env.CF_DEBUG === '1') {
        write('debug', msg);
      }
    },
  };
}
