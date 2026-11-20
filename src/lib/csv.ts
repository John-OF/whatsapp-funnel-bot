/**
 * Serializa filas a CSV (RFC 4180). Las celdas de texto que empiezan con `= + - @` se prefijan con `'`
 * para evitar la inyección de fórmulas al abrir el archivo en Excel o Google Sheets.
 */
export function toCsv(headers: string[], rows: (string | number | boolean | Date | null | undefined)[][]): string {
  const cell = (v: string | number | boolean | Date | null | undefined): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
