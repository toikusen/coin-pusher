// Pin board themes. A theme draws the board and nothing else - pins and bumpers stand where
// PIN_BOARD puts them, because pachinko.js is calibrated against those positions. See nocturne.js
// for the contract: build(ctx) returns { pins, bumpers, carriage, shuttle, neon, animate }.
import { nocturne } from './nocturne.js';

export const BOARD_THEMES = Object.freeze({ [nocturne.id]: nocturne });
export const DEFAULT_BOARD_THEME = nocturne.id;

/** The theme for `id`, or the default for an unknown one. */
export function boardThemeFor(id) {
  return BOARD_THEMES[id] ?? BOARD_THEMES[DEFAULT_BOARD_THEME];
}
