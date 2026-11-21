import * as XLSX from 'xlsx';
import type { Campaign, ParsedCsvResult, Recipient } from '../types';

export interface NormalizedPhoneResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

export interface ParsedSpreadsheetResult extends ParsedCsvResult {
  fileType: 'excel' | 'csv';
  sheetNames: string[];
  activeSheet: string;
  hasHeaderRow: boolean;
  /** Keep workbook reference in memory when multiple sheets exist */
  workbook?: XLSX.WorkBook;
}

/**
 * Normalizes a raw phone string or Excel numeric cell into digits-only E.164 format
 * required by https://wa.me/<number>
 */
export function normalizePhone(
  raw: string,
  defaultCountryCode = '91'
): NormalizedPhoneResult {
  let trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { valid: false, normalized: '', error: 'Empty number' };
  }

  // Handle Excel scientific notation strings like "9.19877E+11" or trailing ".0"
  if (/^\d+(\.\d+)?[eE][+-]?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) {
      trimmed = Math.round(num).toFixed(0);
    }
  } else if (/^\+?\d+\.0+$/.test(trimmed)) {
    trimmed = trimmed.replace(/\.0+$/, '');
  }

  const hasExplicitPlus = trimmed.startsWith('+');
  const hasExplicitDoubleZero = trimmed.startsWith('00');
  let digits = trimmed.replace(/\D/g, '');
  const cc = (defaultCountryCode || '').replace(/\D/g, '');

  if (hasExplicitDoubleZero && digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (!hasExplicitPlus && !hasExplicitDoubleZero) {
    // Strip leading single 0 on local formats like 09876543210
    if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
      digits = digits.slice(1);
    }
    // Prepend default country code only for local 10-digit numbers
    // Numbers already containing country code (e.g. 919876543210, 12 digits) remain untouched
    if (cc && digits.length === 10) {
      digits = `${cc}${digits}`;
    }
  }

  if (digits.length < 7 || digits.length > 15) {
    return {
      valid: false,
      normalized: digits,
      error: `Invalid length (${digits.length} digits)`,
    };
  }

  return { valid: true, normalized: digits };
}

/**
 * Formats a normalized digit string for readable tabular display (e.g. +91 98765 43210)
 */
export function formatDisplayPhone(digits: string): string {
  if (!digits) return '';
  if (digits.startsWith('91') && digits.length === 12) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length > 10) {
    const ccLen = digits.length - 10;
    return `+${digits.slice(0, ccLen)} ${digits.slice(ccLen, ccLen + 5)} ${digits.slice(ccLen + 5)}`;
  }
  return `+${digits}`;
}

export function getRecipientDisplayLabel(
  recipient: Pick<Recipient, 'name' | 'phone'>
): string {
  return recipient.name?.trim() || formatDisplayPhone(recipient.phone);
}

export function buildRecipientViewUrl(
  origin: string,
  campaignId: string,
  recipientId: string
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  return `${cleanOrigin}/view/${encodeURIComponent(campaignId)}/${encodeURIComponent(recipientId)}`;
}

/**
 * Renders personalized message text for a specific recipient, substituting {{variables}}
 * and optionally attaching the tracked media/receipt link.
 */
export function renderPersonalizedMessage(
  campaign: Pick<Campaign, 'id' | 'message' | 'attachments' | 'settings'>,
  recipient: Pick<Recipient, 'id' | 'name' | 'phone' | 'customFields'>,
  origin: string
): string {
  const vars: Record<string, string> = {
    name: recipient.name?.trim() || '',
    phone: recipient.phone || '',
    ...(recipient.customFields || {}),
  };

  let rendered = (campaign.message || '').replace(
    /\{\{\s*([a-zA-Z0-9_\- ]+)\s*\}\}/g,
    (_, rawKey: string) => {
      const key = rawKey.trim().toLowerCase();
      for (const [k, v] of Object.entries(vars)) {
        if (k.toLowerCase() === key) {
          return v ?? '';
        }
      }
      return '';
    }
  );

  rendered = rendered
    .replace(/\*\*\s*/g, '')
    .replace(/__\s*/g, '')
    .replace(/~~\s*/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?])/g, '$1')
    .trim();

  const hasAttachments = campaign.attachments.length > 0;
  const shouldAppendLink =
    (hasAttachments && campaign.settings.includeMediaLink) ||
    (!hasAttachments && campaign.settings.includeTrackingLinkWhenNoMedia);

  if (shouldAppendLink) {
    const viewUrl = buildRecipientViewUrl(origin, campaign.id, recipient.id);
    const label = hasAttachments
      ? campaign.attachments.length === 1
        ? `Web download (${campaign.attachments[0].originalName}):`
        : `Web downloads (${campaign.attachments.length} files):`
      : 'View full notice:';
    rendered = rendered ? `${rendered}\n\n${label}\n${viewUrl}` : `${label}\n${viewUrl}`;
  }

  return rendered;
}

/**
 * Builds the official https://wa.me/<phone>?text=<encoded> link
 */
export function buildWaMeUrl(phoneDigits: string, messageText: string): string {
  const cleanPhone = (phoneDigits || '').replace(/\D/g, '');
  const base = `https://wa.me/${cleanPhone}`;
  if (!messageText || !messageText.trim()) {
    return base;
  }
  return `${base}?text=${encodeURIComponent(messageText)}`;
}

/**
 * Launches a https://wa.me/... link cleanly via a real anchor click (avoids window.open)
 */
export function openExternalLinkViaAnchor(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Checks if a single cell value looks like a phone number (e.g. +919876543210, 919876543210, 98765-43210)
 */
function looksLikePhoneCell(cell: string): boolean {
  const trimmed = (cell || '').trim();
  if (!trimmed) return false;
  // Must not contain letters (except scientific notation)
  if (/[a-df-zA-DF-Z]/.test(trimmed)) return false;
  const norm = normalizePhone(trimmed, '');
  return norm.valid && norm.normalized.length >= 7 && norm.normalized.length <= 15;
}

/**
 * Converts a raw Excel cell value cleanly into a string without scientific notation loss
 */
function excelCellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // Preserve full integer precision for phone numbers like 919876543210
    if (Number.isInteger(value) || Math.abs(value - Math.round(value)) < 1e-6) {
      return Math.round(value).toFixed(0);
    }
    return String(value);
  }
  return String(value).trim();
}

/**
 * Converts a 2D matrix of string rows into structured headers + row objects,
 * automatically detecting headerless sheets (such as phone-only Excel sheets).
 */
function matrixToParsedRows(matrix: string[][]): {
  headers: string[];
  rows: Record<string, string>[];
  totalRows: number;
  hasHeaderRow: boolean;
} {
  // Trim trailing completely empty columns
  const nonEmptyRows = matrix
    .map((row) => row.map((c) => (c ?? '').trim()))
    .filter((row) => row.some((c) => c !== ''));

  if (nonEmptyRows.length === 0) {
    return { headers: [], rows: [], totalRows: 0, hasHeaderRow: false };
  }

  const maxCols = Math.max(...nonEmptyRows.map((r) => r.length));
  // Drop columns that are completely empty across all rows
  const activeColIndices: number[] = [];
  for (let col = 0; col < maxCols; col++) {
    if (nonEmptyRows.some((r) => (r[col] || '') !== '')) {
      activeColIndices.push(col);
    }
  }

  const cleanedMatrix = nonEmptyRows.map((r) =>
    activeColIndices.map((idx) => r[idx] || '')
  );

  const firstRow = cleanedMatrix[0];
  // If ANY cell in the first row looks like a phone number, treat it as a data row (no header!)
  const firstRowHasPhone = firstRow.some((cell) => looksLikePhoneCell(cell));
  const hasHeaderRow = !firstRowHasPhone;

  let headers: string[];
  let dataRows: string[][];

  if (!hasHeaderRow) {
    if (firstRow.length === 1) {
      headers = ['Phone Number'];
    } else {
      headers = firstRow.map((cell, idx) =>
        looksLikePhoneCell(cell)
          ? idx === 0
            ? 'Phone Number'
            : `Phone ${idx + 1}`
          : `Column ${idx + 1}`
      );
    }
    dataRows = cleanedMatrix;
  } else {
    const usedNames = new Map<string, number>();
    headers = firstRow.map((h, idx) => {
      const base = h || `Column ${idx + 1}`;
      const count = usedNames.get(base) || 0;
      usedNames.set(base, count + 1);
      return count === 0 ? base : `${base} (${count + 1})`;
    });
    dataRows = cleanedMatrix.slice(1);
  }

  const rows: Record<string, string>[] = dataRows.map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((header, idx) => {
      obj[header] = (cells[idx] ?? '').trim();
    });
    return obj;
  });

  return {
    headers,
    rows,
    totalRows: rows.length,
    hasHeaderRow,
  };
}

/**
 * Extracts a specific worksheet from a SheetJS workbook cleanly
 */
export function extractWorkbookSheet(
  workbook: XLSX.WorkBook,
  sheetName: string
): ParsedSpreadsheetResult {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return {
      fileType: 'excel',
      sheetNames: workbook.SheetNames,
      activeSheet: sheetName,
      hasHeaderRow: false,
      headers: [],
      rows: [],
      totalRows: 0,
      workbook,
    };
  }

  // raw: true keeps numeric phone numbers intact (no "9.19877E+11" display truncation)
  const rawMatrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: true,
    blankrows: false,
  });

  const stringMatrix = rawMatrix.map((row) =>
    Array.isArray(row) ? row.map(excelCellToString) : []
  );

  const parsed = matrixToParsedRows(stringMatrix);
  return {
    fileType: 'excel',
    sheetNames: workbook.SheetNames,
    activeSheet: sheetName,
    workbook,
    ...parsed,
  };
}

/**
 * Efficient RFC-4180 compliant CSV/TSV/semicolon-separated parser
 */
export function parseCsvText(input: string): ParsedCsvResult & { hasHeaderRow: boolean } {
  const text = input.replace(/^\uFEFF/, '');
  // Detect delimiter from first non-empty line (supports comma, tab, semicolon)
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const tabCount = (firstLine.match(/\t/g) || []).length;
  const semiCount = (firstLine.match(/;/g) || []).length;
  const delimiter =
    tabCount > commaCount && tabCount >= semiCount
      ? '\t'
      : semiCount > commaCount && semiCount > tabCount
        ? ';'
        : ',';

  const matrix: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        row.push(field.trim());
        field = '';
      } else if (ch === '\r' && next === '\n') {
        row.push(field.trim());
        if (row.some((cell) => cell !== '')) {
          matrix.push(row);
        }
        row = [];
        field = '';
        i++;
      } else if (ch === '\n' || ch === '\r') {
        row.push(field.trim());
        if (row.some((cell) => cell !== '')) {
          matrix.push(row);
        }
        row = [];
        field = '';
      } else {
        field += ch;
      }
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field.trim());
    if (row.some((cell) => cell !== '')) {
      matrix.push(row);
    }
  }

  return matrixToParsedRows(matrix);
}

/**
 * Parses either an Excel workbook (.xlsx, .xls, .xlsm, .xlsb, .ods) or a CSV/TSV/TXT file.
 * Detects Excel binary magic bytes automatically even if extension is missing or misnamed.
 */
export async function parseSpreadsheetFile(
  file: File
): Promise<ParsedSpreadsheetResult> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer.slice(0, 8));

  const isZipMagic = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b; // PK (.xlsx/.xlsm/.ods)
  const isOle2Magic =
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0; // Legacy .xls

  const ext = file.name.toLowerCase().split('.').pop() || '';
  const isExcelExt = ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods'].includes(ext);

  if (isZipMagic || isOle2Magic || isExcelExt) {
    const workbook = XLSX.read(buffer, { type: 'array', raw: true });
    const firstSheet = workbook.SheetNames[0];
    if (!firstSheet) {
      return {
        fileType: 'excel',
        sheetNames: [],
        activeSheet: '',
        hasHeaderRow: false,
        headers: [],
        rows: [],
        totalRows: 0,
        workbook,
      };
    }
    return extractWorkbookSheet(workbook, firstSheet);
  }

  const text = new TextDecoder('utf-8').decode(buffer);
  const parsed = parseCsvText(text);
  return {
    fileType: 'csv',
    sheetNames: ['CSV'],
    activeSheet: 'CSV',
    ...parsed,
  };
}

/**
 * Auto-detects the most likely phone column (and optional name column) using BOTH
 * header labels AND actual cell values. Returns empty nameColumn when the sheet
 * only contains phone numbers.
 */
export function autoDetectCsvColumns(
  headers: string[],
  rows: Record<string, string>[] = []
): {
  phoneColumn: string;
  nameColumn: string;
} {
  if (headers.length === 0) {
    return { phoneColumn: '', nameColumn: '' };
  }

  if (headers.length === 1) {
    return { phoneColumn: headers[0], nameColumn: '' };
  }

  const lowerHeaders = headers.map((h) => ({ raw: h, lower: h.toLowerCase() }));

  // 1. Score each column by how many sample rows look like phone numbers
  const sample = rows.slice(0, 25);
  let bestPhoneCol = '';
  let bestPhoneScore = -1;

  for (const h of lowerHeaders) {
    let score = 0;
    if (/(whatsapp|phone|mobile|number|tel|cell|contact|msisdn)/.test(h.lower)) {
      score += 10;
    }
    for (const r of sample) {
      if (looksLikePhoneCell(r[h.raw] || '')) {
        score += 2;
      }
    }
    if (score > bestPhoneScore) {
      bestPhoneScore = score;
      bestPhoneCol = h.raw;
    }
  }

  const phoneColumn = bestPhoneCol || headers[0];

  // 2. Only auto-pick a name column if a non-phone column explicitly looks like a name
  const nameMatch =
    lowerHeaders.find(
      (h) =>
        h.raw !== phoneColumn &&
        /(^name$|full.?name|first.?name|customer|client|recipient|contact.?name)/.test(
          h.lower
        )
    )?.raw || '';

  return {
    phoneColumn,
    nameColumn: nameMatch,
  };
}

/**
 * Generates and downloads a clean single-column Excel (.xlsx) template containing only phone numbers with country codes
 */
export function downloadSampleExcelFile(filename = 'sendline-numbers-sample.xlsx'): void {
  const rows = [
    ['Phone Number'],
    ['919820155443'],
    ['919811234567'],
    ['919945011223'],
    ['919898765432'],
    ['919876500112'],
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 20 }];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Numbers');
  XLSX.writeFile(workbook, filename);
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatClockTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatShortDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function generateDeliveryReportCsv(
  campaign: Campaign,
  origin: string
): string {
  const escapeCsv = (val: string | number | null | undefined) => {
    const str = String(val ?? '');
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = [
    'Phone',
    'Name',
    'Status',
    'Dispatched At',
    'Sent At',
    'Opened At',
    'Link Opens',
    'Failed Reason',
    'wa.me Link',
  ];

  const lines = [headers.join(',')];
  for (const r of campaign.recipients) {
    const renderedMsg = renderPersonalizedMessage(campaign, r, origin);
    const waUrl = buildWaMeUrl(r.phone, renderedMsg);
    lines.push(
      [
        r.phone,
        r.name,
        r.status,
        r.dispatchedAt || '',
        r.sentAt || '',
        r.openedAt || '',
        r.openCount,
        r.failedReason || '',
        waUrl,
      ]
        .map(escapeCsv)
        .join(',')
    );
  }
  return lines.join('\r\n');
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/csv;charset=utf-8;'
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
