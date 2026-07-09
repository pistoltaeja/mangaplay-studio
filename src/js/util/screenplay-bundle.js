// @ts-check
/**
 * screenplay-bundle.js — shared prologue used by the Outline / Statistics
 * subviews to derive `{ screenplay, tokens, titlePage }` from the active
 * script + format.
 *
 * Returns `null` when:
 *   - `script` is falsy;
 *   - `fmt` is not one of the supported formats (`mangaplay`, `fountain`,
 *     `superscript`);
 *   - `astToScreenplay` or `screenplayToTokens` throws.
 *
 * The caller is expected to log/warn on `null` if needed — the helper itself
 * stays silent so error provenance shows the calling subview's tag, not this
 * shared utility.
 */

import { astToScreenplay } from "@mangaplay-studio/core";
import { screenplayToTokens } from "@fountain-plus/statistics";

/**
 * Build the `{ screenplay, tokens, titlePage }` triple for a left-pane
 * subview. The `titlePage` field is `null` when the screenplay has no title
 * page entries (use `!!titlePage` as the `hasTitlePage` flag for
 * `computeStatistics`).
 *
 * @param {any} script
 * @param {string|null|undefined} fmt
 * @returns {{ screenplay: any, tokens: any, titlePage: any }|null}
 */
export function screenplayBundleForPane(script, fmt)
{
    if (!script) return null;
    if (fmt !== "mangaplay" && fmt !== "fountain" && fmt !== "superscript")
    {
        return null;
    }
    let screenplay;
    try
    {
        screenplay = fmt === "fountain" ? script : astToScreenplay(script);
    }
    catch (_e)
    {
        return null;
    }
    let tokens;
    try
    {
        tokens = screenplayToTokens(screenplay);
    }
    catch (_e)
    {
        return null;
    }
    const rawTitlePage = screenplay?.titlePage || screenplay?.metadata?.titlePage;
    const hasTitlePage = !!(rawTitlePage && (rawTitlePage instanceof Map
        ? rawTitlePage.size > 0
        : Object.keys(rawTitlePage).length > 0));
    return {
        screenplay,
        tokens,
        titlePage: hasTitlePage ? rawTitlePage : null
    };
}
