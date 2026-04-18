import { describe, it, expect } from 'vitest';
import { newId } from '../../lib/id';

describe('newId', () => {
  it('has the expected prefix', () => {
    expect(newId('account')).toMatch(/^acc_\d{8}_[0-9a-f]{10}$/);
    expect(newId('evidence')).toMatch(/^ev_\d{8}_[0-9a-f]{10}$/);
    expect(newId('touchRevision')).toMatch(/^tr_\d{8}_[0-9a-f]{10}$/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newId('evidence')));
    expect(ids.size).toBe(1000);
  });
});
