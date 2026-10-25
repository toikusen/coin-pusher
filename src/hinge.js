import { Capacitor, registerPlugin } from '@capacitor/core';

const Hinge = registerPlugin('Hinge');

/**
 * Whether a hinge reading comes from a real hinge. A phone without one reports 'unknown' (as does a
 * foldable before UIHingeInteraction's first update), and must keep the plain phone layout.
 */
export function hasHinge({ status }) {
  return status !== 'unknown';
}

/**
 * Subscribe to the current iPhone hinge state and later changes.
 * @param {(state: { angle: number | null, status: 'closed' | 'partiallyOpen' | 'fullyOpen' | 'unknown' }) => void} onChange
 * @returns {() => void} Stops callbacks and removes the native listener.
 */
export function watchHinge(onChange) {
  if (!Capacitor.isNativePlatform()) return () => {};

  let active = true;
  let listener;
  void Hinge.addListener('change', (state) => {
    if (active) onChange(state);
  }).then((handle) => {
    listener = handle;
    if (!active) void handle.remove();
  });
  void Hinge.getState().then((state) => {
    if (active) onChange(state);
  });

  return () => {
    active = false;
    if (listener) void listener.remove();
  };
}
