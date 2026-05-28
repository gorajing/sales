import { describe, it, expect } from 'vitest';
import { isSafeHttpUrl, parseOperatorLinks } from '@/lib/gtm-handoff/trace';

describe('isSafeHttpUrl', () => {
  it('accepts http and https, returning the normalized URL', () => {
    expect(isSafeHttpUrl('http://localhost:8787')).toBe('http://localhost:8787/');
    expect(isSafeHttpUrl('https://example.com/events')).toBe('https://example.com/events');
  });

  it('rejects non-http(s) schemes (the render sink is an XSS boundary)', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(isSafeHttpUrl('data:text/html,<script>')).toBeNull();
    expect(isSafeHttpUrl('ftp://example.com')).toBeNull();
  });

  it('rejects malformed and non-string values', () => {
    expect(isSafeHttpUrl('/relative/path')).toBeNull();
    expect(isSafeHttpUrl('')).toBeNull();
    expect(isSafeHttpUrl(123)).toBeNull();
    expect(isSafeHttpUrl(null)).toBeNull();
    expect(isSafeHttpUrl(undefined)).toBeNull();
    expect(isSafeHttpUrl({})).toBeNull();
  });
});

describe('parseOperatorLinks', () => {
  it('returns both safe links from a valid payload', () => {
    const json = JSON.stringify({
      operatorLinks: {
        consoleUrl: 'http://localhost:8787',
        eventsUrl: 'http://localhost:8787/events',
      },
    });
    expect(parseOperatorLinks(json)).toEqual({
      consoleUrl: 'http://localhost:8787/',
      eventsUrl: 'http://localhost:8787/events',
    });
  });

  it('degrades an unsafe stored link to null (defense-in-depth at the sink)', () => {
    const json = JSON.stringify({
      operatorLinks: { consoleUrl: 'javascript:alert(1)', eventsUrl: 'https://ok.example/e' },
    });
    expect(parseOperatorLinks(json)).toEqual({
      consoleUrl: null,
      eventsUrl: 'https://ok.example/e',
    });
  });

  it('returns nulls when operatorLinks is absent', () => {
    expect(parseOperatorLinks(JSON.stringify({ trace: {} }))).toEqual({
      consoleUrl: null,
      eventsUrl: null,
    });
  });

  it('returns nulls for malformed or non-object JSON', () => {
    expect(parseOperatorLinks('{not json')).toEqual({ consoleUrl: null, eventsUrl: null });
    expect(parseOperatorLinks('null')).toEqual({ consoleUrl: null, eventsUrl: null });
    expect(parseOperatorLinks('123')).toEqual({ consoleUrl: null, eventsUrl: null });
    expect(parseOperatorLinks('[]')).toEqual({ consoleUrl: null, eventsUrl: null });
  });
});
