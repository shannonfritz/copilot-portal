# Theme System Design

Global theme support with preset picker, custom theme editor, and auto-derived colors.

## Current State

- Dark and Light themes via CSS custom properties (`[data-theme="light"]`)
- 25 CSS variables define a complete theme
- Sun/moon toggle in header bar
- Theme persists in localStorage

## Design

### Preset Picker

A dropdown or swatch grid replacing the current sun/moon toggle:
- **Dark** (default, not deletable)
- **Light** (not deletable)
- User-created custom themes (deletable)
- **+ New Theme** option opens the editor

### Theme Editor

Two color pickers that derive all 25+ variables:

**Inputs:**
1. **Base color** — the background color. Everything else is derived from it.
2. **Accent color** — the interactive/brand color. Buttons, links, highlights.

**Auto-derived colors:**

From Base:
```
bg          = base
surface     = lighten(base, 5%)
border      = lighten(base, 15%)
text        = auto-contrast(base) — white if base is dark, black if light
text-muted  = midpoint(base, text) at 50% opacity
text-bright = full contrast (white or black)
overlay     = rgba(0,0,0, isDark ? 0.6 : 0.3)
subtle-bg   = rgba(contrast, isDark ? 0.08 : 0.04)
code-bg     = darken(base, 3%)
code-fg     = text
scrollbar   = rgba(contrast, 0.15)
button-contrast = isDark ? #111 : #fff
```

From Accent:
```
primary       = accent
primary-hover = darken(accent, 10%)
accent        = accent
primary-tint  = rgba(accent, 0.10)
```

Status colors (semantic, mostly fixed):
```
error    = red variant, contrast-checked against base
success  = green variant, contrast-checked against base
warning  = amber variant, contrast-checked against base
shield   = amber variant
tool-call = gold/olive variant
purple   = purple variant
code-inline = orange/brown variant (dark) or dark orange (light)
```

Status tints auto-derived:
```
error-tint   = rgba(error, isDark ? 0.10 : 0.08)
success-tint = rgba(success, isDark ? 0.10 : 0.08)
...etc
```

### Contrast Logic

Use WCAG relative luminance and contrast ratio:

```typescript
function luminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
```

Rules:
- Text on background must have ≥ 4.5:1 contrast ratio (WCAG AA)
- Status colors on background must have ≥ 3:1 contrast ratio
- If a status color fails contrast against the base, shift its lightness until it passes
- Auto-pick text color: if base luminance > 0.5, use dark text; otherwise light text

### Live Preview

The editor applies changes immediately via CSS variables (no save required to preview). The user sees the full portal update in real-time as they drag the color picker.

### Storage

Custom themes saved to localStorage:
```json
{
  "portal_themes": {
    "my-blue": { "base": "#1a1a2e", "accent": "#e94560", "name": "Midnight Blue" },
    "warm-dark": { "base": "#2d2424", "accent": "#ff6b6b", "name": "Warm Dark" }
  },
  "portal_theme": "my-blue"
}
```

Only base + accent + name are stored. All other values are computed at runtime.

### UI Placement

**Header:** Replace the sun/moon toggle with a theme button that opens a popover:
- Shows current theme name/swatch
- Popover shows preset grid + "+ New Theme" button
- Clicking a preset switches immediately
- "+ New Theme" opens the editor inline in the popover (or as a modal)

**Editor layout:**
```
┌─────────────────────────────┐
│ Theme Name: [____________]  │
│                             │
│ Base:   [color picker] #hex │
│ Accent: [color picker] #hex │
│                             │
│ Preview:                    │
│ ┌─────────────────────────┐ │
│ │ Sample text, buttons,   │ │
│ │ status indicators...    │ │
│ └─────────────────────────┘ │
│                             │
│        [Cancel] [Save]      │
└─────────────────────────────┘
```

### Future: Per-Session Themes

The global theme is the default. Later, sessions can override:
- Store `themeId` per session (alongside model, agent)
- On session switch, apply session theme or fall back to global
- Agent configs could specify a preferred theme

## Implementation Order

1. Color derivation utilities (luminance, contrast, lighten/darken, derive full palette from base+accent)
2. Replace sun/moon toggle with theme picker popover (Dark, Light presets)
3. Add "+ New Theme" with inline editor (two color pickers + name)
4. Live preview via CSS variable injection
5. Save/delete custom themes in localStorage
6. Per-session override (future)

## Open Questions

1. **Should the editor show a mini preview or use the full portal as the preview?** Full portal is more honest but the editor needs to be visible too.

2. **Color picker widget:** Use the browser's native `<input type="color">` or a custom picker? Native is easiest and works everywhere. Custom would be prettier.

3. **Status color adjustment:** How aggressively should we shift status colors? Subtle lightness shift, or fully re-map to a different hue family?

4. **Import/export:** Should custom themes be shareable (via gist, like guides)? Probably yes, eventually — but just localStorage for v1.
