# 🎯 Focus Planner

A Chrome extension that helps you **commit to one plan, open what you need, and focus**.

1. **Plan:** say what you're working on right now.
2. **Apps:** list the apps or sites you need. Web apps open in a tab group named after your task.
3. **Focus:** pick a timer length and a background sound, then go.

![Focus Planner screenshots](docs/screenshots.png)

## Features

- **Three-step setup** that remembers your progress if the popup closes.
- **Smart app input:** type `gmail`, `notion`, `docs.google.com`, or a full URL and it becomes a tab to open. Anything else (e.g. `VS Code`) becomes a reminder you tick off. You can add several at once, separated by commas.
- **🔒 Focus lock:** while the timer runs, only the apps you listed for this task can be opened, in **every tab and every window**:
  - Going to another site shows a *Stay focused* page with your countdown and a **Back to my work** button.
  - **New tabs** open a focus page with your task, timer and one-click tiles for your apps, instead of Chrome's normal new tab page.
  - **New windows** and pop-ups follow the same rules. Switching to an off-limits tab, or to a window showing one, is blocked too.
  - **Incognito** windows are covered once you turn on *Allow in Incognito*. The popup won't start a strict session until you do, or until you confirm incognito is disabled on your computer. Off-limits incognito tabs are closed, because extension pages can't load in incognito.
  - Sign-in pages (Google, Microsoft) are allowed by default. Everything goes back to normal when the session ends.
- **💪 Strict mode** (on by default) closes the remaining escape routes:
  - No pausing and no "allow this site" button.
  - `chrome://extensions`, `chrome://settings`, local files and other extensions' pages are locked, so the extension can't be switched off mid-session.
  - Off-limits background tabs are unloaded so videos and music in them stop.
  - Ending early means typing the emergency phrase *"I choose to stop focusing now"* (pasting is disabled).
- **Tab grouping:**- **Tab grouping:** your web apps open in a 🎯 tab group named after your task.
- **Focus timer:** presets (15 / 25 / 45 / 60 / 90 min) or a custom length. Pause, resume, +5 min, or end early. A countdown shows on the toolbar badge.
- **Background sounds:** Rain, Ocean waves, Lo-fi chords, Brown / Pink / White noise, or **your own audio file**. All built-in sounds are generated live with the Web Audio API, so there are **no bundled audio files and no licensing issues**. You can preview any sound before starting.
- **Time's-up flow:** a chime, a desktop notification, and a prompt asking *"Did you finish?"* with options to extend.
- **History & stats:** focus time today and this week, plus tasks finished. You can export to CSV.
- **Private:** everything is stored locally with `chrome.storage` and IndexedDB. No accounts, no servers, no tracking.
- Light & dark mode, keyboard shortcut **Alt+Shift+F**.

## Install (development)

1. Clone or download this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the project folder (the one with `manifest.json`).
4. Pin **Focus Planner** from the puzzle-piece menu.

After editing code, click the ↻ reload button on the extension card.

## Project structure

```
manifest.json          Manifest V3 config
background.js          Service worker: timer state, alarms, badge, notifications, tabs
popup/                 The 3-step wizard, live session view, history
options/               Settings page (defaults, saved apps, custom audio, data export)
offscreen/             Hidden page that plays audio (service workers can't)
focus/                 "Stay focused" page for blocked sites + the focus new-tab page
lib/sounds.js          Web Audio sound generators + SoundEngine
lib/apps.js            Turns typed input into web apps / desktop reminders
lib/audio-store.js     IndexedDB storage for an uploaded audio file
lib/lock.js            Focus lock rules (which URLs are allowed)
lib/defaults.js        Default settings
icons/                 Toolbar and store icons
```

### How it fits together

- The **popup** only shows state and sends messages (`start`, `pause`, `extend`, …) to the service worker.
- The **service worker** keeps the session in `chrome.storage.local`, sets a `chrome.alarms` alarm for the end time, and updates the badge every 30 s. Because the state is stored, the timer survives the popup closing, the worker being suspended, and browser restarts.
- **Audio** plays in an [offscreen document](https://developer.chrome.com/docs/extensions/reference/api/offscreen) (`AUDIO_PLAYBACK`). Sounds loop from pre-rendered buffers and native audio nodes, with no JS timers, so playback doesn't stutter in the background.

## Permissions

| Permission      | Why                                                                |
| --------------- | ------------------------------------------------------------------ |
| `storage`       | Save your session, settings and history locally                    |
| `alarms`        | Fire when the timer ends, even if the popup is closed              |
| `offscreen`     | Play background sound (service workers can't play audio)           |
| `notifications` | "Time's up" notification with Finish / +5 min buttons              |
| `tabs`          | Focus lock: see which site a tab is on so off-limits ones can be blocked (Chrome shows this as "Read your browsing history"; nothing is stored or sent anywhere) |
| `tabGroups`     | Name and color the tab group for your task's apps                  |
| `favicon`       | Show site icons next to your apps                                  |

The extension doesn't need host permissions and can't read the content of the pages you visit, only their addresses (for focus lock).

## Limitations

- Focus lock works inside Chrome only. Chrome doesn't let any extension control:
  - other programs or browsers on your computer;
  - other Chrome profiles or Guest windows;
  - removing the extension from the toolbar menu (*Remove from Chrome*).

  For a fully locked-down setup, pair it with your operating system's focus or parental controls.
- Chrome extensions **can't launch desktop programs**. Desktop apps you list become a checklist to open yourself. (See the roadmap for ideas.)
- Some sites (e.g. Spotify) need you to be signed in before they're useful in a new tab.

## Roadmap ideas

- Launch desktop apps through URL schemes (`vscode://`, `spotify:`, `slack://`).
- Break timer and Pomodoro cycles.
- Sync history across devices with `chrome.storage.sync`.

## Publishing

**GitHub**

```bash
git init
git add .
git commit -m "Initial commit: Focus Planner extension"
git branch -M main
git remote add origin https://github.com/<your-username>/focus-planner.git
git push -u origin main
```

Then create a release (for example `v1.0.0`) and attach a zip of the folder so people can download it and load it unpacked.

**Chrome Web Store (optional)**

1. Bump `version` in `manifest.json`.
2. Zip the project **contents** (`manifest.json` must sit at the top level of the zip). You can leave out `docs/` and `README.md`.
3. Upload it in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole). There's a one-time developer fee. Use `icons/icon512.png` or `icon128.png` for the listing, and the permission table above for the permission justifications.

## License

[MIT](LICENSE)
