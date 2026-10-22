import type { ServerRecord } from '@shared/types'

export type ServerPublic = ServerRecord & { insecureTls: boolean }
export const api = window.api
