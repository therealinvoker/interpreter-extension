# Changelog

## 0.0.101

### Changes

- **Expose browser tab control state directly**: Tab inventory now reports explicit `observable` or `controllable` state for each listed Chrome tab while retaining legacy relay fields for older clients.

## 0.0.100

### Changes

- **Expose viewport screen bounds with page element inventory**: The extension now reports the observed page viewport's screen bounds so Interpreter can map Chrome page element refs into overlay selection coordinates.

## 0.0.99

### Changes

- **Use observed-tab wording in window arrangement errors**: Replaced stale shared-tab terminology in extension-side browser window arrangement failures.

## 0.0.98

### Changes

- **Honor read, write, and action browser-control permissions**: Interpreter browser control now lets the relay inspect allowed tabs while separately blocking typing/navigation and click/scroll/claim/control actions when those permission classes are denied.

## 0.0.97

### Changes

- **Claim observed tabs for Playwright control through the local relay**: Interpreter can ask the extension to attach an allowed observed tab so advanced browser-control code can run against that exact Chrome tab.

## 0.0.96

### Changes

- **Select bounded page element refs through the local relay**: Interpreter can ask the private relay to choose one exact option value on a policy-allowed select element, draw in-page feedback, and reject stale refs before acting.

## 0.0.95

### Changes

- **Scroll policy-allowed page frames through the local relay**: Interpreter can ask the private relay to scroll a current tab/frame and receive the resulting viewport scroll position.

## 0.0.94

### Changes

- **Type into bounded page element refs through the local relay**: Interpreter can ask the private relay to replace one policy-allowed editable page element value, draw in-page feedback, and reject stale refs before acting.

## 0.0.93

### Changes

- **Click bounded page element refs through the local relay**: Interpreter can ask the private relay to click a policy-allowed page element ref, draw the same short-lived in-page feedback, and reject stale refs before acting.

## 0.0.92

### Changes

- **Draw page-local browser control traces**: Interpreter can ask the private relay to show a short-lived in-page trace for a policy-allowed tab element or rectangle, with stale element refs rejected before drawing.

## 0.0.91

### Changes

- **Expose bounded page element inventory to the local relay**: Interpreter can request read-only DOM element refs, bounds, frame metadata, and document revision for a policy-allowed tab through the private relay.

## 0.0.90

### Changes

- **Allow the local relay to activate observed browser tabs**: Interpreter can now ask the extension to focus a listed Chrome tab without requiring that tab to already be a controllable Playwright target.

## 0.0.89

### Changes

- **Expose read-only browser tab inventory to the local relay**: The background worker can now list current Chrome windows and tabs for Interpreter's local browser-control status, while still marking which tabs are actually shared/controllable through the extension.

## 0.0.88

### Changes

- **Clarify the welcome-page action and widen the left column**: Made the headline smaller, gave the left side more width, and rewrote the main copy so it explicitly says the click shares the selected tab with Interpreter.

## 0.0.87

### Changes

- **Reduce the welcome-page headline size**: Lowered the hero typography in `welcome.html` so the page reads less like a poster and more like a utility screen.

## 0.0.86

### Changes

- **Switch the post-install page to a side-by-side layout**: Reduced the hero size and moved the setup steps into a separate right column so the page reads more like a compact utility screen.

## 0.0.85

### Changes

- **Align the post-install page with the actual tab-click flow**: Reworked `welcome.html` into a more useful centered setup sheet that explicitly says the extension turns on the current tab and can be clicked again to turn that tab off.

## 0.0.84

### Changes

- **Collapse the post-install page to one centered instruction**: Reduced `welcome.html` to the minimum needed action and added stricter reduction guidance to the local `interpreter-design` skill for install/help surfaces.

## 0.0.83

### Changes

- **Reduce the post-install page to the essential app flow**: Applied the local `interpreter-design` guidance by simplifying the page to one quiet column, one clear action, thin dividers, and plain language for non-technical users.

## 0.0.82

### Changes

- **Restyle the post-install page around the local Interpreter visual language**: Replaced the generic glass-card welcome screen with a more editorial, industrial "field guide" layout that matches the local extension/site branding while keeping the corrected app-first setup instructions.

## 0.0.81

### Bug Fixes

- **Rewrite the welcome page for the Interpreter app flow**: The post-install page now tells users to open the Interpreter desktop app, expose a tab through the extension, and verify the connection in `Settings > Browser`. The old Playwriter CLI, skill, MCP, and GitHub instructions are gone.
- **Stop shipping stale cursor-brand assets**: The extension build now only copies the approved Interpreter icon set into the packaged output, preventing leftover Playwriter cursor assets from leaking into release bundles.
- **Point production extension detection at the Interpreter store listing**: The extension now recognizes the live Interpreter Chrome Web Store ID instead of the old Playwriter production ID.

## 0.0.80

### Bug Fixes

- **Normalize Vite static-copy paths for Windows builds**: Convert extension asset source paths to POSIX-style globs before handing them to `vite-plugin-static-copy`. This fixes Windows package builds failing to copy `extension/icons/*`.

## 0.0.79

### Bug Fixes

- **Fix debugger crash on pages with chrome-extension:// iframes** ([#18](https://github.com/remorses/playwriter/issues/18)): Extensions like LastPass, SurfingKeys, and password managers inject `chrome-extension://` iframes into every page. Chrome's `chrome.debugger.attach` API refuses to attach to tabs containing these iframes, causing the extension to immediately disconnect after clicking the icon. Two-layer fix:
  1. Before `chrome.debugger.attach`: detect the failure, remove restricted iframes via `chrome.scripting.executeScript`, then retry attachment.
  2. After attachment: filter `Target.attachedToTarget` events for restricted child targets in `onDebuggerEvent`, preventing the relay from sending CDP commands to restricted sessions.
- **Add `scripting` permission**: Required for the iframe cleanup workaround above.

## 0.0.78

### Changes

- **Skip welcome tab in packaged automation builds**: Added a build-time flag so the extension copy bundled into the CLI does not auto-open `welcome.html` on install. Regular dev/test extension builds still keep the welcome page.

## 0.0.77

### Changes

- **Use `workspace:^` for the local relay dependency**: Switched `playwriter` from `workspace:*` to `workspace:^` in `extension/package.json` to avoid pinned workspace versions when package metadata is packed.

## 0.0.76

### Bug Fixes

- **Write Prism assets to the active extension output directory**: `scripts/download-prism.ts` now respects `PLAYWRITER_EXTENSION_DIST` instead of always writing to `dist/src`. This fixes release builds (`dist-release`) missing `prism.min.js` and `prism-bash.min.js` used by `welcome.html`.

## 0.0.75

### Changes

- **Remove `alarms` permission and keepalive**: Removed `chrome.alarms` keepalive added in 0.0.73. The `maintainLoop` while-loop and `setInterval(checkMemory)` already keep the service worker alive. The alarm was a no-op that required an unnecessary permission.

## 0.0.74

### Bug Fixes

- **Fix Target.detachFromTarget routing on root CDP session**: Commands sent without a top-level sessionId (e.g. from Playwright's root browser session) now resolve the target tab via `params.sessionId` fallback. Previously the extension threw "No tab found" which caused cascading disconnects and instability. (#40)
- **No-op stale Target.detachFromTarget**: Unknown or already-cleaned-up sessions return `{}` instead of throwing, preventing error cascading during rapid connect/disconnect cycles.
- **Always re-apply tab group color**: Tab group title and color are now re-applied on every sync to prevent Chrome from resetting them to white/unlabeled.

## 0.0.73

### Bug Fixes

- **Service worker keepalive via chrome.alarms**: Added `chrome.alarms` keepalive to prevent Chrome MV3 from terminating the service worker when idle. Without this, the `maintainLoop` stops, the WebSocket closes, and the extension silently disconnects from the relay server — causing `session new` to fail with "Extension did not connect within timeout."

## 0.0.72

### Bug Fixes

- **Use runtime-scoped root CDP tab session IDs**: Root tab sessions now use `pw-tab-<scope>-<n>` instead of `pw-tab-<n>`, where scope is a random value generated once per extension runtime. This prevents session ID collisions across multiple connected Chrome profiles.

## 0.0.71

### Bug Fixes

- **Route Runtime.enable to child CDP sessions**: Runtime enable/disable now uses the incoming `sessionId` when targeting OOPIF child sessions instead of always using the tab root session. This fixes missing `Runtime.executionContextCreated` events for child iframe targets, which could cause iframe locator operations to hang.

## 0.0.69

### Features

- **First extension keeps connection**: When multiple Interpreter Chrome Extensions are installed, the actively-used one (with tabs) now keeps the connection. New extensions are rejected with code 4002 instead of taking over.
- **Smarter reconnection**: Extension now polls `/extension/status` for `activeTargets` count and only attempts reconnection when the other extension has no active tabs.

### Bug Fixes

- **Proper state handling for 4002 rejection**: Fixed issue where extension would keep retrying forever when rejected during WebSocket handshake. Now correctly enters `extension-replaced` polling state.

## 0.0.68

### Bug Fixes

- **Improved connection reliability**: Use `127.0.0.1` instead of `localhost` to avoid DNS/IPv6 resolution issues
- **Global connection timeout**: Added 15-second global timeout wrapper around `connect()` to prevent hanging forever when individual timeouts fail
- **Better WebSocket handling**: Added `settled` flag to properly handle timeout/open/error/close race conditions

### Changes

- **Faster retry loop**: Reduced retry attempts from 30 to 5 since `maintainLoop` retries every 3 seconds anyway
- **Allow own extension pages**: Added `OUR_EXTENSION_IDS` to allow attaching to our own extension pages while blocking other extensions

## 0.0.67

- Initial changelog
