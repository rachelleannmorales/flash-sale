import { describe, expect, it } from 'vitest';
import { normalizeUserId } from '../../src/utils/userId.js';

describe('normalizeUserId', () => {
  it('accepts a plain username', () => {
    expect(normalizeUserId('Alice')).toBe('alice');
  });

  it('accepts an email', () => {
    expect(normalizeUserId('  BOB@example.com  ')).toBe('bob@example.com');
  });

  it('rejects empty string', () => {
    expect(normalizeUserId('')).toBeNull();
  });

  it('rejects non-string', () => {
    expect(normalizeUserId(42)).toBeNull();
    expect(normalizeUserId(null)).toBeNull();
    expect(normalizeUserId(undefined)).toBeNull();
  });

  it('rejects control characters', () => {
    expect(normalizeUserId('a\nb')).toBeNull();
  });

  it('rejects overly long ids', () => {
    expect(normalizeUserId('a'.repeat(129))).toBeNull();
  });
});
