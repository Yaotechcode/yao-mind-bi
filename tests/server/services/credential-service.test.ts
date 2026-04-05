import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Supabase mock — hoisted before any imports that touch supabase
// =============================================================================

const { mockFromFn } = vi.hoisted(() => ({ mockFromFn: vi.fn() }));

vi.mock('../../../src/server/lib/supabase.js', () => ({
  db: { server: { from: mockFromFn } },
  getServerClient: () => ({ from: mockFromFn }),
}));

// =============================================================================
// Service import (after mock registration)
// =============================================================================

import {
  storeCredentials,
  getCredentials,
  deleteCredentials,
} from '../../../src/server/services/credential-service.js';

// =============================================================================
// Mock builder — chainable Supabase query
// =============================================================================

type MockResponse = { data?: unknown; error?: { message: string } | null };

function createMockBuilder(response: MockResponse = {}) {
  const { data = null, error = null } = response;
  const b: Record<string, unknown> = {};

  for (const m of ['select', 'eq', 'update', 'delete', 'upsert']) {
    b[m] = vi.fn().mockReturnValue(b);
  }

  b['single'] = vi.fn().mockResolvedValue({ data, error });
  b['insert'] = vi.fn().mockResolvedValue({ data: null, error });
  b['upsert'] = vi.fn().mockResolvedValue({ data: null, error });
  b['delete'] = vi.fn().mockReturnValue(b);

  // Make terminal awaits resolve
  (b as unknown as Promise<MockResponse>)[Symbol.iterator as unknown as string] = undefined;
  Object.defineProperty(b, 'then', {
    get() {
      return (resolve: (v: MockResponse) => void) => resolve({ data, error });
    },
  });

  return b;
}

// =============================================================================
// Env setup
// =============================================================================

const VALID_KEY = 'a'.repeat(64); // 32 bytes as hex

beforeEach(() => {
  process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'] = VALID_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'];
});

// =============================================================================
// Tests
// =============================================================================

describe('credential-service', () => {
  describe('encrypt → decrypt round-trip', () => {
    it('storeCredentials then getCredentials returns original values', async () => {
      // storeCredentials: upsert + audit insert
      const upsertBuilder = createMockBuilder({ data: null, error: null });
      const auditBuilder = createMockBuilder({ data: null, error: null });
      mockFromFn
        .mockReturnValueOnce(upsertBuilder)  // yao_api_credentials upsert
        .mockReturnValueOnce(auditBuilder);  // audit_log insert

      await storeCredentials('firm-1', 'test@example.com', 'secret123', 42);

      // Capture what was upserted
      const upsertCall = (upsertBuilder['upsert'] as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
      const stored = upsertCall[0];

      // getCredentials: select single
      const selectBuilder = createMockBuilder({
        data: {
          encrypted_email: stored['encrypted_email'],
          encrypted_password: stored['encrypted_password'],
          encrypted_code: stored['encrypted_code'],
        },
        error: null,
      });
      mockFromFn.mockReturnValueOnce(selectBuilder);

      const result = await getCredentials('firm-1');

      expect(result.email).toBe('test@example.com');
      expect(result.password).toBe('secret123');
      expect(result.code).toBe(42);
    });

    it('encrypts email, password, and code as distinct ciphertexts', async () => {
      const upsertBuilder = createMockBuilder({ data: null, error: null });
      const auditBuilder = createMockBuilder({ data: null, error: null });
      mockFromFn
        .mockReturnValueOnce(upsertBuilder)
        .mockReturnValueOnce(auditBuilder);

      await storeCredentials('firm-1', 'same@example.com', 'same@example.com', 99);

      const upsertCall = (upsertBuilder['upsert'] as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
      const stored = upsertCall[0];

      // Same plaintext encrypted with fresh IVs → different ciphertexts
      expect(stored['encrypted_email']).not.toBe(stored['encrypted_password']);
      expect(stored['encrypted_code']).toBeDefined();
    });

    it('getCredentials returns code: 0 when encrypted_code is null (legacy row)', async () => {
      const upsertBuilder = createMockBuilder({ data: null, error: null });
      const auditBuilder = createMockBuilder({ data: null, error: null });
      mockFromFn
        .mockReturnValueOnce(upsertBuilder)
        .mockReturnValueOnce(auditBuilder);

      await storeCredentials('firm-1', 'legacy@example.com', 'legacypass', 0);

      const upsertCall = (upsertBuilder['upsert'] as ReturnType<typeof vi.fn>).mock.calls[0] as [Record<string, unknown>];
      const stored = upsertCall[0];

      // Simulate a legacy row with no encrypted_code
      const selectBuilder = createMockBuilder({
        data: {
          encrypted_email: stored['encrypted_email'],
          encrypted_password: stored['encrypted_password'],
          encrypted_code: null,
        },
        error: null,
      });
      mockFromFn.mockReturnValueOnce(selectBuilder);

      const result = await getCredentials('firm-1');
      expect(result.code).toBe(0);
    });
  });

  describe('firm isolation', () => {
    it('getCredentials for wrong firm throws — does not return other firm data', async () => {
      // Store for firm-1
      const upsertBuilder = createMockBuilder({ data: null, error: null });
      const auditBuilder = createMockBuilder({ data: null, error: null });
      mockFromFn
        .mockReturnValueOnce(upsertBuilder)
        .mockReturnValueOnce(auditBuilder);

      await storeCredentials('firm-1', 'owner@firm1.com', 'pass1', 7);

      // Query for firm-2 returns no row
      const emptyBuilder = createMockBuilder({ data: null, error: { message: 'No rows found' } });
      mockFromFn.mockReturnValueOnce(emptyBuilder);

      await expect(getCredentials('firm-2')).rejects.toThrow(
        'No API credentials found for firm firm-2',
      );
    });
  });

  describe('missing encryption key', () => {
    it('storeCredentials throws a clear error when key is absent', async () => {
      delete process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'];

      await expect(
        storeCredentials('firm-1', 'user@example.com', 'pass', 1),
      ).rejects.toThrow('YAO_CREDENTIAL_ENCRYPTION_KEY is not set');
    });

    it('getCredentials throws a clear error when key is absent', async () => {
      // Return valid-looking encrypted data so the row lookup succeeds
      const selectBuilder = createMockBuilder({
        data: { encrypted_email: 'dummyblob', encrypted_password: 'dummyblob' },
        error: null,
      });
      mockFromFn.mockReturnValueOnce(selectBuilder);

      delete process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'];

      await expect(getCredentials('firm-1')).rejects.toThrow(
        'YAO_CREDENTIAL_ENCRYPTION_KEY is not set',
      );
    });

    it('throws when key is wrong length', async () => {
      process.env['YAO_CREDENTIAL_ENCRYPTION_KEY'] = 'tooshort';

      await expect(
        storeCredentials('firm-1', 'user@example.com', 'pass', 1),
      ).rejects.toThrow('must be a 64-character hex string');
    });
  });

  describe('getCredentials — no credentials stored', () => {
    it('throws when no credentials exist for firm', async () => {
      const builder = createMockBuilder({ data: null, error: { message: 'No rows found' } });
      mockFromFn.mockReturnValueOnce(builder);

      await expect(getCredentials('firm-unknown')).rejects.toThrow(
        'No API credentials found for firm firm-unknown',
      );
    });
  });

  describe('deleteCredentials', () => {
    it('calls delete and writes audit log', async () => {
      const deleteBuilder = createMockBuilder({ data: null, error: null });
      const auditBuilder = createMockBuilder({ data: null, error: null });
      mockFromFn
        .mockReturnValueOnce(deleteBuilder)
        .mockReturnValueOnce(auditBuilder);

      await deleteCredentials('firm-1', 'user-99');

      expect(mockFromFn).toHaveBeenCalledWith('yao_api_credentials');
      expect(mockFromFn).toHaveBeenCalledWith('audit_log');
    });
  });
});
