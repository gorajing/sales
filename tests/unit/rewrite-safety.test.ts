import { describe, it, expect } from 'vitest';
import { validateRewrite } from '../../lib/critics/rewrite-safety';

describe('validateRewrite', () => {
  it('passes a tight rewording that introduces no new facts', () => {
    const orig = 'I would propose a Standard Claims Study on Scalpinist-Senso, upgradeable to Multi-SKU as the Scalpinist line extends.';
    const rew = 'A Standard Claims Study on Scalpinist-Senso closes the sequencing gap.';
    expect(validateRewrite(orig, rew).ok).toBe(true);
  });

  it('rejects a rewrite that adds a sender title', () => {
    const orig = 'Jin Choi\nHelloBiome';
    const rew = 'Jin Choi, Head of Business Development, HelloBiome';
    const r = validateRewrite(orig, rew);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/title|Head of/i);
  });

  it('rejects a rewrite that changes a time', () => {
    const orig = 'Elisa has 15 minutes Tuesday 10:00 CET or Thursday 15:00 CET.';
    const rew = 'Elisa has 15 minutes Tuesday or Thursday, 9-11am CET.';
    const r = validateRewrite(orig, rew);
    expect(r.ok).toBe(false);
    // The validator catches the fabricated time range as either a new number or new time token
    expect(r.reason).toMatch(/number|time|9-11am|9/);
  });

  it('rejects a rewrite that invents a day', () => {
    const orig = 'Tuesday or Thursday works.';
    const rew = 'Monday or Wednesday works.';
    const r = validateRewrite(orig, rew);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/day|Monday/);
  });

  it('rejects a rewrite that uses an em dash', () => {
    const orig = 'I have 15 minutes.';
    const rew = 'I have 15 minutes — Tuesday works.';
    const r = validateRewrite(orig, rew);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/em dash|—/);
  });

  it('rejects a rewrite that introduces a new number', () => {
    const orig = 'A 30 to 45 subject human study closes that gap.';
    const rew = 'A 60 subject human study closes that gap.';
    const r = validateRewrite(orig, rew);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/number.*60|60.*number/);
  });

  it('passes when title is present in original', () => {
    const orig = 'Jane Doe, Head of R&D at Acme';
    const rew = 'Jane Doe (Head of R&D) at Acme';
    expect(validateRewrite(orig, rew).ok).toBe(true);
  });

  it('passes when all numbers in rewrite appeared in original', () => {
    const orig = 'A 30 to 45 subject human study with paired measurement.';
    const rew = 'A 30-45 subject study with paired measurement.';
    expect(validateRewrite(orig, rew).ok).toBe(true);
  });
});
