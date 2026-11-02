/* Transcript history in ~/.myna/history.json. Newest first. */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const LIMIT = 100;

export async function loadHistory(path) {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8"));
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((entry) => entry && typeof entry.text === "string" && entry.text.trim())
      .slice(0, LIMIT)
      .map((entry) => ({
        text: entry.text,
        at: Number(entry.at) || Date.now(),
        audioSec: Number(entry.audioSec) || 0,
        ms: Number(entry.ms) || 0,
        device: typeof entry.device === "string" ? entry.device : "",
      }));
  } catch {
    return [];
  }
}

export async function saveHistory(path, entries) {
  const body = JSON.stringify({ version: 1, entries: entries.slice(0, LIMIT) }, null, 2);
  const temp = `${path}.${process.pid}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(temp, body);
  await fs.rename(temp, path);
}

export function addHistory(entries, entry, limit = LIMIT) {
  return [entry, ...entries].slice(0, limit);
}

export { LIMIT as HISTORY_LIMIT };
