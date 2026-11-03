# Chrome Web Store Submission Justifications

Paste each section into the matching field of the Chrome Web Store dashboard
(Privacy practices tab). Keep this file in sync with `manifest.json`: every
permission listed there must have a section here, and nothing else.

## Single Purpose Description

Bolt Browser Connector connects the Bolt desktop app (an AI assistant for Mac) to the Chrome tabs the user chooses, so Bolt's agents can read and act on those pages, for example filling a form or collecting information from a site the user is signed in to. It has no features of its own outside that connection.

## Permission Justifications

### debugger

Core to the extension's single purpose. When the user connects a tab, the extension attaches the Chrome DevTools Protocol to that tab and relays commands from the Bolt desktop app running on the same computer: reading the page, navigating, clicking, and typing. It attaches only to tabs the user connected and tabs Bolt opened for the user's task, and detaches when the user disconnects the tab.

### scripting

Used to run small page scripts in connected tabs, for example to read the visible text and structure of a page or highlight the element Bolt is about to act on. Scripts run only in tabs connected to Bolt.

### contextMenus

Adds a single "Copy Bolt Element Reference" item to the right-click menu. It is shown only on a tab connected to Bolt, and lets the user point Bolt at a specific element on the page.

### tabs

Used to show the user and Bolt which tab is connected: reading a connected tab's title and URL, opening a new tab when Bolt's task needs a website, and reacting when a connected tab is closed or changes page.

### tabGroups

Places the tabs Bolt is working in into a labelled "Bolt Agent" tab group, so the user can always see which tabs Bolt is using. The group collapses while the user is on another tab and is removed when Bolt finishes.

### host_permissions (<all_urls>)

The user decides which site to connect, and that can be any website: their email, a CRM, a government form. Bolt can't know the site in advance, so the extension needs access to any URL, but it only acts in tabs the user connected or tabs Bolt opened for the user's request.

## Remote code

No. All extension code is bundled in the package. The extension does not load or run code from any server.

## Data usage

- The extension sends page content only to the Bolt desktop app on the user's own computer, over a local connection (`127.0.0.1`). It does not send data to any remote server, and it collects no analytics.
- The Bolt desktop app may send that content to the AI model it uses to carry out the user's request, as described in Bolt's privacy policy (https://trybolt.ai/privacy).
- It does not sell or transfer user data to third parties, does not use it for purposes unrelated to the single purpose above, and does not use it to determine creditworthiness or for lending.
- Data types to declare: "Website content" (pages in connected tabs, shared only with the local Bolt app).
