import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  transformAttorney,
  transformMatter,
  transformTimeEntry,
  transformInvoice,
  transformDisbursement,
  transformTask,
  transformContact,
} from '../../../../src/server/datasource/normalise/transformations.js';

import type { LookupMaps } from '../../../../src/server/datasource/normalise/types.js';
import type {
  YaoAttorney,
  YaoMatter,
  YaoTimeEntry,
  YaoInvoice,
  YaoLedger,
  YaoTask,
  YaoContact,
} from '../../../../src/server/datasource/types.js';

// =============================================================================
// Fixture builders
// =============================================================================

const MAPS: LookupMaps = {
  attorneyMap: {
    'att-1': {
      fullName: 'Alice Smith', firstName: 'Alice', lastName: 'Smith',
      email: 'alice@firm.com', status: 'ACTIVE', defaultRate: 250,
      allRates: [{ label: 'Standard', value: 250, default: true }],
      integrationAccountId: null, integrationAccountCode: null, jobTitle: null,
    },
  },
  departmentMap: { 'dept-1': 'Conveyancing' },
  caseTypeMap: {
    'ct-1': {
      title: 'Residential Purchase', departmentId: 'dept-1',
      departmentTitle: 'Conveyancing', isFixedFee: false, fixedFeeValue: null,
    },
    'ct-2': {
      title: 'Fixed Fee Conveyancing', departmentId: 'dept-1',
      departmentTitle: 'Conveyancing', isFixedFee: true, fixedFeeValue: 1500,
    },
  },
};

function makeAttorney(o: Partial<YaoAttorney> = {}): YaoAttorney {
  return {
    _id: 'att-1', name: 'Alice', surname: 'Smith', status: 'ACTIVE',
    email: 'alice@firm.com', law_firm: 'firm-1',
    rates: [{ label: 'Standard', value: 250, default: true }],
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    ...o,
  };
}

function makeMatter(o: Partial<YaoMatter> = {}): YaoMatter {
  return {
    _id: 'matter-1', number: 1001, status: 'IN_PROGRESS',
    case_name: 'Smith v Jones', financial_limit: 5000, rate: null,
    client_account_balance: 0, office_account_balance: 0, linked_account_balance: 0,
    clients: [{ contact: { _id: 'c-1', type: 'Person', display_name: 'Alice Smith' } }],
    case_contacts: [], created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    law_firm: { _id: 'firm-1', name: 'Acme Law' },
    ...o,
  };
}

function makeTimeEntry(o: Partial<YaoTimeEntry> = {}): YaoTimeEntry {
  return {
    _id: 'te-1', description: 'Drafting', do_not_bill: false, rate: 250,
    units: 6, duration_minutes: 30, billable: 125, write_off: 0,
    status: 'ACTIVE', date: '2024-03-01',
    matter: { _id: 'matter-1', number: 1001, case_name: 'Smith v Jones', law_firm: 'firm-1' },
    created_at: '2024-03-01T00:00:00Z', updated_at: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeInvoice(o: Partial<YaoInvoice> = {}): YaoInvoice {
  return {
    _id: 'inv-1', invoice_number: 101, invoice_date: '2024-03-01', due_date: '2024-04-01',
    subtotal: 1000, total_disbursements: 0, total_other_fees: 0, total_firm_fees: 1000,
    write_off: 0, total: 1200, outstanding: 1200, paid: 0,
    credited: 0, written_off: 0, vat: 200, vat_percentage: 20,
    less_paid_on_account: 0, billable_entries: 4, time_entries_override_value: 0,
    status: 'ISSUED', type: 'TAX',
    clients: [{ _id: 'c-1', display_name: 'Alice Smith' }],
    created_at: '2024-03-01T00:00:00Z', updated_at: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeLedger(o: Partial<YaoLedger> = {}): YaoLedger {
  return {
    _id: 'ledger-1', type: 'OFFICE_PAYMENT', value: -500,
    vat: 0, vat_percentage: 0, subtotal: 500,
    outstanding: -500, paid: 0, status: 'UNPAID',
    date: '2024-03-01', law_firm: 'firm-1',
    created_at: '2024-03-01T00:00:00Z', updated_at: '2024-03-01T00:00:00Z',
    ...o,
  };
}

function makeTask(o: Partial<YaoTask> = {}): YaoTask {
  return {
    _id: 'task-1', title: 'Review contract', priority: 'MEDIUM',
    status: 'TO_DO', notify_flag: false,
    created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    ...o,
  };
}

function makeContact(o: Partial<YaoContact> = {}): YaoContact {
  return {
    _id: 'contact-1', type: 'Person', display_name: 'Alice Smith',
    first_name: 'Alice', last_name: 'Smith', is_archived: false,
    law_firm: 'firm-1', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z',
    ...o,
  };
}

afterEach(() => vi.useRealTimers());

// =============================================================================
// transformAttorney
// =============================================================================

describe('transformAttorney()', () => {
  it('sets fullName from name + surname', () => {
    const result = transformAttorney(makeAttorney());
    expect(result.fullName).toBe('Alice Smith');
    expect(result.firstName).toBe('Alice');
    expect(result.lastName).toBe('Smith');
  });

  it('picks default rate', () => {
    const result = transformAttorney(makeAttorney({
      rates: [
        { label: 'Discounted', value: 200, default: false },
        { label: 'Standard', value: 250, default: true },
      ],
    }));
    expect(result.defaultRate).toBe(250);
  });

  it('returns null defaultRate when no default rate', () => {
    const result = transformAttorney(makeAttorney({
      rates: [{ label: 'Standard', value: 250, default: false }],
    }));
    expect(result.defaultRate).toBeNull();
  });

  it('returns null defaultRate when rates is empty', () => {
    const result = transformAttorney(makeAttorney({ rates: [] }));
    expect(result.defaultRate).toBeNull();
  });

  it('maps optional fields to null when absent', () => {
    const result = transformAttorney(makeAttorney({
      job_title: undefined, phone: undefined,
      integration_account_id: undefined, integration_account_code: undefined,
    }));
    expect(result.jobTitle).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.integrationAccountId).toBeNull();
    expect(result.integrationAccountCode).toBeNull();
  });

  it('does not include password or email_default_signature', () => {
    const raw = makeAttorney() as YaoAttorney & Record<string, unknown>;
    raw['password'] = 'hash';
    raw['email_default_signature'] = '<p>sig</p>';
    const result = transformAttorney(raw as YaoAttorney);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('email_default_signature');
  });
});

// =============================================================================
// transformMatter
// =============================================================================

describe('transformMatter()', () => {
  it('maps budget from financial_limit', () => {
    const result = transformMatter(makeMatter({ financial_limit: 12500 }), MAPS);
    expect(result.budget).toBe(12500);
  });

  it('isActive for IN_PROGRESS status', () => {
    expect(transformMatter(makeMatter({ status: 'IN_PROGRESS' }), MAPS).isActive).toBe(true);
  });

  it('isActive for ON_HOLD status', () => {
    expect(transformMatter(makeMatter({ status: 'ON_HOLD' }), MAPS).isActive).toBe(true);
  });

  it('isActive for EXCHANGED status', () => {
    expect(transformMatter(makeMatter({ status: 'EXCHANGED' }), MAPS).isActive).toBe(true);
  });

  it('isActive for QUOTE status', () => {
    expect(transformMatter(makeMatter({ status: 'QUOTE' }), MAPS).isActive).toBe(true);
  });

  it('isClosed for COMPLETED status', () => {
    expect(transformMatter(makeMatter({ status: 'COMPLETED' }), MAPS).isClosed).toBe(true);
  });

  it('isClosed for ARCHIVED status', () => {
    expect(transformMatter(makeMatter({ status: 'ARCHIVED' }), MAPS).isClosed).toBe(true);
  });

  it('isClosed for CLOSED status', () => {
    expect(transformMatter(makeMatter({ status: 'CLOSED' }), MAPS).isClosed).toBe(true);
  });

  it('isActive and isClosed are mutually exclusive', () => {
    const active = transformMatter(makeMatter({ status: 'IN_PROGRESS' }), MAPS);
    expect(active.isActive).toBe(true);
    expect(active.isClosed).toBe(false);

    const closed = transformMatter(makeMatter({ status: 'COMPLETED' }), MAPS);
    expect(closed.isActive).toBe(false);
    expect(closed.isClosed).toBe(true);
  });

  it('neither isActive nor isClosed for unknown status', () => {
    const result = transformMatter(makeMatter({ status: 'SOME_OTHER_STATUS' }), MAPS);
    expect(result.isActive).toBe(false);
    expect(result.isClosed).toBe(false);
  });

  it('isFixedFee from caseTypeMap', () => {
    const result = transformMatter(
      makeMatter({ case_type: { _id: 'ct-2', title: 'Fixed Fee Conveyancing' } }),
      MAPS,
    );
    expect(result.isFixedFee).toBe(true);
  });

  it('isFixedFee = false when case type not in map', () => {
    const result = transformMatter(
      makeMatter({ case_type: { _id: 'ct-unknown', title: 'Unknown' } }),
      MAPS,
    );
    expect(result.isFixedFee).toBe(false);
  });

  it('maps responsible lawyer fields', () => {
    const result = transformMatter(makeMatter({
      responsible_lawyer: {
        _id: 'att-1', name: 'Bob', surname: 'Brown',
        rates: [{ label: 'Standard', value: 300, default: true }],
      },
    }), MAPS);
    expect(result.responsibleLawyerId).toBe('att-1');
    expect(result.responsibleLawyerName).toBe('Bob Brown');
    expect(result.responsibleLawyerRate).toBe(300);
  });

  it('returns null responsible lawyer fields when absent', () => {
    const result = transformMatter(makeMatter({ responsible_lawyer: undefined }), MAPS);
    expect(result.responsibleLawyerId).toBeNull();
    expect(result.responsibleLawyerName).toBeNull();
    expect(result.responsibleLawyerRate).toBeNull();
  });

  it('maps supervisor and paralegal fields', () => {
    const result = transformMatter(makeMatter({
      responsible_supervisor: { _id: 's-1', name: 'Sue', surname: 'Hart', rates: [] },
      paralegal: { _id: 'p-1', name: 'Pat', surname: 'Lee', rates: [] },
    }), MAPS);
    expect(result.supervisorId).toBe('s-1');
    expect(result.supervisorName).toBe('Sue Hart');
    expect(result.paralegalId).toBe('p-1');
    expect(result.paralegalName).toBe('Pat Lee');
  });

  it('maps department from nested object', () => {
    const result = transformMatter(
      makeMatter({ department: { _id: 'dept-1', title: 'Conveyancing' } }),
      MAPS,
    );
    expect(result.departmentId).toBe('dept-1');
    expect(result.departmentName).toBe('Conveyancing');
  });

  it('falls back to departmentMap when nested title missing', () => {
    const result = transformMatter(
      makeMatter({ department: { _id: 'dept-1', title: '' } }),
      MAPS,
    );
    // empty string is falsy — falls back to map
    expect(result.departmentName).toBe('Conveyancing');
  });

  it('maps client lists', () => {
    const result = transformMatter(makeMatter({
      clients: [
        { contact: { _id: 'c-1', type: 'Person', display_name: 'Alice Smith' } },
        { contact: { _id: 'c-2', type: 'Person', display_name: 'Bob Jones' } },
      ],
    }), MAPS);
    expect(result.primaryClientId).toBe('c-1');
    expect(result.primaryClientName).toBe('Alice Smith');
    expect(result.clientIds).toEqual(['c-1', 'c-2']);
    expect(result.clientNames).toEqual(['Alice Smith', 'Bob Jones']);
  });

  it('returns empty client arrays when clients is empty', () => {
    const result = transformMatter(makeMatter({ clients: [] }), MAPS);
    expect(result.primaryClientId).toBeNull();
    expect(result.clientIds).toEqual([]);
  });

  it('extracts lawFirmId from object law_firm', () => {
    const result = transformMatter(
      makeMatter({ law_firm: { _id: 'firm-1', name: 'Acme Law' } }),
      MAPS,
    );
    expect(result.lawFirmId).toBe('firm-1');
  });

  it('uses string law_firm directly', () => {
    const result = transformMatter(makeMatter({ law_firm: 'firm-string-id' }), MAPS);
    expect(result.lawFirmId).toBe('firm-string-id');
  });
});

// =============================================================================
// transformTimeEntry
// =============================================================================

describe('transformTimeEntry()', () => {
  it('calculates durationHours correctly', () => {
    expect(transformTimeEntry(makeTimeEntry({ duration_minutes: 90 })).durationHours).toBe(1.5);
    expect(transformTimeEntry(makeTimeEntry({ duration_minutes: 60 })).durationHours).toBe(1);
    expect(transformTimeEntry(makeTimeEntry({ duration_minutes: 6 })).durationHours).toBeCloseTo(0.1);
  });

  it('prefers activity.title over work_type for activityType', () => {
    const result = transformTimeEntry(makeTimeEntry({
      activity: { _id: 'act-1', title: 'Drafting', measure: 'hours' },
      work_type: 'DRAFTING',
    }));
    expect(result.activityType).toBe('Drafting');
  });

  it('falls back to work_type when activity is absent', () => {
    const result = transformTimeEntry(makeTimeEntry({ activity: undefined, work_type: 'TELEPHONE' }));
    expect(result.activityType).toBe('TELEPHONE');
  });

  it('returns null activityType when both activity and work_type absent', () => {
    const result = transformTimeEntry(makeTimeEntry({ activity: undefined, work_type: undefined }));
    expect(result.activityType).toBeNull();
  });

  it('isChargeable = true when not do_not_bill and billable > 0', () => {
    expect(transformTimeEntry(makeTimeEntry({ do_not_bill: false, billable: 125 })).isChargeable).toBe(true);
  });

  it('isChargeable = false when do_not_bill', () => {
    expect(transformTimeEntry(makeTimeEntry({ do_not_bill: true, billable: 125 })).isChargeable).toBe(false);
  });

  it('isChargeable = false when billable = 0', () => {
    expect(transformTimeEntry(makeTimeEntry({ do_not_bill: false, billable: 0 })).isChargeable).toBe(false);
  });

  it('recordedValue = billable + write_off', () => {
    const result = transformTimeEntry(makeTimeEntry({ billable: 100, write_off: 50 }));
    expect(result.recordedValue).toBe(150);
  });

  it('maps lawyerId and lawyerName from assignee', () => {
    const result = transformTimeEntry(makeTimeEntry({
      assignee: { _id: 'att-1', name: 'Bob', surname: 'Brown' },
    }));
    expect(result.lawyerId).toBe('att-1');
    expect(result.lawyerName).toBe('Bob Brown');
  });

  it('returns null lawyerId and lawyerName when assignee absent', () => {
    const result = transformTimeEntry(makeTimeEntry({ assignee: undefined }));
    expect(result.lawyerId).toBeNull();
    expect(result.lawyerName).toBeNull();
  });

  it('maps matterId and matterNumber from nested matter', () => {
    const result = transformTimeEntry(makeTimeEntry());
    expect(result.matterId).toBe('matter-1');
    expect(result.matterNumber).toBe(1001);
  });
});

// =============================================================================
// transformInvoice
// =============================================================================

describe('transformInvoice()', () => {
  it('datePaid is null at transform time', () => {
    expect(transformInvoice(makeInvoice()).datePaid).toBeNull();
  });

  it('maps solicitor to responsibleLawyerId/Name', () => {
    const result = transformInvoice(makeInvoice({ solicitor: { _id: 'att-1', name: 'Alice Smith' } }));
    expect(result.responsibleLawyerId).toBe('att-1');
    expect(result.responsibleLawyerName).toBe('Alice Smith');
  });

  it('returns null responsible lawyer when solicitor absent', () => {
    const result = transformInvoice(makeInvoice({ solicitor: undefined }));
    expect(result.responsibleLawyerId).toBeNull();
    expect(result.responsibleLawyerName).toBeNull();
  });

  it('maps matter fields', () => {
    const result = transformInvoice(makeInvoice({
      matter: { _id: 'matter-1', number: 1001, case_name: 'Smith v Jones' },
    }));
    expect(result.matterId).toBe('matter-1');
    expect(result.matterNumber).toBe(1001);
  });

  it('returns null matter fields when matter absent', () => {
    const result = transformInvoice(makeInvoice({ matter: undefined }));
    expect(result.matterId).toBeNull();
    expect(result.matterNumber).toBeNull();
  });

  it('maps client lists', () => {
    const result = transformInvoice(makeInvoice({
      clients: [
        { _id: 'c-1', display_name: 'Alice Smith' },
        { _id: 'c-2', display_name: 'Bob Jones' },
      ],
    }));
    expect(result.primaryClientId).toBe('c-1');
    expect(result.clientIds).toEqual(['c-1', 'c-2']);
    expect(result.clientNames).toEqual(['Alice Smith', 'Bob Jones']);
  });

  it('returns empty arrays when clients is empty', () => {
    const result = transformInvoice(makeInvoice({ clients: [] }));
    expect(result.primaryClientId).toBeNull();
    expect(result.clientIds).toEqual([]);
  });
});

// =============================================================================
// transformDisbursement
// =============================================================================

describe('transformDisbursement()', () => {
  it('subtotal = abs(value)', () => {
    expect(transformDisbursement(makeLedger({ value: -500 })).subtotal).toBe(500);
    expect(transformDisbursement(makeLedger({ value: 500 })).subtotal).toBe(500);
  });

  it('vatAmount = abs(vat)', () => {
    expect(transformDisbursement(makeLedger({ vat: -100 })).vatAmount).toBe(100);
    expect(transformDisbursement(makeLedger({ vat: 100 })).vatAmount).toBe(100);
  });

  it('firmExposure = abs(outstanding) when outstanding < 0', () => {
    expect(transformDisbursement(makeLedger({ outstanding: -300 })).firmExposure).toBe(300);
  });

  it('firmExposure = 0 when outstanding = 0', () => {
    expect(transformDisbursement(makeLedger({ outstanding: 0 })).firmExposure).toBe(0);
  });

  it('firmExposure = 0 when outstanding > 0', () => {
    expect(transformDisbursement(makeLedger({ outstanding: 100 })).firmExposure).toBe(0);
  });

  it('isRecovered = true when outstanding = 0', () => {
    expect(transformDisbursement(makeLedger({ outstanding: 0 })).isRecovered).toBe(true);
  });

  it('isRecovered = false when outstanding !== 0', () => {
    expect(transformDisbursement(makeLedger({ outstanding: -300 })).isRecovered).toBe(false);
  });

  it('maps description from reference', () => {
    expect(transformDisbursement(makeLedger({ reference: 'Court fee' })).description).toBe('Court fee');
  });

  it('returns null description when reference absent', () => {
    expect(transformDisbursement(makeLedger({ reference: undefined })).description).toBeNull();
  });

  it('maps supplierId from payee', () => {
    expect(transformDisbursement(makeLedger({ payee: 'HMRC' })).supplierId).toBe('HMRC');
  });

  it('maps matter fields', () => {
    const result = transformDisbursement(makeLedger({
      matter: { _id: 'matter-1', number: 1001, case_name: 'Test' },
    }));
    expect(result.matterId).toBe('matter-1');
    expect(result.matterNumber).toBe(1001);
  });

  it('returns null matter fields when matter absent', () => {
    const result = transformDisbursement(makeLedger({ matter: undefined }));
    expect(result.matterId).toBeNull();
    expect(result.matterNumber).toBeNull();
  });
});

// =============================================================================
// transformTask
// =============================================================================

describe('transformTask()', () => {
  it('isOverdue = true when TO_DO and past due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01'));
    const result = transformTask(makeTask({ status: 'TO_DO', due_date: '2024-05-01' }));
    expect(result.isOverdue).toBe(true);
  });

  it('isOverdue = false when COMPLETED regardless of past due date', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-01'));
    const result = transformTask(makeTask({ status: 'COMPLETED', due_date: '2024-05-01' }));
    expect(result.isOverdue).toBe(false);
  });

  it('isOverdue = false when due date is in the future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-04-01'));
    const result = transformTask(makeTask({ status: 'TO_DO', due_date: '2024-05-01' }));
    expect(result.isOverdue).toBe(false);
  });

  it('isOverdue = false when due_date is null', () => {
    const result = transformTask(makeTask({ status: 'TO_DO', due_date: null }));
    expect(result.isOverdue).toBe(false);
  });

  it('isOverdue = false when due_date is undefined', () => {
    const result = transformTask(makeTask({ status: 'TO_DO', due_date: undefined }));
    expect(result.isOverdue).toBe(false);
  });

  it('maps lawyerId and lawyerName from assigned_to', () => {
    const result = transformTask(makeTask({
      assigned_to: { _id: 'att-1', name: 'Bob', surname: 'Brown', status: 'ACTIVE', email: 'b@firm.com' },
    }));
    expect(result.lawyerId).toBe('att-1');
    expect(result.lawyerName).toBe('Bob Brown');
  });

  it('returns null lawyer fields when assigned_to absent', () => {
    const result = transformTask(makeTask({ assigned_to: undefined }));
    expect(result.lawyerId).toBeNull();
    expect(result.lawyerName).toBeNull();
  });

  it('maps matter fields', () => {
    const result = transformTask(makeTask({
      matter: { _id: 'matter-1', number: 1001, case_name: 'Test' },
    }));
    expect(result.matterId).toBe('matter-1');
    expect(result.matterNumber).toBe(1001);
  });

  it('returns null matter fields when matter absent', () => {
    const result = transformTask(makeTask({ matter: undefined }));
    expect(result.matterId).toBeNull();
    expect(result.matterNumber).toBeNull();
  });

  it('maps optional task fields to null when absent', () => {
    const result = transformTask(makeTask({
      category: undefined, description: undefined, estimate_time: undefined,
    }));
    expect(result.category).toBeNull();
    expect(result.description).toBeNull();
    expect(result.estimateTime).toBeNull();
  });
});

// =============================================================================
// transformContact
// =============================================================================

describe('transformContact()', () => {
  it('isCompany = true for Company type', () => {
    const result = transformContact(makeContact({ type: 'Company', company_name: 'Acme Ltd' }));
    expect(result.isCompany).toBe(true);
  });

  it('isCompany = false for Person type', () => {
    expect(transformContact(makeContact({ type: 'Person' })).isCompany).toBe(false);
  });

  it('prefers mobile_phone over work_phone for primaryPhone', () => {
    const result = transformContact(makeContact({ mobile_phone: '07700900000', work_phone: '02071234567' }));
    expect(result.primaryPhone).toBe('07700900000');
  });

  it('falls back to work_phone when mobile_phone absent', () => {
    const result = transformContact(makeContact({ mobile_phone: undefined, work_phone: '02071234567' }));
    expect(result.primaryPhone).toBe('02071234567');
  });

  it('returns null primaryPhone when both absent', () => {
    const result = transformContact(makeContact({ mobile_phone: undefined, work_phone: undefined }));
    expect(result.primaryPhone).toBeNull();
  });

  it('returns null primaryEmail when email absent', () => {
    const result = transformContact(makeContact({ email: undefined }));
    expect(result.primaryEmail).toBeNull();
  });

  it('maps tags to empty array when absent', () => {
    const result = transformContact(makeContact({ tags: undefined }));
    expect(result.tags).toEqual([]);
  });

  it('maps all name fields to null when absent', () => {
    const result = transformContact(makeContact({
      first_name: undefined, middle_name: undefined, last_name: undefined, company_name: undefined,
    }));
    expect(result.firstName).toBeNull();
    expect(result.middleName).toBeNull();
    expect(result.lastName).toBeNull();
    expect(result.companyName).toBeNull();
  });

  it('maps contactId from _id', () => {
    expect(transformContact(makeContact({ _id: 'contact-99' })).contactId).toBe('contact-99');
  });

  it('maps displayName from display_name', () => {
    expect(transformContact(makeContact({ display_name: 'Bob Jones' })).displayName).toBe('Bob Jones');
  });
});
