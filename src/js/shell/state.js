// Shared mutable state for the shell layer.
//
// Every module under src/js/shell/ reads and writes fields on the single
// `state` object below. Mutate fields; do not reassign the object.
// Field ownership (which module writes each field) is documented in
// TODO/app-js-shell-split.md.

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
    visualEditorEl: null,
    outlineView: null,
    statisticsView: null,
    applyEditorModeRef: null,
    editorAreaTopBarEl: null,
    editorBarPagePrevBtn: null,
    editorBarPageNextBtn: null,
    editorBarFixIssuesBtn: null,

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
