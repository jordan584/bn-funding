export type LogLevel = 'info' | 'warn' | 'error';

function serializeLogValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  return value;
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  process.stdout.write(
    `${JSON.stringify({ level, event, ...fields }, serializeLogValue)}\n`
  );
}
