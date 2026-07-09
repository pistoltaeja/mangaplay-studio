// @ts-check
/**
 * onboarding-engine.js — Sequential step runner for scripted onboarding.
 *
 * Each step is `{type, ...}`. Steps run one at a time; each awaits the
 * previous. `speak` runs mascot.talk() in PARALLEL with dialogue.show()
 * and awaits both.
 *
 * Supported step types:
 *   move, face, bobble, talk, speak, hideDialogue, wait, setBadge,
 *   clearBadge, exit, waitForClick, showCards, waitForCardSelected,
 *   hideButton, dismissCards.
 *
 * `waitForCardSelected` waits for the FIRST `card-selected` event on
 * `document`, then calls `ctx.cardTray.showButton(step.buttonLabel)`.
 * Subsequent `card-selected` events just track selection (button stays
 * visible). On `card-button-clicked`, the step resolves. If
 * `step.storeAs` is set, the chosen id is written to
 * `ctx.results[step.storeAs]`.
 *
 * `dismissCards` and `hideButton` delegate to the corresponding
 * cardTray methods.
 *
 * Public API: runOnboardingScript(steps, ctx) → Promise<void>.
 *   ctx = { mascot, dialogue, cardTray, results? }.
 *   `ctx.results` is initialised to `{}` if absent — callers can read
 *   `storeAs` outcomes after the script completes.
 */

async function runStep(step, ctx)
{
    const { mascot, dialogue, cardTray } = ctx;
    switch (step.type)
    {
        case "move":
            await (mascot?.moveTo?.(step.x, step.y) ?? Promise.resolve());
            break;
        case "face":
            await (mascot?.face?.(step.direction || "center") ?? Promise.resolve());
            break;
        case "bobble":
            await (mascot?.bobble?.() ?? Promise.resolve());
            break;
        case "talk":
            await (mascot?.talk?.(step.cycles) ?? Promise.resolve());
            break;
        case "speak":
        {
            const text = String(step.text || "");
            const tail = step.tail || "above";
            const cycles = step.cycles || Math.max(2, Math.ceil(text.length / 20));
            await Promise.all([
                mascot?.talk?.(cycles) ?? Promise.resolve(),
                dialogue?.show?.(text, { tail }) ?? Promise.resolve(),
            ]);
            break;
        }
        case "hideDialogue":
            await (dialogue?.hide?.() ?? Promise.resolve());
            break;
        case "wait":
            await new Promise(r => setTimeout(r, Number(step.ms) || 0));
            break;
        case "setBadge":
            mascot?.setBadge?.(String(step.name || ""));
            break;
        case "clearBadge":
            mascot?.setBadge?.("");
            break;
        case "exit":
            await (mascot?.exit?.(step.direction || "right") ?? Promise.resolve());
            break;
        case "waitForClick":
        {
            const graceMs = Number(step.graceMs) || 250;
            await new Promise(r => setTimeout(r, graceMs));
            await new Promise((resolve) =>
            {
                const onDown = (e) =>
                {
                    if (e.button && e.button !== 0) return;
                    window.removeEventListener("pointerdown", onDown, true);
                    resolve();
                };
                window.addEventListener("pointerdown", onDown, true);
            });
            break;
        }
        case "showCards":
        {
            const cards = Array.isArray(step.cards) ? step.cards : [];
            const opts = { stagger: step.stagger || 60 };
            if (step.layout) opts.layout = step.layout;
            await (cardTray?.show?.(cards, opts) ?? Promise.resolve());
            break;
        }
        case "waitForCardSelected":
        {
            // Two-phase wait:
            //   1) First card-selected → mount the button.
            //   2) card-button-clicked → resolve with the chosen id.
            // Selection changes after phase 1 keep the button mounted
            // (no re-anim) and update the internal selection tracked
            // by the tray.
            const buttonLabel = String(step.buttonLabel || "");
            let buttonMounted = false;
            const chosenId = await new Promise((resolve) =>
            {
                const onSelected = () =>
                {
                    if (buttonMounted) return;
                    buttonMounted = true;
                    // Fire-and-forget: don't block the promise on the
                    // button's entrance animation.
                    Promise.resolve(cardTray?.showButton?.(buttonLabel)).catch(() => {});
                };
                const onClicked = (e) =>
                {
                    document.removeEventListener("card-selected", onSelected);
                    document.removeEventListener("card-button-clicked", onClicked);
                    const id = (e && e.detail && e.detail.id) || cardTray?.getSelected?.() || null;
                    resolve(id);
                };
                document.addEventListener("card-selected", onSelected);
                document.addEventListener("card-button-clicked", onClicked);
            });
            if (step.storeAs && ctx.results)
            {
                ctx.results[step.storeAs] = chosenId;
            }
            break;
        }
        case "hideButton":
        {
            await (cardTray?.hideButton?.({ slideLeft: !!step.slideLeft }) ?? Promise.resolve());
            break;
        }
        case "dismissCards":
        {
            const opts = {
                direction: step.direction || "rightToLeft",
                stagger: step.stagger || 80,
            };
            await (cardTray?.dismissCards?.(opts) ?? Promise.resolve());
            break;
        }
        default:
            console.warn("[onboarding-engine] unknown step:", step?.type);
    }
}

/**
 * Run an ordered list of steps against a mascot + dialogue pair.
 * @param {Array<any>} steps
 * @param {{mascot: any, dialogue: any, cardTray?: any, results?: Record<string, any>}} ctx
 * @returns {Promise<void>}
 */
export async function runOnboardingScript(steps, ctx)
{
    ctx.results = ctx.results || {};
    for (const step of (steps || []))
    {
        await runStep(step, ctx);
    }
}
