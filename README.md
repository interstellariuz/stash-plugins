# stash-inz-plugins

UI plugins for [Stash](https://github.com/stashapp/stash).

## Plugins

### inz-date-select

Adds date-based filtering to the two pickers that link scenes and galleries together:

- **Scene editor → Galleries** (`GallerySelect` / `FindGalleriesForSelect`)
- **Gallery editor → Scenes** (`SceneSelect` / `FindScenesForSelect`)

Two buttons appear under the picker:

| Button      | Effect                                                                  |
| ----------- | ----------------------------------------------------------------------- |
| `Same date` | Only entries whose date equals the edited entity's date (`date EQUALS`) |
| `±N d`      | Only entries within N days of it (`date BETWEEN`), N is configurable    |

The reference date is read live from the `Date` field of the same form, so it follows unsaved
edits. While a filter is active the dropdown is reordered by distance from that date instead of
alphabetically.

The buttons only show up in the scene and gallery edit panels. Every other place that uses these
pickers — the image editor, bulk edit, the scene merge dialog — is left untouched.
