/**
 * ExportButton — Button group for CSV and PDF export.
 */

import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ExportButtonProps {
  onExportCsv?: () => void | Promise<void>;
  onExportPdf?: () => void | Promise<void>;
}

export function ExportButton({ onExportCsv, onExportPdf }: ExportButtonProps) {
  const [csvLoading, setCsvLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);

  const handleCsv = async () => {
    if (!onExportCsv) return;
    setCsvLoading(true);
    try {
      await onExportCsv();
    } finally {
      setCsvLoading(false);
    }
  };

  const handlePdf = async () => {
    if (!onExportPdf) return;
    setPdfLoading(true);
    try {
      await onExportPdf();
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <div className="inline-flex rounded-md border border-border divide-x divide-border">
      {onExportCsv && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCsv}
          disabled={csvLoading}
          className="rounded-none first:rounded-l-md last:rounded-r-md"
        >
          {csvLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <span className="ml-1.5">CSV</span>
        </Button>
      )}
      {onExportPdf && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handlePdf}
          disabled={pdfLoading}
          className="rounded-none first:rounded-l-md last:rounded-r-md"
        >
          {pdfLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          <span className="ml-1.5">PDF</span>
        </Button>
      )}
    </div>
  );
}
