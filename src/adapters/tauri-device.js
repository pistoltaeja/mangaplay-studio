/**
 * Desktop device manager stub.
 * Tauri WebView2 is always desktop context.
 */

const MOBILE_BREAKPOINT = 1280;

class DeviceManager
{
    /** @returns {boolean} */
    get isMobile()
    {
        return false;
    }

    /** @returns {boolean} */
    get isDesktop()
    {
        return true;
    }

    /**
     * @param {function(boolean): void} callback
     * @returns {function(): void} unsubscribe
     */
    subscribe(callback)
    {
        return () => {};
    }

    destroy() {}
}

const deviceManager = new DeviceManager();

export { MOBILE_BREAKPOINT, deviceManager, DeviceManager };
