# Vertical App Grid
A GNOME Shell extension that turns the default horizontal app grid into a
vertical one. App icon size and spacing can be customized in the extension
preferences.

- Switch between **All** and **A–Z** views. Click the selected mode again to
  open the letter picker; A–Z group letters also open it.
  Choose a letter to jump to its group in A–Z, or select the first matching app
  in the current All order. Chinese names use their pinyin initial. Empty
  letters are disabled; press Escape or click the selected mode again to cancel.
- Existing GNOME app folders appear in the grid. Click a folder to open it;
  use the native edit button to rename it.
- Drop an app on the center of another app to create a folder, or on an
  existing folder to add it. Drag an app out of a folder to move it back to
  the grid or into another folder.
- Drop beside an icon or in a gap to reorder. In horizontal scrolling mode,
  use the top/bottom edges; otherwise use the left/right edges. This selects
  **Manual (Drag to Reorder)** sorting and saves the order. A–Z and Favorites
  keep their groups; use **All** for unrestricted ordering. Apps inside a
  folder use GNOME's native drag-to-reorder behavior.
- During a drag, hold near the scroll area's edge to scroll.

Folders use GNOME's standard app-folder settings. The extension stores its
grid order separately and preserves it when switching sorting modes.
Folder dialogs also participate in the native folder observers used by
Blur my Shell, retaining its blur and dialog style settings.

Install with `bash install.sh`, or create a bundle with
`bash install.sh --bundle`. Lightweight regression checks run with
`node tests/check.mjs` without starting a GNOME session.

![Screenshot](assets/vertical-app-grid.png)
