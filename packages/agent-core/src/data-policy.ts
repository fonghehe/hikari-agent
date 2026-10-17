import type { Message, ModelRequest } from './index';

/** Default exclusions apply to reads, writes, discovery and code-history snapshots. */
export function sensitivePath(filename: string): boolean {
  const parts = filename.replace(/\\/g, '/').toLowerCase().split('/');
  return parts.some((part) =>
    /^(?:\.env(?:[.-].*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|kubeconfig|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.aws|\.ssh|\.kube|\.docker|\.secrets)$/.test(
      part,
    )
      ? !/^\.env(?:[.-].*)?\.(?:example|sample|template)$/.test(part) &&
        !/^\.env\.(?:example|sample|template)$/.test(part)
      : /\.(?:key|pem|p12|pfx|jks|keystore)$/.test(part),
  );
}

/** Best-effort text protection, not a guarantee against arbitrary encoded secrets. */
export function redactText(text: string, credentials: readonly string[] = []): string {
  for (const value of credentials)
    if (value.length >= 8) text = text.split(value).join('[REDACTED]');
  return text
    .replace(
      /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      (block) => '[REDACTED PRIVATE KEY]' + '\n'.repeat((block.match(/\n/g) ?? []).length),
    )
    .replace(
      /\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{16,}|github_pat_[\w]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[\w-]{30,}|xox[baprs]-[\w-]{12,})/gi,
      '[REDACTED]',
    )
    .replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9+/_=.-]+/gi, '[REDACTED]')
    .replace(/(\b[a-z][\w+.-]*:\/\/[^\s/:]+:)[^\s/@]+(@)/gi, '$1[REDACTED]$2')
    .replace(
      /("(?:[\w-]*api[_-]?key|[\w-]*password|[\w-]*token|[\w-]*secret|authorization|auth)"\s*:\s*")([^"]*)(")/gi,
      (all, prefix: string, value: string, suffix: string) =>
        value && value !== '[REDACTED]' ? prefix + '[REDACTED]' + suffix : all,
    )
    .replace(
      /((?:api[_-]?key|password|token|secret|authorization)\s*[=:]\s*)("[^"\r\n]+"|'[^'\r\n]+')/gi,
      '$1"[REDACTED]"',
    )
    .replace(
      /(^|\n)([A-Z][A-Z0-9_]*(?:KEY|TOKEN|PASSWORD|SECRET)[ \t]*=[ \t]*)([^\s#;]+)/g,
      '$1$2[REDACTED]',
    )
    .replace(
      /(^|\n)([ \t]*(?:[\w-]*api[_-]?key|[\w-]*password|[\w-]*token|[\w-]*secret|authorization)\s*[=:]\s*)([A-Za-z0-9+/_=.-]+)(?=$|[\s,;])/gi,
      (all, start: string, prefix: string, value: string) =>
        ['await', 'new', 'this', 'process', 'true', 'false', 'null', 'undefined'].includes(value)
          ? all
          : start + prefix + '[REDACTED]',
    )
    .replace(/(--(?:api[-_]?key|password|token|secret)(?:=|\s+))[^\s]+/gi, '$1[REDACTED]');
}

export function sensitiveField(key: string): boolean {
  return /(?:api[_-]?key|password|secret|authorization|auth|token)$/i.test(key);
}

function textFields(value: unknown, credentials: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, credentials);
  if (Array.isArray(value)) return value.map((item) => textFields(item, credentials));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        /^(?:thought_?signature|signature)$/i.test(key)
          ? entry
          : sensitiveField(key) && (typeof entry === 'string' || typeof entry === 'number')
            ? '[REDACTED]'
            : textFields(entry, credentials),
      ]),
    );
  return value;
}

export function sanitizeMessage(message: Message, credentials: readonly string[] = []): Message {
  return {
    ...message,
    content: redactText(message.content, credentials),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            input: textFields(call.input, credentials),
          })),
        }
      : {}),
    ...(message.references
      ? {
          references: message.references.map((reference) => ({
            ...reference,
            ...(reference.text !== undefined
              ? { text: redactText(reference.text, credentials) }
              : {}),
          })),
        }
      : {}),
    ...(message.providerData
      ? { providerData: textFields(message.providerData, credentials) as Record<string, unknown> }
      : {}),
  };
}

export function sanitizeModelRequest(
  request: ModelRequest,
  credentials: readonly string[] = [],
): ModelRequest {
  return {
    ...request,
    messages: request.messages.map((message) => sanitizeMessage(message, credentials)),
  };
}
