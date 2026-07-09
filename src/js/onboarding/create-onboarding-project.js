// @ts-check
import { invoke } from "@tauri-apps/api/core";
import { createNewProject, updateRecent } from "../project/project.js";
import { pathExists, saveUserSettings } from "../project/user-settings.js";
import { openAndMountProject } from "../shell/open-and-mount-project.js";

/**
 * Create a new project for the user based on their onboarding selections,
 * save relevant settings, then transition the app into the workspace.
 *
 * Currently: creates an empty "MyFirstProject" (or numbered suffix) in the
 * user-data dir. The `category` and `template` params are captured but not
 * yet used to differentiate project seed content — they're placeholders for
 * future logic (e.g. seed a 24-page comic template when template === "real-comic").
 *
 * Side effects:
 *   - Creates a new project via Rust project_create_new.
 *   - saveUserSettings({ onboardingCompleted: true, lastProjectPath: <newPath> }).
 *   - updateRecent(newPath).
 *   - Delegates the open + mount + reveal sequence to openAndMountProject,
 *     the shared source of truth also used by the auto-resume boot path.
 *   - Removes the onboarding-only DOM surfaces (mascot, dialogue, card-tray).
 *
 * @param {{ category: string, template: string }} params
 * @returns {Promise<string>} the created project path
 */
export async function createOnboardingProject(params)
{
    console.log("[onboarding] createOnboardingProject:", params);

    // 1. Resolve target parent dir.
    const userDataDir = await invoke("user_data_dir");

    // 2. Pick a candidate name — mirror ensureMobileDefaultProject logic.
    let candidate = `${userDataDir}/MyFirstProject`;
    if (await pathExists(candidate))
    {
        let n = 2;
        while ((await pathExists(`${userDataDir}/MyFirstProject (${n})`)) && n < 9999) n++;
        candidate = `${userDataDir}/MyFirstProject (${n})`;
    }
    const name = candidate.substring(userDataDir.length + 1);

    // 3. Create the project on disk.
    const newPath = await createNewProject(userDataDir, name);

    // 4. Persist onboardingCompleted BEFORE the open call so the flag
    //    lands even if openAndMountProject throws. openAndMountProject
    //    will re-save lastProjectPath internally.
    await saveUserSettings({ onboardingCompleted: true, lastProjectPath: newPath });

    // 5. Update the recents list (non-fatal).
    await updateRecent(newPath).catch(() => {});

    // 6. Reuse the shared open+mount path. showSplash:false because the
    //    <mps-splash> was already dismissed via splash.done() when the
    //    ONBOARDING FSM state was entered (see boot.js).
    const shell = /** @type {any} */ (document.getElementById("picker-shell"));
    await openAndMountProject(newPath, {
        shell,
        isMobileRecovery: false,
        showSplash: false,
    });

    // 7. Clean up onboarding-only surfaces. position:fixed with high
    //    z-indexes (mascot 1000, card-tray 10021, dialogue 10022) so
    //    they float above the workspace if left in the DOM.
    document.querySelector("mps-mascot")?.remove();
    document.querySelector("mps-dialogue")?.remove();
    document.querySelector("mps-card-tray")?.remove();

    // 8. Return the created path.
    return newPath;
}
