import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handler } from '../../../src/server/functions/yao-connect';

describe('yao-connect', () => {
  // POST /api/yao-connect tests
  describe('POST /api/yao-connect', () => {
    it('returns 403 for non-owner/non-admin roles', async () => {
      // Test implementation
    });

    it('returns 400 for invalid email', async () => {
      // Test implementation
    });

    it('returns 400 for empty password', async () => {
      // Test implementation
    });

    it('returns 400 when Yao login fails', async () => {
      // Test implementation
    });

    it('returns 200 with connected: true and attorneyName on success', async () => {
      // Test implementation
    });

    it('extracts attorney name from multiple response formats', async () => {
      // Test implementation
    });

    it('calls storeCredentials after successful login', async () => {
      // Test implementation
    });

    it('seeds pull_status idle row if absent', async () => {
      // Test implementation
    });
  });

  // GET /api/yao-connect/status tests
  describe('GET /api/yao-connect/status', () => {
    it('returns 401 if not authenticated', async () => {
      // Test implementation
    });

    it('returns connected: false if no credential row', async () => {
      // Test implementation
    });

    it('returns connected: true with timestamps if credential exists', async () => {
      // Test implementation
    });

    it('reads credentials and pull_status in parallel', async () => {
      // Test implementation
    });
  });
});
