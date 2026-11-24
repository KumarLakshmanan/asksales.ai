// Augment Express Request to add `user` and `id` fields.
// This file is referenced by `server/tsconfig.json`'s `include` and is also
// imported from `server/index.ts` to ensure the global declaration is
// evaluated at compile time.
import "./types/express.js";

export {};
