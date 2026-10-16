// Bumped whenever something outside the app (the MCP server) writes to the
// library, so an open thread page re-reads its notes from disk.
export const notesSync = $state({ revision: 0 });
