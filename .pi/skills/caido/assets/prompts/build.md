# Build Prompt — Caido Extension Build & Package

## Mission

Build the Caido extension, verify the output, and present install instructions to the user.

## Build Steps

1. **Full pipeline check** — Run `npm run check` (lint + typecheck + test). Must pass.
2. **Build** — `npx caido-dev build`
3. **Verify ZIP** — Check `dist/plugin_package.zip` contains:
   - `manifest.json` at root
   - `<plugin-backend-id>/index.js` (if backend)
   - `<plugin-frontend-id>/index.js` + `index.css` (if frontend)
4. **Validate manifest** — Build log must show "Validating manifest data" with no errors
5. **Copy to release location** — `cp dist/plugin_package.zip ~/projects/caido-plugins/<plugin-name>-v<version>.zip`

## Post-Build User Instructions

Present these to the user based on extension type:

### All Extensions
```
Install: Settings → Plugins → Install Plugin Package → select the .zip
Enable: Toggle the plugin ON in the Plugins table
```

### Backend Plugins with onUpstream
```
⚠️ IMPORTANT: This plugin uses onUpstream which requires domain rules.
After installing, go to:
  Settings → Network → Upstream Plugins → Add Rule
Set the domain to * (or your target domain) and select "<Plugin Backend Name>"
Verify: Browse to httpbin.org/get — injected headers appear in response body
```

### Frontend Plugins
```
Access: Look for "<Plugin Name>" in the left sidebar
```

### Workflows
```
Import: Workflows → Passive → Import → select the workflow JSON file
```

## Verification Commands

Present these for the user to verify the extension works:
- **Backend**: Check Caido logs (tail ~/.local/share/caido/logs/logging.*.log) for `[plugin-name]` messages
- **Frontend**: Click the sidebar item, verify the page renders
- **Workflow**: Browse a site through proxy, check HTTP History for workflow-generated requests

## Output

```
SUMMARY:{"build":"ok|fail","manifest_valid":true|false,"zip_size_bytes":<n>,"files_in_zip":<n>,"has_backend":true|false,"has_frontend":true|false,"has_workflow":true|false,"build_complete":true}
```
