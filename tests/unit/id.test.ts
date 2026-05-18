import { describe, it, expect } from 'vitest';
import { newId, isId } from '../../lib/id';

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

describe('isId', () => {
  it('round-trips every newId kind (drift between newId and isId fails loud)', () => {
    // ID_BODY is the single source for both newId and isId. If either
    // drifts without the other this fails HERE — not as a
    // silently-rejected real id (alert ack) or a silently-missed
    // citation (Phase 6 gate) in production. Looped because the hex
    // suffix is random (charset coverage).
    for (const kind of [
      'account', 'evidence', 'alert', 'touchRevision', 'engagementEvent',
    ] as const) {
      for (let i = 0; i < 20; i++) {
        expect(isId(kind, newId(kind))).toBe(true);
      }
    }
  });

  it('rejects anything that is not EXACTLY the id (no surrounding chars)', () => {
    // Pins the ^…$ contract that distinguishes isId from idRegExp's
    // \b…\b. If isId were ever "simplified" to reuse the find-regex,
    // an id with trailing junk would validate true — a real security
    // hole for the route-param/URL-tamper path acknowledgeAlert
    // guards. This makes that regression loud.
    const id = newId('alert');
    expect(isId('alert', id)).toBe(true);
    expect(isId('alert', ` ${id}`)).toBe(false);
    expect(isId('alert', `${id} `)).toBe(false);
    expect(isId('alert', `${id} trailing`)).toBe(false);
    expect(isId('alert', `prefix ${id}`)).toBe(false);
    expect(isId('alert', 'al_123')).toBe(false);
    expect(isId('alert', "al_'; DROP TABLE alerts; --")).toBe(false);
    // Right shape, wrong kind's prefix → still false.
    expect(isId('evidence', newId('alert'))).toBe(false);
  });
});
