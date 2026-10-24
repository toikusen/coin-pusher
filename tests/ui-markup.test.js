import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectUI, GameUI } from '../src/ui.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tags = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)];
const elements = new Map(tags.map(([, tag, attributes, id]) => [id, { tag, attributes }]));

afterEach(() => vi.unstubAllGlobals());

describe('UI markup contract', () => {
  it('keeps every controller target present with a unique id', () => {
    expect(elements.size).toBe(tags.length);
    vi.stubGlobal('document', { getElementById: (id) => elements.get(id) ?? null });
    for (const [id, element] of Object.entries(collectUI())) {
      expect(element, id).not.toBeNull();
    }
  });

  it('keeps native buttons, dialog semantics, and live announcements', () => {
    for (const id of ['dropButton', 'soundButton', 'autoButton', 'helpButton', 'resetButton', 'startButton', 'retryButton', 'tuneToggle', 'tuneClose']) {
      expect(elements.get(id).tag, id).toBe('button');
      expect(elements.get(id).attributes, id).toContain('type="button"');
    }
    expect(elements.get('onboarding').tag).toBe('dialog');
    expect(elements.get('onboarding').attributes).toContain('aria-labelledby="onboardingTitle"');
    expect(elements.get('loading').attributes).toContain('role="status"');
    expect(elements.get('announcer').attributes).toContain('aria-live="polite"');
    expect(elements.get('gameCanvas').attributes).toContain('role="application"');
    expect(elements.get('missionBar').tag).toBe('span');
  });

  it('keeps the sound glyph first so live state updates preserve its label', () => {
    const button = html.match(/<button\b[^>]*id="soundButton"[^>]*>([\s\S]*?)<\/button>/)[1];
    expect(button.trim()).toMatch(/^<span aria-hidden="true">[^<]+<\/span>/);
    const glyph = { textContent: '' };
    const attributes = {};
    const ui = new GameUI({ soundButton: {
      firstElementChild: glyph,
      setAttribute: (key, value) => { attributes[key] = value; },
    } });
    ui.setSound(false);
    expect(attributes).toEqual({ 'aria-pressed': 'false', 'aria-label': '開啟音效' });
    expect(glyph.textContent).toBe('×');
    ui.setSound(true);
    expect(attributes['aria-pressed']).toBe('true');
    expect(glyph.textContent).toBe('♪');
  });
});
