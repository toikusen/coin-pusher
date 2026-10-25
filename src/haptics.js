import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

// Real taps on an iPhone, where navigator.vibrate does nothing inside the app's web view. Every
// call is fire and forget: a phone without a Taptic Engine, or a browser, must never hold up a
// payout or surface an error. Independent of the sound toggle - muting the game is not muting touch.
const quietly = (promise) => promise.catch(() => {});

/** A light tick: a coin dropped, a reel locked. */
export const tapHaptic = () => quietly(Haptics.impact({ style: ImpactStyle.Light }));
/** A firmer knock: a combo bonus, a chest arriving. */
export const thudHaptic = () => quietly(Haptics.impact({ style: ImpactStyle.Medium }));
/** The win pattern, once per chest prize. */
export const winHaptic = () => quietly(Haptics.notification({ type: NotificationType.Success }));
