/**
 * Desktop device manager stub.
 * Tauri WebView2 is always desktop context — `isMobile` is permanently false,
 * `subscribe()` returns a no-op unsubscribe so website call sites (view-manager,
 * mps-toolbar, mps-sidebar-nav) keep working without runtime errors.
 */

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
     * @param {function(boolean): void} _callback
     * @returns {function(): void} unsubscribe
     */
    subscribe(_callback)
    {
        return () => {};
    }
}

const deviceManager = new DeviceManager();

export { deviceManager };
