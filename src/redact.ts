export function redact(text: string): string {
  return text
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:API_KEY|ACCESS_TOKEN|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)(\S+)/gi, '$1[REDACTED]')
}
