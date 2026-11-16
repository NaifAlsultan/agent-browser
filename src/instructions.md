agent-browser is a web browser for visiting sites, searching, reading pages and filling forms: a real Google Chrome in the background with a fresh profile for this session (no logins, cookies or history of the user's), deleted when you call `close`, after 5 minutes without a call, or when the MCP client disconnects.

Tabs are the handle. `navigate` with a `url` and no `tab` opens a new tab and returns its id as `tab`; pass that `tab` to every other call (snapshot, click, fill, screenshot, ...). `navigate` with `tab` goes to a URL in that tab. Popups a page opens show up as `newTabs` in a result and are tabs too. `tabs` lists, opens and closes tabs.

Use one loop: inspect, act, verify.
- Inspect with `snapshot` before choosing anything. It returns an outline of the page with refs like `e12` (iframes included); pass a ref (with the same `tab`) to `click`, `fill`, `type`, `select`, `hover` or `drag`. Refs go stale after the page changes: snapshot again.
- Act with the narrowest stable control. Use `navigate` for URLs, `press` for keys, `scroll`, `wait_for` for text, a selector or a URL, and `eval` only when no other tool fits.
- Verify with a fresh read (`snapshot`, `screenshot`, or `eval`). A click that returned is not proof the task succeeded.

In code mode, compose these tools in one script: navigate, call `snapshot`, pick refs from its text, act, then snapshot again to check, all in one run instead of one tool call per turn. Return only what you need: whole snapshots are large.

Tips:
- `type` sends keys one at a time, like a person; `fill` sets a field's value at once, which is quicker and easier for sites to spot. Clicks, typing and scrolling are paced like a person's, so they take a moment.
- Pages restored from the back/forward cache fire no load event: go back and forward with `navigate` action `back` or `forward` and `waitUntil: "commit"`.
- `eval` runs in an isolated world the page can't see. `world: "main"` reaches the page's own variables, and the page can notice it.

Bot checks: a check that clears itself (Cloudflare's "Just a moment...") is waited out automatically. When a result reports a `challenge` that is still blocking, don't retry, reload or try to solve the CAPTCHA: use another source or tell the user.

Password, one-time-code and payment-card values are hidden in snapshots. Don't enter the user's real passwords or card details unless they explicitly ask you to.

When you're done browsing, call `close`. An open browser takes hundreds of MB to a few GB of the user's memory until then, or until it has been idle for 5 minutes. Close it as soon as you've got what you need, before writing your answer, unless you expect to browse again shortly (for example, the user is likely to ask a follow-up about the same pages). Close tabs you no longer need with `tabs` action `close`.
