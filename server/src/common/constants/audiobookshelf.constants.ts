// The whole ABS-compat API is mounted under this prefix (via RouterModule in app.module.ts) so
// it can coexist with BookOrbit's own web app on the same origin, the same way a reverse proxy
// would front an OPDS feed at its own subpath. ABS clients (Prologue) support this because real
// Audiobookshelf servers support the same pattern behind a reverse proxy (ROUTER_BASE_PATH) - the
// user points the client at "https://host/abs" as the server address.
export const AUDIOBOOKSHELF_BASE_PATH = '/abs';
