# Mangaplay Studio - Desktop Application

The Mangaplay Studio App is a text edit built solely for writing comic books, manga, graphic novels and webtoons with screenplays and storyboards in mind.

[Superscript](https://superscript.app/) by Justin Silva's was an amazing dedicated comic
script editor but was discontinued in 2024 and released as free open source with no further development planned. 

Mangaplay Studio carries that workflow forward, extends the plain-text format into a markdown stynax for manga, webtoons, graphic novels that naturally produce screenplays as a bonus.

Where Superscript was a text-only desktop editor, Mangaplay renders pages and panels live beside your script. 

Mangaplay Studio has built in support for Superscript's `.sup` and Fountain's `.fountain` in the `.mangaplay.md` format for a clean interops for screenplays in Final Draft, Fade In or PDF with no extra work.

We are not affiliated with Superscript or its author. The lineage is in the workflow, not the code.

## User data and portable mode

Mangaplay Studio stores small per-user preferences in `user-settings.json`. By
default this lives in the OS-correct user-config directory:

| OS      | Default path                                                       |
|---------|--------------------------------------------------------------------|
| Windows | `%APPDATA%\com.mangaplay.studio.desktop\user-settings.json`        |
| macOS   | `~/Library/Application Support/com.mangaplay.studio.desktop/`      |
| Linux   | `~/.config/com.mangaplay.studio.desktop/user-settings.json`        |

### Portable mode (Windows + Linux)

To carry your settings on a USB stick or run from an extracted archive without
touching your user profile, create an empty file named `portable` (no extension)
next to `MangaplayStudio.exe` (or the AppImage on Linux). On the next launch
the app switches storage to `<exe-folder>/userdata/`, including
`user-settings.json`.

| Marker present | Folder writable | Effective storage                  |
|----------------|------------------|------------------------------------|
| Yes            | Yes              | `<exe-folder>/userdata/`           |
| Yes            | No               | OS default (silent fallback)       |
| No             | —                | OS default                         |

### Why macOS ignores the marker

macOS short-circuits the marker. Gatekeeper "App Translocation" launches
quarantined apps from a randomised read-only path, and a notarised `.app`
bundle's signature seals every resource — writing inside it invalidates the
signature and Gatekeeper refuses subsequent launches. Settings always live
under `~/Library/Application Support` on macOS.

## More coming soon
