import { createRequire } from "node:module"
import { chromium, errors } from "patchright-core"
import { tunePatchright } from "../vendor/browse/execute/patchright-tuning.ts"

const require = createRequire(import.meta.url)
const internals = require("patchright-core/lib/coreBundle") as Parameters<typeof tunePatchright>[0]
tunePatchright(internals)

export { chromium, errors }
export type { Browser, BrowserContext, Dialog, Frame, Locator, Page } from "patchright-core"
