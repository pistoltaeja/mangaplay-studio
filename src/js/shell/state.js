// Shared mutable state for the shell layer.
//
// Every module under src/js/shell/ reads and writes fields on the single
// `state` object below. Mutate fields; do not reassign the object.

export const state = {
    // slots + editor
    slotManager: null,
    editorTabs: null,
    emptyTabCta: null,
    rightPaneEmpty: null,
    activeSlotIsPlaceholder: true,
    activeFormat: "mangaplay",
    canvasApi: null,
    modeToggleEl: null,
    appFooter: null,
    easyEditorEl: null,
    outlineView: null,
    statisticsView: null,
    applyEditorModeRef: null,
    editorAreaTopBarEl: null,
    editorBarPagePrevBtn: null,
    editorBarPageNextBtn: null,
    editorBarFixIssuesBtn: null,
    editorToolbarEl: null,

    // project + fs
    currentProject: null,
    folderList: null,
    recentProjects: [],
    platform: { os: "browser", mode: "browser" },
    projectFsChangedWired: false,
    registryFsChangedWired: false,
    swappingProject: false,
    manageProjectsActive: false,

    // view / layout
    viewMode: "dual",
    lastSoloMode: "solo-storyboard",
    shellWired: false,

    // save state
    saveState: "saved",
    saveFailureBannerShown: false,
    debouncedScreenplayUpdate: null,
    debouncedScriptSave: null,

    // boot / state machine
    currentState: "booting",
    bootStartedAt: performance.now(),
    shutdownInFlight: false,

    // pagination
    paginationPageIndex: 0,
    paginationTotalPages: 1,
    paginationPageLabel: null,
    renderTopbarPagination: null,

    // pills / menus
    publishDocPillCtrl: null,
    publishSlidesPillCtrl: null,
    slidesLinkedForActive: false,
    // Slides sync status for the active script. Updated asynchronously
    // after slot activation. Drives the badge overlay on the Slides pill.
    //   null             — check not yet run or skipped (no auth, non-mangaplay)
    //   "synced"         — remote revisionId matches lastKnownRevisionId
    //   "remote-changed" — remote revisionId differs from stored value
    //   "unknown"        — no stored revisionId to compare against
    slidesSyncStatus: null,
    // Monotonic generation counter — incremented on every slot activation
    // that triggers a sync-status check. The fire-and-forget IIFE captures
    // the value before awaiting and bails if it changed (another activation
    // superseded this one).
    slidesSyncCheckGen: 0,
    // True when the active file lives in a Storyboard Folder — drives the
    // Publish Slides pill's tooltip variant + the "Group Google Slides™"
    // menu label. Refreshed by onSlotActivated (app.js).
    publishScopeIsFolder: false,
    projectSwitcherMenuEl: null,
    lastRightClickedFolder: null,
    lastRightClickedFolderUuid: null,

    // misc
    exportScreenplayModalPromise: null,
    cachedClientId: null,
};

// Frozen constants. These never change and are safe to import by value.
export const MIN_DISPLAY_MS = 400;
export const SCREENPLAY_DEBOUNCE_MS = 80;
export const SCRIPT_DEBOUNCE_MS = 1500;
export const ART_DEBOUNCE_MS = 1000;
