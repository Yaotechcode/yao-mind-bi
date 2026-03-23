export interface ParseResult {
  fileType: string
  originalFilename: string
  rowCount: number
  columns: ColumnInfo[]
  previewRows: Record<string, unknown>[]
  fullRows: Record<string, unknown>[]
  parseErrors: ParseError[]
  parsedAt: string
  detectedFileType?: string
  detectedEncoding?: string
}

export interface ColumnInfo {
  originalHeader: string
  detectedType: 'string' | 'number' | 'currency' | 'date' | 'boolean'
  sampleValues: string[]
  nullCount: number
  totalCount: number
  nullPercent: number
}

export interface ParseError {
  row?: number
  column?: string
  message: string
  severity: 'warning' | 'error'
  rawValue?: string
}

export interface ParserOptions {
  maxPreviewRows?: number
  encoding?: string
  dateFormats?: string[]
  currencySymbols?: string[]
  trimStrings?: boolean
  emptyStringAsNull?: boolean
}
