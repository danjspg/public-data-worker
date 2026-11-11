import test from 'node:test';
import assert from 'node:assert/strict';
import {wexfordWeekEndingFromUrl} from '../src/council-weekly-wexford.mjs';

const base = 'https://www.wexfordcoco.ie/sites/default/files/content/Planning/PlanningLists/';
test('recover official Wexford dates from the existing percent-encoded URL form', () => {
  assert.equal(wexfordWeekEndingFromUrl(base+'Applications%20Decided%20w.e.%2004.01.2026.pdf'),'2026-01-04');
  assert.equal(wexfordWeekEndingFromUrl(base+'Applications%20Decided%20w.e.%2006.11.2026.pdf'),'2026-11-06');
  assert.equal(wexfordWeekEndingFromUrl(base+'Applications%20Decided%20w.e%2006.11.2026.pdf'),'2026-11-06');
});
test('fail closed for other domains, absent weeks, or invalid dates', () => {
  assert.equal(wexfordWeekEndingFromUrl('https://example.com/Applications%20Decided%20w.e.%2006.11.2026.pdf'),null);
  assert.equal(wexfordWeekEndingFromUrl(base+'ApplicationsDecided.pdf'),null);
  assert.equal(wexfordWeekEndingFromUrl(base+'Applications%20Decided%20w.e.%2031.02.2026.pdf'),null);
});
