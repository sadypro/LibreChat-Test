export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** JSON-lines logger; callers pass only safe, already-redacted fields. */
export function createLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const log =
    (level: string) =>
    (event: string, fields: LogFields = {}): void =>
      write(JSON.stringify({ time: new Date().toISOString(), level, event, ...fields }));
  return { info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
