/** Minimal RFC 4180 CSV parser/serializer (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.length > 0)) rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  row.push(field)
  if (row.some((c) => c.length > 0)) rows.push(row)
  return rows
}

export function toCsv(rows: string[][]): string {
  const esc = (v: string): string => (/[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v)
  return rows.map((r) => r.map((c) => esc(c ?? '')).join(',')).join('\n') + '\n'
}
