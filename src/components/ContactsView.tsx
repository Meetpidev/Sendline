import { useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  Plus,
  Search,
  Send,
  Trash2,
  Upload,
  UserPlus,
} from 'lucide-react';
import type { Campaign } from '../types';
import {
  autoDetectCsvColumns,
  downloadSampleExcelFile,
  downloadTextFile,
  extractWorkbookSheet,
  formatDisplayPhone,
  normalizePhone,
  parseSpreadsheetFile,
  type ParsedSpreadsheetResult,
} from '../utils/whatsapp';

interface ContactsViewProps {
  campaign: Campaign;
  origin: string;
  onUpdateCountryCode: (cc: string) => void;
  onImportContacts: (
    contacts: Array<{
      name?: string;
      rawPhone?: string;
      phone: string;
      customFields?: Record<string, string>;
    }>,
    replaceExisting: boolean
  ) => Promise<{ added: number; duplicates: number; invalid: number }>;
  onDeleteRecipient: (recipientId: string) => Promise<void>;
  onClearAllRecipients: () => Promise<void>;
  onLaunchSingle: (recipientId: string) => void;
  onNotify: (msg: string) => void;
}

type ImportMode = 'file' | 'paste' | 'single';

const COUNTRY_PRESETS = [
  { code: '91', label: '+91 India' },
  { code: '1', label: '+1 US / Canada' },
  { code: '44', label: '+44 United Kingdom' },
  { code: '971', label: '+971 UAE' },
  { code: '61', label: '+61 Australia' },
  { code: '65', label: '+65 Singapore' },
  { code: '49', label: '+49 Germany' },
];

const PAGE_SIZE = 50;

export function ContactsView({
  campaign,
  origin,
  onUpdateCountryCode,
  onImportContacts,
  onDeleteRecipient,
  onClearAllRecipients,
  onLaunchSingle,
  onNotify,
}: ContactsViewProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>('file');
  const [isDragging, setIsDragging] = useState(false);

  // Excel / CSV State
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [parsedFile, setParsedFile] = useState<ParsedSpreadsheetResult | null>(null);
  const [phoneColumn, setPhoneColumn] = useState('');
  const [nameColumn, setNameColumn] = useState('');
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);

  // Paste State
  const [pasteText, setPasteText] = useState('');

  // Single Contact State
  const [singlePhone, setSinglePhone] = useState('');
  const [singleName, setSingleName] = useState('');

  // Directory Filter & Pagination
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(1);
  const [confirmClear, setConfirmClear] = useState(false);

  const countryCode = campaign.defaultCountryCode || '91';
  const isPhoneOnlySheet = Boolean(parsedFile && parsedFile.headers.length === 1);

  // Preview spreadsheet validation stats
  const fileValidation = useMemo(() => {
    if (!parsedFile || !phoneColumn) return null;
    let validCount = 0;
    let invalidCount = 0;
    let dupesInFile = 0;
    const seen = new Set<string>();
    const previewRows: Array<{
      name: string;
      raw: string;
      normalized: string;
      valid: boolean;
      error?: string;
    }> = [];

    for (const row of parsedFile.rows) {
      const raw = row[phoneColumn] || '';
      const name = (nameColumn ? row[nameColumn] : '') || '';
      const norm = normalizePhone(raw, countryCode);
      if (!norm.valid) {
        invalidCount++;
      } else if (seen.has(norm.normalized)) {
        dupesInFile++;
      } else {
        seen.add(norm.normalized);
        validCount++;
      }
      if (previewRows.length < 8) {
        previewRows.push({
          name,
          raw,
          normalized: norm.normalized,
          valid: norm.valid,
          error: norm.error,
        });
      }
    }

    return { validCount, invalidCount, dupesInFile, previewRows };
  }, [parsedFile, phoneColumn, nameColumn, countryCode]);

  async function handleSpreadsheetFile(file: File) {
    try {
      const parsed = await parseSpreadsheetFile(file);
      if (parsed.totalRows === 0) {
        onNotify('No phone numbers or rows found in this file');
        return;
      }
      const detected = autoDetectCsvColumns(parsed.headers, parsed.rows);
      setUploadedFileName(file.name);
      setParsedFile(parsed);
      setPhoneColumn(detected.phoneColumn);
      setNameColumn(detected.nameColumn);
    } catch (err) {
      onNotify(
        err instanceof Error
          ? `Could not read file: ${err.message}`
          : 'Could not read spreadsheet file'
      );
    }
  }

  function handleSwitchWorksheet(sheetName: string) {
    if (!parsedFile?.workbook) return;
    const next = extractWorkbookSheet(parsedFile.workbook, sheetName);
    const detected = autoDetectCsvColumns(next.headers, next.rows);
    setParsedFile(next);
    setPhoneColumn(detected.phoneColumn);
    setNameColumn(detected.nameColumn);
  }

  async function commitSpreadsheetImport() {
    if (!parsedFile || !phoneColumn) return;
    setImporting(true);
    try {
      const payload = parsedFile.rows.map((row) => {
        const raw = row[phoneColumn] || '';
        const norm = normalizePhone(raw, countryCode);
        const customFields: Record<string, string> = {};
        if (parsedFile.headers.length > 1) {
          for (const [k, v] of Object.entries(row)) {
            if (k !== phoneColumn && k !== nameColumn && v) {
              customFields[k.toLowerCase().replace(/\s+/g, '_')] = v;
            }
          }
        }
        return {
          name: (nameColumn ? row[nameColumn] : '') || '',
          rawPhone: raw,
          phone: norm.valid ? norm.normalized : '',
          customFields,
        };
      });

      const result = await onImportContacts(payload, replaceExisting);
      onNotify(
        `Imported ${result.added.toLocaleString()} numbers (${result.duplicates} duplicates skipped, ${result.invalid} invalid)`
      );
      setParsedFile(null);
      setUploadedFileName('');
      setPage(1);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  async function commitBulkPaste() {
    const lines = pasteText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      onNotify('Paste at least one phone number first');
      return;
    }

    setImporting(true);
    try {
      const contacts: Array<{ name?: string; rawPhone: string; phone: string }> = [];
      for (const line of lines) {
        const parts = line
          .split(/[,\t;]+/)
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length === 2) {
          const firstIsPhone = normalizePhone(parts[0], countryCode).valid;
          const secondIsPhone = normalizePhone(parts[1], countryCode).valid;
          if (firstIsPhone && !secondIsPhone) {
            const norm = normalizePhone(parts[0], countryCode);
            contacts.push({ name: parts[1], rawPhone: parts[0], phone: norm.normalized });
          } else if (secondIsPhone && !firstIsPhone) {
            const norm = normalizePhone(parts[1], countryCode);
            contacts.push({ name: parts[0], rawPhone: parts[1], phone: norm.normalized });
          } else {
            for (const p of parts) {
              const norm = normalizePhone(p, countryCode);
              contacts.push({ rawPhone: p, phone: norm.valid ? norm.normalized : '' });
            }
          }
        } else {
          for (const p of parts) {
            const norm = normalizePhone(p, countryCode);
            contacts.push({ rawPhone: p, phone: norm.valid ? norm.normalized : '' });
          }
        }
      }

      const result = await onImportContacts(contacts, false);
      onNotify(
        `Added ${result.added.toLocaleString()} numbers (${result.duplicates} duplicates skipped, ${result.invalid} invalid)`
      );
      setPasteText('');
      setPage(1);
    } catch (err) {
      onNotify(err instanceof Error ? err.message : 'Bulk add failed');
    } finally {
      setImporting(false);
    }
  }

  async function commitSingleContact(e: React.FormEvent) {
    e.preventDefault();
    const norm = normalizePhone(singlePhone, countryCode);
    if (!norm.valid) {
      onNotify(`Invalid phone number: ${norm.error || 'check digits'}`);
      return;
    }
    setImporting(true);
    try {
      const result = await onImportContacts(
        [
          {
            name: singleName.trim(),
            rawPhone: singlePhone.trim(),
            phone: norm.normalized,
          },
        ],
        false
      );
      if (result.duplicates > 0) {
        onNotify(`Number +${norm.normalized} is already in this campaign`);
      } else {
        onNotify(`Added ${singleName.trim() || formatDisplayPhone(norm.normalized)}`);
        setSingleName('');
        setSinglePhone('');
      }
    } finally {
      setImporting(false);
    }
  }

  function downloadSampleCsv() {
    const sample = [
      'Phone Number',
      '919820155443',
      '919811234567',
      '919945011223',
      '919898765432',
      '919876500112',
    ].join('\r\n');
    downloadTextFile('sendline-numbers-sample.csv', sample);
  }

  // Filtered & paginated contact list
  const filteredRecipients = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return campaign.recipients;
    return campaign.recipients.filter(
      (r) =>
        r.phone.includes(q) ||
        r.name.toLowerCase().includes(q) ||
        Object.values(r.customFields || {}).some((v) =>
          v.toLowerCase().includes(q)
        )
    );
  }, [campaign.recipients, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageItems = filteredRecipients.slice(
    (safePage - 1) * PAGE_SIZE,
    safePage * PAGE_SIZE
  );

  const hasAnyNamesOrFields = campaign.recipients.some(
    (r) => r.name.trim() !== '' || Object.keys(r.customFields || {}).length > 0
  );

  return (
    <div className="space-y-6">
      {/* Import Control Surface */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md w-fit">
            <button
              type="button"
              onClick={() => setImportMode('file')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                importMode === 'file'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Excel / CSV Import
            </button>
            <button
              type="button"
              onClick={() => setImportMode('paste')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                importMode === 'paste'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Bulk Paste Numbers
            </button>
            <button
              type="button"
              onClick={() => setImportMode('single')}
              className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                importMode === 'single'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Add Single Number
            </button>
          </div>

          {/* Default Country Code Selector */}
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label
              htmlFor="country-code-select"
              className="font-medium text-slate-600 whitespace-nowrap"
            >
              Fallback Country Code:
            </label>
            <select
              id="country-code-select"
              value={
                COUNTRY_PRESETS.some((p) => p.code === countryCode)
                  ? countryCode
                  : 'custom'
              }
              onChange={(e) => {
                if (e.target.value !== 'custom') {
                  onUpdateCountryCode(e.target.value);
                }
              }}
              className="h-8 rounded border border-slate-200 bg-white px-2 text-xs font-mono text-slate-800 focus:border-emerald-600 focus:outline-none"
            >
              {COUNTRY_PRESETS.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
                </option>
              ))}
              {!COUNTRY_PRESETS.some((p) => p.code === countryCode) && (
                <option value="custom">+{countryCode}</option>
              )}
            </select>
            <input
              type="text"
              aria-label="Custom country code digits"
              value={countryCode}
              onChange={(e) =>
                onUpdateCountryCode(e.target.value.replace(/\D/g, '').slice(0, 4))
              }
              placeholder="91"
              className="w-16 h-8 rounded border border-slate-200 px-2 text-xs font-mono tabular-nums text-slate-900 focus:border-emerald-600 focus:outline-none"
            />
          </div>
        </div>

        <div className="p-6">
          {/* Mode 1: Excel & CSV Import */}
          {importMode === 'file' && (
            <div className="space-y-5">
              {!parsedFile ? (
                <>
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={() => setIsDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setIsDragging(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file) void handleSpreadsheetFile(file);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        fileInputRef.current?.click();
                      }
                    }}
                    className={`cursor-pointer rounded-md border border-dashed px-6 py-10 text-center transition-colors ${
                      isDragging
                        ? 'border-emerald-600 bg-emerald-50/50'
                        : 'border-slate-300 bg-slate-50/60 hover:border-slate-400 hover:bg-slate-50'
                    }`}
                  >
                    <FileSpreadsheet className="h-7 w-7 text-slate-400 mx-auto mb-2.5" />
                    <div className="text-sm font-semibold text-slate-900">
                      Drop your Excel (.xlsx, .xls) or CSV file here, or click to browse
                    </div>
                    <p className="text-xs text-slate-500 mt-1 max-w-lg mx-auto">
                      Phone numbers with country codes alone are all you need — no name or extra columns required. Works with or without a header row.
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx,.xls,.xlsm,.xlsb,.ods,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void handleSpreadsheetFile(file);
                        e.target.value = '';
                      }}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                    <span>
                      Numbers already containing a country code (e.g.{' '}
                      <span className="font-mono">919876543210</span>) are kept as-is; 10-digit numbers receive{' '}
                      <span className="font-mono">+{countryCode}</span>.
                    </span>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        type="button"
                        onClick={() => downloadSampleExcelFile()}
                        className="inline-flex items-center gap-1.5 font-medium text-emerald-700 hover:text-emerald-800 hover:underline whitespace-nowrap shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Sample Excel (.xlsx)
                      </button>
                      <span className="text-slate-300" aria-hidden="true">
                        ·
                      </span>
                      <button
                        type="button"
                        onClick={downloadSampleCsv}
                        className="inline-flex items-center gap-1.5 font-medium text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap shrink-0"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Sample CSV
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-5">
                  <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-200">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        {uploadedFileName}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 tabular-nums flex flex-wrap items-center gap-2">
                        <span>{parsedFile.totalRows.toLocaleString()} rows detected</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-emerald-700 font-medium">
                          {fileValidation?.validCount.toLocaleString()} valid numbers
                        </span>
                        {fileValidation && fileValidation.dupesInFile > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>
                              {fileValidation.dupesInFile.toLocaleString()} duplicates in file
                            </span>
                          </>
                        )}
                        {fileValidation && fileValidation.invalidCount > 0 && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="text-red-700 font-medium">
                              {fileValidation.invalidCount.toLocaleString()} invalid
                            </span>
                          </>
                        )}
                        {!parsedFile.hasHeaderRow && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Headerless list detected (row 1 included)</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setParsedFile(null);
                        setUploadedFileName('');
                      }}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900 hover:underline whitespace-nowrap shrink-0"
                    >
                      Choose different file
                    </button>
                  </div>

                  {/* Sheet & Optional Column Mapping (compact when phone-only single column) */}
                  <div className="flex flex-wrap items-end gap-4">
                    {parsedFile.fileType === 'excel' &&
                      parsedFile.sheetNames.length > 1 && (
                        <div className="min-w-[180px]">
                          <label
                            htmlFor="excel-sheet-select"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            Worksheet
                          </label>
                          <select
                            id="excel-sheet-select"
                            value={parsedFile.activeSheet}
                            onChange={(e) => handleSwitchWorksheet(e.target.value)}
                            className="w-full h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                          >
                            {parsedFile.sheetNames.map((name) => (
                              <option key={name} value={name}>
                                {name}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                    {!isPhoneOnlySheet && (
                      <>
                        <div className="min-w-[200px] flex-1">
                          <label
                            htmlFor="csv-phone-col"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            Phone Number Column
                          </label>
                          <select
                            id="csv-phone-col"
                            value={phoneColumn}
                            onChange={(e) => setPhoneColumn(e.target.value)}
                            className="w-full h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                          >
                            {parsedFile.headers.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div className="min-w-[200px] flex-1">
                          <label
                            htmlFor="csv-name-col"
                            className="block text-xs font-medium text-slate-700 mb-1"
                          >
                            Name Column (Optional)
                          </label>
                          <select
                            id="csv-name-col"
                            value={nameColumn}
                            onChange={(e) => setNameColumn(e.target.value)}
                            className="w-full h-9 rounded-md border border-slate-200 bg-white px-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                          >
                            <option value="">None (Phone numbers only)</option>
                            {parsedFile.headers.map((h) => (
                              <option key={h} value={h}>
                                {h}
                              </option>
                            ))}
                          </select>
                        </div>
                      </>
                    )}

                    <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none h-9">
                      <input
                        type="checkbox"
                        checked={replaceExisting}
                        onChange={(e) => setReplaceExisting(e.target.checked)}
                        className="h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-600"
                      />
                      <span>Replace existing numbers in campaign</span>
                    </label>
                  </div>

                  {/* Preview Table */}
                  {fileValidation && fileValidation.previewRows.length > 0 && (
                    <div className="overflow-x-auto border border-slate-200 rounded-md">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                            {nameColumn && (
                              <th className="py-2 px-3 font-medium">Name</th>
                            )}
                            <th className="py-2 px-3 font-medium">Number in File</th>
                            <th className="py-2 px-3 font-medium">wa.me Target</th>
                            <th className="py-2 px-3 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-200">
                          {fileValidation.previewRows.map((row, idx) => (
                            <tr key={idx} className="bg-white">
                              {nameColumn && (
                                <td className="py-2 px-3 text-slate-900 font-medium max-w-[180px] truncate">
                                  {row.name || '—'}
                                </td>
                              )}
                              <td className="py-2 px-3 font-mono text-slate-600 tabular-nums max-w-[240px] truncate">
                                {row.raw}
                              </td>
                              <td className="py-2 px-3 font-mono text-slate-900 tabular-nums whitespace-nowrap">
                                {row.valid ? `https://wa.me/${row.normalized}` : '—'}
                              </td>
                              <td className="py-2 px-3 whitespace-nowrap">
                                {row.valid ? (
                                  <span className="text-emerald-700 font-medium">
                                    Ready
                                  </span>
                                ) : (
                                  <span className="text-red-700 font-medium">
                                    {row.error || 'Invalid'}
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        setParsedFile(null);
                        setUploadedFileName('');
                      }}
                      className="px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={
                        importing || !fileValidation || fileValidation.validCount === 0
                      }
                      onClick={() => void commitSpreadsheetImport()}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                    >
                      <Upload className="h-3.5 w-3.5" />
                      {importing
                        ? 'Importing...'
                        : `Import ${fileValidation?.validCount.toLocaleString() || 0} Numbers`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Mode 2: Bulk Paste */}
          {importMode === 'paste' && (
            <div className="space-y-4">
              <div>
                <label
                  htmlFor="bulk-paste-input"
                  className="block text-xs font-medium text-slate-700 mb-1.5"
                >
                  Paste phone numbers (one per line or comma-separated — no names required)
                </label>
                <textarea
                  id="bulk-paste-input"
                  rows={6}
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={`919876543210\n+91 98201 11223\n919900112233\n919765432109`}
                  className="w-full rounded-md border border-slate-200 bg-white p-3 font-mono text-xs text-slate-900 placeholder:text-slate-400 focus:border-emerald-600 focus:outline-none focus:ring-2 focus:ring-emerald-600/15"
                />
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-slate-500">
                  Numbers with country code are used directly; 10-digit local numbers receive{' '}
                  <span className="font-mono">+{countryCode}</span>.
                </span>
                <button
                  type="button"
                  disabled={importing || !pasteText.trim()}
                  onClick={() => void commitBulkPaste()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {importing ? 'Adding...' : 'Add Numbers'}
                </button>
              </div>
            </div>
          )}

          {/* Mode 3: Single Contact */}
          {importMode === 'single' && (
            <form
              onSubmit={(e) => void commitSingleContact(e)}
              className="grid grid-cols-1 sm:grid-cols-3 gap-4 items-end"
            >
              <div>
                <label
                  htmlFor="single-phone"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Phone Number with Country Code
                </label>
                <input
                  id="single-phone"
                  type="text"
                  required
                  value={singlePhone}
                  onChange={(e) => setSinglePhone(e.target.value)}
                  placeholder="919876543210"
                  className="w-full h-9 rounded-md border border-slate-200 px-3 font-mono text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <div>
                <label
                  htmlFor="single-name"
                  className="block text-xs font-medium text-slate-700 mb-1"
                >
                  Name (Optional)
                </label>
                <input
                  id="single-name"
                  type="text"
                  value={singleName}
                  onChange={(e) => setSingleName(e.target.value)}
                  placeholder="Optional"
                  className="w-full h-9 rounded-md border border-slate-200 px-3 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <div>
                <button
                  type="submit"
                  disabled={importing}
                  className="w-full h-9 inline-flex items-center justify-center gap-1.5 px-4 text-xs font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-md transition-colors disabled:opacity-50 whitespace-nowrap"
                >
                  <UserPlus className="h-3.5 w-3.5" />
                  Add Number
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      {/* Contact Directory Table */}
      <section className="bg-white border border-slate-200 rounded-lg">
        <div className="px-6 py-4 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Recipient Numbers ({campaign.recipients.length.toLocaleString()})
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Every number generates a ready-to-send{' '}
              <span className="font-mono">https://wa.me/</span> link.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <div className="relative">
              <Search className="h-4 w-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search number or name..."
                className="h-9 w-56 rounded-md border border-slate-200 bg-slate-50 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:bg-white focus:border-emerald-600 focus:outline-none"
              />
            </div>

            {campaign.recipients.length > 0 &&
              (confirmClear ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void onClearAllRecipients();
                      setConfirmClear(false);
                    }}
                    className="px-3 py-1.5 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-md whitespace-nowrap shrink-0"
                  >
                    Confirm Clear All
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClear(false)}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-md whitespace-nowrap shrink-0"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClear(true)}
                  className="px-3 py-2 text-xs font-medium text-slate-600 hover:text-red-700 hover:bg-red-50 border border-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Clear List
                </button>
              ))}
          </div>
        </div>

        {filteredRecipients.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="text-sm font-medium text-slate-900">
              {campaign.recipients.length === 0
                ? 'No numbers in this campaign yet'
                : 'No numbers match your search'}
            </div>
            <p className="text-xs text-slate-500 mt-1">
              {campaign.recipients.length === 0
                ? 'Upload an Excel (.xlsx) or CSV file with phone numbers above to build your broadcast list.'
                : 'Try searching by partial digits or clearing the filter.'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2.5 px-6 font-medium">WhatsApp Number</th>
                    {hasAnyNamesOrFields && (
                      <th className="py-2.5 px-4 font-medium">Name / Details</th>
                    )}
                    <th className="py-2.5 px-4 font-medium">wa.me Target</th>
                    <th className="py-2.5 px-6 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {pageItems.map((r) => {
                    const fieldsSummary = [
                      r.name.trim(),
                      ...Object.entries(r.customFields || {})
                        .slice(0, 2)
                        .map(([k, v]) => `${k}: ${v}`),
                    ]
                      .filter(Boolean)
                      .join(' · ');

                    return (
                      <tr
                        key={r.id}
                        className="h-11 hover:bg-slate-50/80 transition-colors"
                      >
                        <td className="py-2 px-6 font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                          {formatDisplayPhone(r.phone)}
                        </td>
                        {hasAnyNamesOrFields && (
                          <td className="py-2 px-4 text-xs text-slate-600 max-w-xs truncate">
                            {fieldsSummary || '—'}
                          </td>
                        )}
                        <td className="py-2 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                          https://wa.me/{r.phone}
                        </td>
                        <td className="py-2 px-6 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-2">
                            <button
                              type="button"
                              disabled={r.status === 'sending'}
                              onClick={() => onLaunchSingle(r.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50 rounded transition-colors disabled:opacity-50 whitespace-nowrap"
                            >
                              <Send className="h-3.5 w-3.5" />
                              {r.status === 'sending' ? 'Sending...' : 'Send'}
                            </button>
                            <button
                              type="button"
                              onClick={() => void onDeleteRecipient(r.id)}
                              title="Remove number"
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Pagination Footer */}
            {totalPages > 1 && (
              <div className="px-6 py-3 border-t border-slate-200 flex items-center justify-between text-xs text-slate-600">
                <span className="tabular-nums">
                  Showing {(safePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safePage * PAGE_SIZE, filteredRecipients.length)} of{' '}
                  {filteredRecipients.length.toLocaleString()} numbers
                </span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    disabled={safePage <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="px-2.5 font-mono tabular-nums">
                    {safePage} / {totalPages}
                  </span>
                  <button
                    type="button"
                    disabled={safePage >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
