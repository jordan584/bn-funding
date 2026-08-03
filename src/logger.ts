export type LogLevel = 'info' | 'warn' | 'error';

const REDACTED = '[REDACTED]';
const SENSITIVE_FIELD_NAMES = new Set([
  'google_chat_webhook_url',
  'googlechatwebhookurl'
]);
const GOOGLE_CHAT_WEBHOOK_PATTERN =
  /https?:\/\/chat\.googleapis\.com(?:\/[^\s"']*)?/giu;

function redactGoogleChatWebhooks(value: string): string {
  return value.replace(GOOGLE_CHAT_WEBHOOK_PATTERN, REDACTED);
}

function serializeLogValue(_key: string, value: unknown): unknown {
  if (SENSITIVE_FIELD_NAMES.has(_key.toLowerCase())) {
    return REDACTED;
  }

  if (value instanceof Error) {
    return { name: value.name, message: redactGoogleChatWebhooks(value.message) };
  }

  if (typeof value === 'string') {
    return redactGoogleChatWebhooks(value);
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
