# Chrome Web Store listing: Bolt Browser Connector

Copy for the Store listing tab. Permission and privacy answers are in
`permissions.md`.

## Name

Bolt Browser Connector

## Summary (132 characters max; matches the manifest description)

Lets the Bolt desktop app work in Chrome tabs you choose: Bolt agents read and act on pages you connect, in a labelled tab group.

## Category

Productivity / Workflow & Planning

## Description

Bolt Browser Connector links Chrome to Bolt, the AI assistant for Mac. With it, you can ask Bolt to do things on the websites you already use, in your own Chrome, where you are already signed in.

This extension needs the Bolt desktop app. Download it at https://trybolt.ai/download.

What you can ask Bolt to do:
• Fill out a long web form from a document or spreadsheet on your Mac.
• Collect details from a site you are signed in to, such as order history or account settings, and put them in a file.
• Look something up on a website and summarize it in your Bolt chat.

How it works:
1. Install the Bolt app for Mac and keep it running.
2. Open the site you want and click the Bolt icon on that tab. The tab is now connected, and the icon shows its status.
3. Ask Bolt in the app. When a task needs a different site, Bolt opens its own tab.

You stay in control:
• Bolt only works in tabs you connect and tabs it opens for your request.
• Tabs Bolt is using are grouped under a "Bolt Agent" tab group, so you can always see them.
• Click the icon again to disconnect a tab at any time.
• The extension talks only to the Bolt app on your own computer. It has no servers of its own and collects no analytics.

Privacy policy: https://trybolt.ai/privacy

## Screenshots (1280x800, at least one; use real captures)

Capture these from a real session rather than the generated graphic in
`store-assets/screenshot-1280x800.png`:

1. A connected tab: the Bolt icon showing "connected" and the "Bolt Agent" tab group.
2. The Bolt app chat beside Chrome while Bolt fills a form in that tab.
3. The welcome page that opens after install (its steps and download link).

## Notes for the reviewer (Distribution tab, "Test instructions")

This extension has no standalone UI: it connects Chrome to the Bolt desktop app for macOS, so testing needs the app.

1. On a Mac (Apple silicon), download Bolt from https://trybolt.ai/download and open it.
2. Sign in with the test account: <REVIEWER_EMAIL> / <REVIEWER_PASSWORD>.
3. In Chrome, open https://example.com and click the Bolt Browser Connector icon. The icon turns to its connected state.
4. In the Bolt app, start a new chat and type: "In my connected Chrome tab, tell me the page's heading, then open wikipedia.org in a new tab."
5. Bolt reads the heading from the connected tab, then opens a new tab inside a "Bolt Agent" tab group.

Without the app running, the icon's tooltip reads "The Bolt app isn't running. Open Bolt (trybolt.ai/download), then click again." That is expected.
