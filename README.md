# Mangaplay Studio - Desktop Application

> **Work in progress.** This repository is under active, ongoing development. It does not build and latest changes are months behind intentionally. There is no incentive to share code online anymore in a timely manner. I'm sorry

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
| Windows | `%APPDATA%\studio.mangaplay.app\user-settings.json`             |
| macOS   | `~/Library/Application Support/studio.mangaplay.app/`           |
| Linux   | `~/.config/studio.mangaplay.app/user-settings.json`                |

`user-settings.json` also holds a `projectSessions` sub-map keyed by each
project's UUID (from `project.json.id`). Per-user "slice-of-life" state —
open tabs, cursor positions, view mode, expanded folders, canvas heights —
lives here rather than inside the project folder, so SVN diffs stay quiet
and teammates never see each other's local scroll positions or window
layout. Renaming or moving the project folder does not lose this state
because the UUID is stable.

Team-relevant per-project state stays inside the project's
`_mangaplaystudio/` folder (`project.json`, `registry.json`,
`meta.json { savedAt, folderTypes }`, `storyboard/`) and is intended to be
committed to SVN.

## More coming soon
