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

Imported collections go into `data/imports/{gist-id}/`:

```
data/imports/
  abc123/                          ← gist ID
    meta.json                      ← source URL, import date, gist description
    guides/crm-guide.md
    prompts/crm-guide.md
    guides/portal-dev.md
    prompts/portal-dev.md
```

### Why not `examples/` or `data/guides/`?

- `examples/` is shipped with the portal and overwritten on update
- `data/guides/` is the user's working files — importing directly there makes it unclear what's "mine" vs "imported" and risks overwriting user edits
- `data/imports/` is user-managed, survives portal updates, and keeps imported content separate

Imported items appear in the +New flow alongside shipped examples, but in their own "Imported" section. The user copies them to `data/` to use (same as examples).

## UX Flow

### Import (in the +New panel)

1. Text input: "Import from URL" with a paste field
2. User pastes a GitHub Gist URL
3. Portal fetches the gist, discovers `_guide.md` / `_prompts.md` pairs
4. Shows a list of discovered items with checkboxes:
   ```
   Import from gist.github.com/shannonfritz/abc123:
    ☑ crm-guide (guide + prompts)
    ☑ portal-dev (guide only)
    [Import]
   ```
5. Selected items are saved to `data/imports/{gist-id}/`
6. Items appear in the +New examples list under an "Imported" section

### Using Imported Items

Same as shipped examples:
- Browse in +New → select → preview → customize name → Add
- Copies to `data/guides/` and `data/prompts/` as working files
- User can edit their copy without affecting the import

### Re-importing

Importing the same gist URL again updates `data/imports/{gist-id}/` in place. User's working copies in `data/` are not affected.

### Removing an Import

Delete the `data/imports/{gist-id}/` directory (future: UI for this).

## API

### `POST /api/guides/import-preview`

Fetch a gist and return discovered items for preview.

Request: `{ url: "https://gist.github.com/user/abc123" }`

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

Save selected items from a previewed gist.

Request:
```json
{
  "url": "https://gist.github.com/user/abc123",
  "gistId": "abc123",
  "description": "My CRM guides collection",
  "items": [
    { "name": "crm-guide", "guideContent": "...", "promptsContent": "..." }
  ]
}
```

Response: `{ imported: ["crm-guide"] }`

### Changes to `GET /api/examples`

Extend to include imported items alongside shipped examples. Each item includes a `source` field:
- `source: "shipped"` — from `examples/`
- `source: "imported"` — from `data/imports/`, includes `gistUrl`

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
- "Import" section in the picker UI showing all imported collections
- Sharing from the portal: "Export as Gist" button in the editor
- Import registry / community directory (much later)

## Open Questions

- Should importing auto-copy to data/ (ready to use immediately)?
  Or keep the examples pattern (browse → preview → add)?
- Should the portal periodically check for updates to imported gists?
- How should name conflicts be handled when importing items that match existing user files?
