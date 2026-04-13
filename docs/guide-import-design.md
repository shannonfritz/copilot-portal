# Guide Import Design

Import guides and prompts from GitHub Gists into Copilot Portal.

## File Convention

Gist files use a naming convention to identify guide/prompt pairs:

```
name_guide.md       → guide content
name_prompts.md     → companion prompts
README.md           → collection description (ignored by import)
```

- The prefix before `_guide` or `_prompts` is the item name
- Files without `_guide.md` or `_prompts.md` suffixes are ignored
- Multiple pairs can coexist in one gist (a "collection")
- A `_guide.md` without a matching `_prompts.md` (or vice versa) is valid

### Example Gist

```
crm-guide_guide.md
crm-guide_prompts.md
portal-dev_guide.md
portal-dev_prompts.md
README.md
```

This gist contains two items: `crm-guide` and `portal-dev`.

## Storage

Imported items go directly to `data/guides/` and `data/prompts/` — ready to use immediately. No intermediate examples step.

Import metadata is tracked in `data/imports.json` for re-import support:

```json
{
  "abc123": {
    "url": "https://gist.github.com/shannonfritz/abc123",
    "description": "My CRM guides collection",
    "importedAt": "2026-04-13T17:00:00Z",
    "items": ["crm-guide", "portal-dev"]
  }
}
```

### Why straight to `data/`?

Import → examples → +New → preview → Add → Apply is too many steps. Going straight to `data/` means:
- Items appear in the picker immediately after import
- Same number of steps as +New from an example
- User can apply, edit, or delete right away
- Import metadata in `imports.json` supports re-import/update later

## UX Flow

### Import Button

An **Import** button next to +New at the bottom of the guides picker list.

### Import Dialog

1. Text input to paste a GitHub Gist URL
2. **Load** button fetches and parses the gist
3. Shows a list of discovered items with checkboxes (all selected by default):
   ```
    ☑ crm-guide (guide + prompts)
    ☑ portal-dev (guide only)
   ```
4. Clicking an item name shows:
   - Name field (editable — changes the filename on save)
   - Guide/Prompts tabs with read-only preview of content
5. Users can deselect an entire pair but not individual guide/prompts files
6. Name conflict: show inline overwrite confirmation (same as +New)
7. **Add to Portal** button saves selected items to `data/`
8. **Cancel** returns to the picker

After import, items appear in the picker list immediately.

## API

### `POST /api/guides/import-preview`

Fetch a gist and return discovered items for preview.

Request: `{ "url": "https://gist.github.com/user/abc123" }`

Response:
```json
{
  "gistId": "abc123",
  "description": "My CRM guides collection",
  "items": [
    {
      "name": "crm-guide",
      "hasGuide": true,
      "hasPrompts": true,
      "guideContent": "# CRM Guide\n...",
      "promptsContent": "## Check customer\n..."
    }
  ]
}
```

### `POST /api/guides/import`

Save selected items to `data/` and update `imports.json`.

Request:
```json
{
  "gistId": "abc123",
  "url": "https://gist.github.com/user/abc123",
  "description": "My CRM guides collection",
  "items": [
    { "name": "crm-guide", "guideContent": "...", "promptsContent": "..." }
  ]
}
```

Response: `{ "imported": ["crm-guide"] }`

## Server Implementation

### Fetching Gists

```typescript
const gistId = url.match(/gist\.github\.com\/\w+\/(\w+)/)?.[1];
const apiUrl = `https://api.github.com/gists/${gistId}`;
// Try unauthenticated first, fall back to gh auth token
const response = await fetch(apiUrl, { headers });
const gist = await response.json();
```

### Parsing Files

```typescript
const items = new Map<string, { guide?: string; prompts?: string }>();
for (const [filename, file] of Object.entries(gist.files)) {
  const guideMatch = filename.match(/^(.+)_guide\.md$/);
  const promptsMatch = filename.match(/^(.+)_prompts\.md$/);
  if (guideMatch) {
    const name = guideMatch[1];
    if (!items.has(name)) items.set(name, {});
    items.get(name)!.guide = file.content;
  } else if (promptsMatch) {
    const name = promptsMatch[1];
    if (!items.has(name)) items.set(name, {});
    items.get(name)!.prompts = file.content;
  }
}
```

## Auth

- Public gists: no auth needed
- Private/secret gists: use `gh auth token` (same pattern as portal self-update)
- Gist API rate limit: 60/hour unauthenticated, 5000/hour authenticated

## Future Expansion

- Support raw `.md` URLs (single file import, treated as guide)
- Support GitHub repo paths (folder with guides/ and prompts/ subdirectories)
- "Export as Gist" button in the editor
- Periodic update checks for imported gists
- Import registry / community directory (much later)
