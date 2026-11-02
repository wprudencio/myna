/* Debug log. Off unless --debug. Transcript text is never written here. */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function createLogger(path, enabled = false) {
  if (!enabled) {
    return { log() {}, error() {} };
  }

  let ready = null;
  const write = (line) => {
    const stamp = new Date().toISOString();
    ready = (ready ?? mkdir(dirname(path), { recursive: true }))
      .then(() => appendFile(path, `${stamp} ${line}\n`))
      .catch(() => {});
  };

  return {
    log(...parts) {
      write(parts.map((part) => (typeof part === "string" ? part : safeJson(part))).join(" "));
    },
    error(error) {
      if (error?.stack) write(error.stack);
      else write(String(error?.message ?? error));
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
