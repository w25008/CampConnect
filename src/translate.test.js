import test from 'node:test';
import assert from 'node:assert/strict';
import { TRANSLATE_LANGUAGES, currentTranslateLanguage } from './translate.js';

const withCookie = (cookie, run) => {
  globalThis.document = { cookie };
  try { run(); } finally { delete globalThis.document; }
};

test('the chosen language is read from Google’s cookie', () => {
  withCookie('campconnect=1; googtrans=/auto/vi; other=2', () => assert.equal(currentTranslateLanguage(), 'vi'));
  withCookie('googtrans=/en/zh-CN', () => assert.equal(currentTranslateLanguage(), 'zh-CN'));
});

test('no cookie means the page is shown untranslated', () => {
  withCookie('', () => assert.equal(currentTranslateLanguage(), ''));
  withCookie('googtrans=', () => assert.equal(currentTranslateLanguage(), ''));
});

test('each language is offered once', () => {
  const codes = TRANSLATE_LANGUAGES.map(([code]) => code);
  assert.equal(new Set(codes).size, codes.length);
});
