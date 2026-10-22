import { join } from 'node:path'
import { homedir } from 'node:os'

/** Single source of truth for on-disk locations; the stdio bridge mirrors this logic. */
export function dataDir(): string {
  return process.env.FTP_MAN_DIR || join(homedir(), 'Library', 'Application Support', 'ftp-man')
}

export const files = {
  servers: () => join(dataDir(), 'servers.json'),
  settings: () => join(dataDir(), 'settings.json'),
  token: () => join(dataDir(), 'mcp-token'),
  activity: () => join(dataDir(), 'activity.jsonl')
}
