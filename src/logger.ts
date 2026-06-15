export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

export function createLogger(level: LogLevel = "info"): Logger {
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = order[level];

  function write(current: LogLevel, message: string, fields: Record<string, unknown> = {}) {
    if (order[current] < min) return;
    const payload = Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(" ");
    const line = `[${new Date().toISOString()}] level=${current} message=${JSON.stringify(message)}${payload ? ` ${payload}` : ""}`;
    const target = current === "error" || current === "warn" ? console.error : console.log;
    target(line);
  }

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields)
  };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(redact(value));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return JSON.stringify(value);
  return JSON.stringify(redact(JSON.stringify(value)));
}

function redact(value: string): string {
  return value
    .replace(/gh[opsur]_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "<redacted>")
    .replace(/Authorization:\s*Bearer\s+[^\s"]+/gi, "Authorization: Bearer <redacted>")
    .replace(/x-access-token:[^\s"]+/gi, "x-access-token:<redacted>")
    .replace(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "<redacted>");
}
