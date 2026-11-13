// Patchright, with browse's tuning applied once per process.
import { createRequire } from "node:module"
import { chromium, errors } from "patchright-core"
import { tunePatchright } from "../vendor/browse/execute/patchright-tuning.ts"

// Patchright's internal bundle has no type declarations; tunePatchright only reaches server.Page.
const require = createRequire(import.meta.url)
const internals = require("patchright-core/lib/coreBundle") as Parameters<typeof tunePatchright>[0]
tunePatchright(internals)

export { chromium, errors }
export type { Browser, BrowserContext, Frame, Locator, Page } from "patchright-core"
