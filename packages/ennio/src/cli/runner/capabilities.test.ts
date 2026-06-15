import { describe, it, expect } from 'vitest';

import {
  isCrossProcessPresenter,
  isAsyncPayloadHost,
  chainHasAsyncPayloadHost,
  chainHasCrossProcessPresenter,
  isRichTextField,
  SUBMIT_DISMISS_TESTID_PATTERN,
} from './capabilities';

// Phase 4: the inline class-name allowlists became one overridable registry.
// These tests pin the default membership (byte-identical to the old inline
// lists) and the substring/chain matching semantics.

describe('capability registry', () => {
  it('recognizes Apple cross-process presenter classes (substring match)', () => {
    expect(isCrossProcessPresenter('PHPickerViewController')).toBe(true);
    expect(isCrossProcessPresenter('UIDocumentPickerViewController')).toBe(true);
    expect(isCrossProcessPresenter('UIActivityViewController')).toBe(true);
    expect(isCrossProcessPresenter('UINavigationController')).toBe(false);
  });

  it('recognizes async-payload / repainting hosts', () => {
    expect(isAsyncPayloadHost('TOCropViewController')).toBe(true);
    expect(isAsyncPayloadHost('Mantis.CropViewController')).toBe(true);
    expect(isAsyncPayloadHost('PHPickerViewController')).toBe(true);
    expect(isAsyncPayloadHost('RCTView')).toBe(false);
  });

  it('matches across a VC chain', () => {
    expect(chainHasAsyncPayloadHost(['UINavigationController', 'TOCropViewController'])).toBe(true);
    expect(chainHasAsyncPayloadHost(['UINavigationController', 'RCTView'])).toBe(false);
    expect(chainHasCrossProcessPresenter(['UIActivityViewController'])).toBe(true);
    expect(chainHasCrossProcessPresenter([])).toBe(false);
  });

  it('rich-text field membership is null-safe', () => {
    expect(isRichTextField('composerTextInput')).toBe(true);
    expect(isRichTextField('email-input')).toBe(false);
    expect(isRichTextField(null)).toBe(false);
    expect(isRichTextField(undefined)).toBe(false);
  });

  it('submit-dismiss pattern matches publish/submit/send case-insensitively', () => {
    expect(SUBMIT_DISMISS_TESTID_PATTERN.test('publishBtn')).toBe(true);
    expect(SUBMIT_DISMISS_TESTID_PATTERN.test('SubmitForm')).toBe(true);
    expect(SUBMIT_DISMISS_TESTID_PATTERN.test('sendMessage')).toBe(true);
    expect(SUBMIT_DISMISS_TESTID_PATTERN.test('cancel-btn')).toBe(false);
  });
});
