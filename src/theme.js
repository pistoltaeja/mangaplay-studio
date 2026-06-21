// @ts-check
/**
 * theme.js — runtime color-scheme swap.
 *
 * The app ships both light-theme.css and dark-theme.css. A single
 * <link id="active-theme"> in index.html points to whichever is active.
 * Switching themes = swap the link's href and set html[data-theme=name].
 *
 * Called by:
 *  - boot, with settings.colorScheme, BEFORE the chrome unhides (FOUC fix).
 *  - the settings modal's Appearance dropdown, on change.
 */

const VALID = new Set(["light", "dark"]);
const HREFS = {
    light: "./css/light-theme.css",
    dark:  "./css/dark-theme.css"
};

/**
 * Apply the named color scheme.
 * @param {string} name "light" | "dark"
 */
export function applyColorScheme(name)
{
    const target = VALID.has(name) ? name : "light";
    const link = document.getElementById("active-theme");
    if (link && link.tagName === "LINK")
    {
        const wanted = HREFS[target];
        // Avoid pointless re-load when already correct.
        if (link.getAttribute("href") !== wanted)
        {
            link.setAttribute("href", wanted);
        }
    }
    document.documentElement.setAttribute("data-theme", target);
}

/** Current active theme as a string. */
export function getColorScheme()
{
    return document.documentElement.getAttribute("data-theme") || "light";
}
