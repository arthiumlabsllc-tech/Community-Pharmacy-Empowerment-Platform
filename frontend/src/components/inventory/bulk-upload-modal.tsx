'use client';

import { useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { Modal } from '@/components/ui/modal';
import { api } from '@/lib/api';
import { Download, FileSpreadsheet, AlertCircle } from 'lucide-react';

const COLUMNS = [
  'product_name',
  'product_code',
  'generic_name',
  'category',
  'quantity',
  'unit_price',
  'cost_price',
  'expiry_date',
  'reorder_level',
  'requires_prescription',
] as const;

const TEMPLATE_ROWS = [
  ['Paracetamol 500mg (100 tabs)', 'PCM-500-100', 'Acetaminophen', 'Analgesics', '200', '12.50', '8.00', '2027-06-30', '50', 'false'],
  ['Amoxicillin 250mg Caps', 'AMX-250-B12', 'Amoxicillin', 'Antibiotics', '80', '1.20', '0.70', '2026-11-30', '30', 'true'],
];

interface ParsedRow {
  lineNumber: number;
  values: Record<string, string>;
  errors: string[];
}

/**
 * Minimal RFC-4180-ish CSV parser: supports quoted fields, escaped quotes
 * (""), commas inside quotes and CRLF line endings.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function validateRow(values: Record<string, string>): string[] {
  const errors: string[] = [];

  if (!values.product_name?.trim()) errors.push('product_name is required');
  if (!values.product_code?.trim()) errors.push('product_code is required');

  if (values.quantity && !/^\d+$/.test(values.quantity.trim())) errors.push('quantity must be a whole number');
  if (values.reorder_level && !/^\d+$/.test(values.reorder_level.trim())) errors.push('reorder_level must be a whole number');

  for (const priceField of ['unit_price', 'cost_price'] as const) {
    const raw = values[priceField]?.trim();
    if (raw && Number.isNaN(Number(raw))) errors.push(`${priceField} must be a number`);
  }

  if (!values.expiry_date?.trim()) {
    errors.push('expiry_date is required');
  } else if (Number.isNaN(new Date(values.expiry_date.trim()).getTime())) {
    errors.push('expiry_date must be a valid date (YYYY-MM-DD)');
  }

  return errors;
}

interface BulkUploadModalProps {
  open: boolean;
  onClose: () => void;
  onUploaded: () => void;
}

export function BulkUploadModal({ open, onClose, onUploaded }: BulkUploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [headerError, setHeaderError] = useState('');
  const [fileName, setFileName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const validRows = rows.filter((r) => r.errors.length === 0);
  const invalidRows = rows.filter((r) => r.errors.length > 0);

  const reset = () => {
    setRows([]);
    setHeaderError('');
    setFileName('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const downloadTemplate = () => {
    const csv = [COLUMNS.join(','), ...TEMPLATE_ROWS.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'inventory-import-template.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleText = (text: string, sourceName: string) => {
    setHeaderError('');
    setFileName(sourceName);

    const table = parseCsv(text);
    if (table.length < 2) {
      setRows([]);
      setHeaderError('The file needs a header row plus at least one data row.');
      return;
    }

    const header = table[0].map((cell) => cell.trim().toLowerCase());
    const missing = (['product_name', 'product_code', 'expiry_date'] as const).filter(
      (required) => !header.includes(required)
    );
    if (missing.length > 0) {
      setRows([]);
      setHeaderError(`Missing required column(s): ${missing.join(', ')}. Download the template to see the expected format.`);
      return;
    }

    const parsed: ParsedRow[] = table.slice(1).map((cells, index) => {
      const values: Record<string, string> = {};
      header.forEach((name, colIndex) => {
        values[name] = (cells[colIndex] ?? '').trim();
      });
      return { lineNumber: index + 2, values, errors: validateRow(values) };
    });

    setRows(parsed);
    if (parsed.length === 0) setHeaderError('No data rows were found in the file.');
  };

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      setHeaderError('Please choose a .csv file.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setHeaderError('File is larger than 2 MB. Split it into smaller batches.');
      return;
    }
    handleText(await file.text(), file.name);
  };

  const handleSubmit = async () => {
    if (validRows.length === 0) return;
    if (validRows.length > 500) {
      toast.error('Maximum 500 items per upload — split the file and try again');
      return;
    }

    setSubmitting(true);
    try {
      const items = validRows.map(({ values }) => ({
        product_name: values.product_name,
        product_code: values.product_code,
        generic_name: values.generic_name || null,
        category: values.category || null,
        quantity: values.quantity ? parseInt(values.quantity, 10) : 0,
        unit_price: values.unit_price ? parseFloat(values.unit_price) : 0,
        cost_price: values.cost_price ? parseFloat(values.cost_price) : 0,
        expiry_date: values.expiry_date,
        reorder_level: values.reorder_level ? parseInt(values.reorder_level, 10) : 10,
        requires_prescription: values.requires_prescription?.toLowerCase() === 'true',
      }));

      const response = await api.post('/inventory/bulk-upload', { items });
      const inserted = response.data?.inserted ?? items.length;
      const serverErrors: string[] = response.data?.errors || [];

      if (serverErrors.length > 0) {
        toast(`${inserted} imported, ${serverErrors.length} rejected by the server`, { icon: '⚠️' });
      } else {
        toast.success(`${inserted} item${inserted === 1 ? '' : 's'} imported`);
      }

      reset();
      onUploaded();
    } catch (error: any) {
      toast.error(error?.message || 'Bulk upload failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Bulk upload inventory"
      description="Import up to 500 products from a CSV file"
      size="lg"
      footer={
        <>
          <button className="btn-secondary btn-sm" onClick={handleClose} disabled={submitting}>Cancel</button>
          <button
            className="btn-primary btn-sm"
            onClick={handleSubmit}
            disabled={submitting || validRows.length === 0}
          >
            {submitting && <div className="spinner" />}
            Import {validRows.length > 0 ? `${validRows.length} item${validRows.length === 1 ? '' : 's'}` : 'items'}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <button type="button" className="btn-secondary btn-sm" onClick={downloadTemplate}>
            <Download className="w-4 h-4" />
            Download CSV template
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={() => fileInputRef.current?.click()}>
            <FileSpreadsheet className="w-4 h-4" />
            {fileName ? 'Choose a different file' : 'Choose CSV file'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
            }}
          />
        </div>

        {headerError && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{headerError}</span>
          </div>
        )}

        {rows.length === 0 && !headerError && (
          <div className="text-sm text-gray-500 bg-gray-50 rounded-xl p-4 space-y-2">
            <p className="font-medium text-gray-700">Expected columns</p>
            <p className="font-mono text-xs break-all">{COLUMNS.join(', ')}</p>
            <p className="text-xs">
              <span className="font-medium">product_name</span>,{' '}
              <span className="font-medium">product_code</span> and{' '}
              <span className="font-medium">expiry_date</span> are required. Dates must be YYYY-MM-DD.
              Use <span className="font-mono">true</span>/<span className="font-mono">false</span> for
              requires_prescription. Product codes must be unique — import each batch with its own code.
            </p>
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="badge-success">{validRows.length} ready to import</span>
              {invalidRows.length > 0 && <span className="badge-danger">{invalidRows.length} with errors</span>}
              <span className="badge-neutral">{fileName}</span>
            </div>

            <div className="table-container max-h-72 overflow-y-auto">
              <table className="table">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    <th>Row</th>
                    <th>Product</th>
                    <th>Code</th>
                    <th>Qty</th>
                    <th>Price</th>
                    <th>Expiry</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.lineNumber} className={row.errors.length > 0 ? 'bg-red-50/60' : ''}>
                      <td className="text-gray-400">{row.lineNumber}</td>
                      <td className="font-medium text-gray-900">{row.values.product_name || '—'}</td>
                      <td className="text-xs text-gray-500">{row.values.product_code || '—'}</td>
                      <td>{row.values.quantity || '0'}</td>
                      <td>{row.values.unit_price ? `GHS ${Number(row.values.unit_price).toFixed(2)}` : '—'}</td>
                      <td className="text-xs">{row.values.expiry_date || '—'}</td>
                      <td>
                        {row.errors.length === 0 ? (
                          <span className="badge-success">Valid</span>
                        ) : (
                          <span className="badge-danger" title={row.errors.join('; ')}>
                            {row.errors[0]}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {invalidRows.length > 0 && (
              <p className="text-xs text-gray-500">
                Rows with errors will be skipped. Fix them in your spreadsheet and re-upload to import the rest.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
