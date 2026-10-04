import { readFileSync } from "node:fs";

// Both source execution and the npm dist read the same package release identity.
export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
