# Status Line Extension

Displays a real-time status footer in the Pi TUI showing:

- Model name and directory
- Skills and extensions count
- Context usage bar

## Display Format

```
Penny here, running on 🧠 claude-3.5-sonnet in 📁 /projects/penny, wielding: 🎯 5 Skills, and 🔌 6 Extensions
🎯 Skills: skill1, skill2, skill3
🔌 Extensions: extension1, extension2, extension3
· · · · · · · · · · · · · · · · · · · · · · · · · ·
📊 Context: ████████░░░░ 67% (134K/200K)
```

## Features

### Context Bar

- Visual representation of context window usage
- Color gradient: green (low) → yellow (medium) → red (high)
- Shows token count in thousands

### Skills & Extensions Discovery

- Scans `.pi/skills` for skills
- Scans `.pi/extensions` for extensions
- Caches results on session start

## Events

| Event           | Action                                    |
| --------------- | ----------------------------------------- |
| `session_start` | Discover skills/extensions, render footer |

## Configuration

Set the DA_NAME environment variable to customize the assistant name:

```bash
# In .env
DA_NAME=Penny
```

## Testing

```bash
cd .pi/extensions/statusline
bun install
bun test
```

## Architecture

```
session_start
     │
     ▼
┌──────────────────┐
│ Discover Skills  │
│ Discover Exts    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Set Footer       │
│ Render Function  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Subscribe to     │
│ context changes   │
└────────┬─────────┘
         │
         ▼
    Re-render on
    message updates
```

## Color Scheme (Atom One Dark)

| Element           | Color                    |
| ----------------- | ------------------------ |
| DA Name           | Purple (198, 120, 221)   |
| Model             | Orange (209, 154, 102)   |
| Directory         | Cyan (86, 182, 194)      |
| Skills/Extensions | Dark Blue (85, 155, 210) |
| Context 0-33%     | Green (152, 195, 121)    |
| Context 33-66%    | Yellow (229, 192, 123)   |
| Context 66-100%   | Red (224, 108, 117)      |

## Footer Rendering

The footer is rendered via `ctx.ui.setFooter()` which provides:

- TUI component library
- Theme colors
- Context usage data from `ctx.getContextUsage()`
