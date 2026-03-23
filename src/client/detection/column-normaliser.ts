/**
 * Normalises a raw column header to a canonical lowercase form for use in
 * column mapping (1B-03) and other downstream consumers.
 *
 * Steps:
 *  1. Lowercase
 *  2. Strip separators (spaces, underscores, hyphens, dots)
 *  3. Strip common word prefixes if the result would still be meaningful (>2 chars)
 *
 * Note: the file-type detector uses a simpler variant (lowercase + strip only)
 * to avoid false-positive prefix stripping during signature matching.
 */
export function normaliseColumnName(name: string): string {
  // 1. Lowercase
  let norm = name.toLowerCase();

  // 2. Strip separators
  norm = norm.replace(/[\s_\-\.]+/g, '');

  // 3. Strip leading word prefixes (only when meaningful chars remain)
  const prefixes = ['responsible', 'total', 'is', 'has'];
  for (const prefix of prefixes) {
    if (norm.startsWith(prefix) && norm.length > prefix.length + 2) {
      norm = norm.slice(prefix.length);
      break; // strip at most one prefix
    }
  }

  return norm;
}

/**
 * Maps normalised alternative column names to their canonical Yao Mind names.
 * Applied in the file-type detector after simple normalisation so that columns
 * with non-standard names still contribute to detection scores.
 *
 * Keys: the normalised form of the alternative name (lowercase, no separators).
 * Values: the canonical column name used in FILE_TYPE_SIGNATURES.
 */
export const COLUMN_NAME_ALIASES: Record<string, string> = {
  // Fee earner / lawyer references
  lawyername: 'lawyerid',
  feeearnername: 'lawyerid',
  feeearner: 'lawyerid',
  feeearnerid: 'lawyerid',
  solicitor: 'lawyerid',
  solicitorname: 'lawyerid',

  // Matter references
  matter: 'matterid',
  matterref: 'matternumber',
  reference: 'matternumber',
  ref: 'matternumber',
  casenumber: 'matternumber',
  caseref: 'matternumber',

  // Date fields
  dateofentry: 'date',
  entrydate: 'date',
  transactiondate: 'date',
  postingdate: 'date',

  // Financial / billing fields
  amountbillable: 'billablevalue',
  billable: 'billablevalue',
  billableamount: 'billablevalue',
  writeoff: 'writeoffvalue',
  amountwrittenoff: 'writeoffvalue',
  invoiceamount: 'subtotal',
  invoicetotal: 'subtotal',
  netbill: 'netbilling',
  fees: 'subtotal',

  // Invoice fields
  invoiceno: 'invoicenumber',
  invnumber: 'invoicenumber',
  invoicenum: 'invoicenumber',

  // Contact / client display name
  clientname: 'displayname',
  contactname: 'displayname',
  fullname: 'displayname',
};
