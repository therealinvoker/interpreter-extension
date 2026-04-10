---
name: interpreter-browser
description: Control the user's existing Chrome through the Interpreter Chrome Extension and the `playwriter` browser-control CLI. Use this for JS-heavy sites, login walls, and other tasks that need the real browser instead of fetch/curl. Run `playwriter skill` to read the complete up-to-date instructions.
---

## REQUIRED: Read Full Documentation First

**Before using browser control, you MUST run this command:**

```bash
playwriter skill # IMPORTANT! do not use | head here. read in full!
```

This outputs the complete documentation including:

- Session management and timeout configuration
- Selector strategies (and which ones to AVOID)
- Rules to prevent timeouts and failures
- Best practices for slow pages and SPAs
- What to do when the user has not installed the Interpreter Chrome Extension yet
- Context variables, utility functions, and more

**Do NOT skip this step.** The quick examples below will fail without understanding timeouts, selector rules, and common pitfalls from the full docs.

**Read the ENTIRE output.** Do NOT pipe through `head`, `tail`, or any truncation command. The skill output must be read in its entirety — critical rules about timeouts, selectors, and common pitfalls are spread throughout the document, not just at the top.

## Minimal Example (after reading the full docs)

```bash
playwriter session new
playwriter -s 1 -e 'await page.goto("https://example.com")'
```

**Always use single quotes** for the `-e` argument. Single quotes prevent bash from interpreting `$`, backticks, and backslashes inside your JS code. Use double quotes or backtick template literals for strings inside the JS.

If the `playwriter` command is not available, use `npx playwriter@latest` or `bunx playwriter@latest`.
