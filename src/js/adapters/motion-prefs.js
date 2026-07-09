// @ts-check
/**
 * motion-prefs.js — apply the Smooth Motion + Smooth Scrolling toggles
 * (Settings → Text Editor → Advanced) to the DOM.
 *
 * Both settings default ON. The DOM classes are the DISABLED phase — kept
 * absent on `<html>` when the setting is on, added when it's off. Reverse-
 * phased so a fresh install with no `<html>` class matches the default-on
 * behaviour, avoiding any first-paint flicker.
 *
 * Called by:
 *  - boot, from shell/boot.js after loadAppSettings().
 *  - the settings modal, on toggle click, for immediate live effect.
 */

const HTML_CLASS_NO_MOTION    = "no-smooth-motion";
const HTML_CLASS_NO_SCROLLING = "no-smooth-scrolling";

/**
 * Apply the smoothMotion preference. When OFF, adds `no-smooth-motion` to
 * <html> — CSS then zeroes every animation + transition duration.
 * @param {boolean} enabled true = default (animations on).
 */
export function applySmoothMotion(enabled)
{
    document.documentElement.classList.toggle(HTML_CLASS_NO_MOTION, enabled === false);
}

/**
 * Apply the smoothScrolling preference. When OFF, adds
 * `no-smooth-scrolling` to <html> — CSS then forces `scroll-behavior: auto`
 * on the document + every scroll container.
 * @param {boolean} enabled true = default (smooth scroll on).
 */
export function applySmoothScrolling(enabled)
{
    document.documentElement.classList.toggle(HTML_CLASS_NO_SCROLLING, enabled === false);
}
