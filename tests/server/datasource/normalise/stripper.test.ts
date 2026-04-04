import { describe, it, expect } from 'vitest';

import {
  stripSensitiveFields,
  stripSensitiveFromArray,
  auditSensitiveFieldPresence,
} from '../../../../src/server/datasource/normalise/stripper.js';

// =============================================================================
// stripSensitiveFields
// =============================================================================

describe('stripSensitiveFields()', () => {
  it('strips password from top-level object', () => {
    const input = { _id: 'att-1', name: 'Alice', password: 'hash-secret' };
    const result = stripSensitiveFields(input);
    expect(result).not.toHaveProperty('password');
    expect(result._id).toBe('att-1');
    expect(result.name).toBe('Alice');
  });

  it('strips email_default_signature from top-level object', () => {
    const input = { _id: 'att-1', email_default_signature: '<p>Regards</p>' };
    const result = stripSensitiveFields(input);
    expect(result).not.toHaveProperty('email_default_signature');
  });

  it('strips both fields when both present', () => {
    const input = { name: 'Alice', password: 'hash', email_default_signature: '<p>sig</p>' };
    const result = stripSensitiveFields(input);
    expect(result).not.toHaveProperty('password');
    expect(result).not.toHaveProperty('email_default_signature');
    expect(result.name).toBe('Alice');
  });

  it('is case-insensitive — strips PASSWORD', () => {
    const input = { name: 'Alice', PASSWORD: 'hash' };
    const result = stripSensitiveFields(input);
    expect(result).not.toHaveProperty('PASSWORD');
  });

  it('is case-insensitive — strips Email_Default_Signature', () => {
    const input = { name: 'Alice', Email_Default_Signature: '<p>sig</p>' };
    const result = stripSensitiveFields(input);
    expect(result).not.toHaveProperty('Email_Default_Signature');
  });

  it('recursively strips from nested objects', () => {
    const input = {
      _id: 'matter-1',
      responsible_lawyer: {
        _id: 'att-1', name: 'Bob',
        password: 'nested-hash',
        email_default_signature: '<p>Regards</p>',
      },
    };
    const result = stripSensitiveFields(input);
    expect(result.responsible_lawyer).not.toHaveProperty('password');
    expect(result.responsible_lawyer).not.toHaveProperty('email_default_signature');
    expect((result.responsible_lawyer as Record<string, unknown>)._id).toBe('att-1');
  });

  it('recursively strips from objects inside arrays', () => {
    const input = {
      clients: [
        { _id: 'c-1', name: 'Alice', password: 'hash-1' },
        { _id: 'c-2', name: 'Bob',   password: 'hash-2' },
      ],
    };
    const result = stripSensitiveFields(input);
    const clients = result.clients as Record<string, unknown>[];
    expect(clients[0]).not.toHaveProperty('password');
    expect(clients[1]).not.toHaveProperty('password');
    expect(clients[0]['_id']).toBe('c-1');
  });

  it('strips at multiple levels of nesting', () => {
    const input = {
      level1: {
        level2: {
          level3: { secret: 'keep', password: 'deep-hash' },
        },
      },
    };
    const result = stripSensitiveFields(input);
    const l3 = (result as Record<string, unknown>)['level1'] as Record<string, unknown>;
    const l2 = l3['level2'] as Record<string, unknown>;
    const l1 = l2['level3'] as Record<string, unknown>;
    expect(l1).not.toHaveProperty('password');
    expect(l1['secret']).toBe('keep');
  });

  it('does not mutate the input object', () => {
    const input = { name: 'Alice', password: 'hash' };
    stripSensitiveFields(input);
    expect(input).toHaveProperty('password'); // original unchanged
  });

  it('does not mutate nested objects', () => {
    const lawyer = { _id: 'att-1', password: 'hash' };
    const input = { responsible_lawyer: lawyer };
    stripSensitiveFields(input);
    expect(lawyer).toHaveProperty('password'); // nested original unchanged
  });

  it('preserves non-sensitive fields at all levels', () => {
    const input = {
      _id: 'matter-1',
      status: 'IN_PROGRESS',
      attorney: { _id: 'att-1', name: 'Bob', rate: 250, password: 'hash' },
    };
    const result = stripSensitiveFields(input);
    expect(result._id).toBe('matter-1');
    expect(result.status).toBe('IN_PROGRESS');
    const atty = result.attorney as Record<string, unknown>;
    expect(atty['name']).toBe('Bob');
    expect(atty['rate']).toBe(250);
  });

  it('handles object with no sensitive fields — returns equivalent object', () => {
    const input = { _id: 'x', name: 'Y', count: 3 };
    const result = stripSensitiveFields(input);
    expect(result).toEqual(input);
  });

  it('handles empty object', () => {
    const result = stripSensitiveFields({});
    expect(result).toEqual({});
  });

  it('leaves null and primitive values in arrays intact', () => {
    const input = { tags: ['admin', 'billing'], count: 5, active: true };
    const result = stripSensitiveFields(input);
    expect(result.tags).toEqual(['admin', 'billing']);
    expect(result.count).toBe(5);
    expect(result.active).toBe(true);
  });
});

// =============================================================================
// stripSensitiveFromArray
// =============================================================================

describe('stripSensitiveFromArray()', () => {
  it('strips sensitive fields from each record in the array', () => {
    const records = [
      { _id: '1', name: 'Alice', password: 'hash-1' },
      { _id: '2', name: 'Bob',   password: 'hash-2' },
    ];
    const result = stripSensitiveFromArray(records);
    expect(result[0]).not.toHaveProperty('password');
    expect(result[1]).not.toHaveProperty('password');
    expect(result[0]._id).toBe('1');
  });

  it('returns new array — does not mutate input array', () => {
    const records = [{ name: 'Alice', password: 'hash' }];
    const result = stripSensitiveFromArray(records);
    expect(result).not.toBe(records);
    expect(records[0]).toHaveProperty('password'); // original unchanged
  });

  it('handles empty array', () => {
    expect(stripSensitiveFromArray([])).toEqual([]);
  });
});

// =============================================================================
// auditSensitiveFieldPresence
// =============================================================================

describe('auditSensitiveFieldPresence()', () => {
  it('returns empty array when no sensitive fields present', () => {
    const records = [{ _id: '1', name: 'Alice' }, { _id: '2', status: 'ACTIVE' }];
    expect(auditSensitiveFieldPresence(records)).toEqual([]);
  });

  it('detects password field', () => {
    const records = [{ _id: '1', name: 'Alice', password: 'hash' }];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(1);
    expect(audit[0].fieldName).toBe('password');
    expect(audit[0].count).toBe(1);
  });

  it('detects email_default_signature field', () => {
    const records = [{ _id: '1', email_default_signature: '<p>sig</p>' }];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(1);
    expect(audit[0].fieldName).toBe('email_default_signature');
    expect(audit[0].count).toBe(1);
  });

  it('counts multiple occurrences across records', () => {
    const records = [
      { password: 'hash-1' },
      { password: 'hash-2' },
      { password: 'hash-3' },
    ];
    const audit = auditSensitiveFieldPresence(records);
    const passwordEntry = audit.find((a) => a.fieldName === 'password');
    expect(passwordEntry?.count).toBe(3);
  });

  it('detects both fields and reports both', () => {
    const records = [
      { password: 'hash', email_default_signature: '<p>sig</p>' },
    ];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(2);
    const fieldNames = audit.map((a) => a.fieldName).sort();
    expect(fieldNames).toEqual(['email_default_signature', 'password']);
  });

  it('detects sensitive fields in nested objects', () => {
    const records = [
      {
        _id: 'matter-1',
        attorney: { _id: 'att-1', password: 'nested-hash' },
      },
    ];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(1);
    expect(audit[0].fieldName).toBe('password');
  });

  it('counts nested occurrences across multiple records', () => {
    const records = [
      { attorney: { password: 'hash-1' } },
      { attorney: { password: 'hash-2' } },
    ];
    const audit = auditSensitiveFieldPresence(records);
    const entry = audit.find((a) => a.fieldName === 'password');
    expect(entry?.count).toBe(2);
  });

  it('does not count non-sensitive fields', () => {
    const records = [{ name: 'Alice', email: 'alice@firm.com', token: 'abc' }];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(0);
  });

  it('handles empty records array', () => {
    expect(auditSensitiveFieldPresence([])).toEqual([]);
  });

  it('is case-insensitive in detection', () => {
    const records = [{ PASSWORD: 'hash', Email_Default_Signature: '<p>sig</p>' }];
    const audit = auditSensitiveFieldPresence(records);
    expect(audit).toHaveLength(2);
  });
});
