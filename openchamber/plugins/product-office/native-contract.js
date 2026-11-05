/** Native OpenCode 2.0.27 client responses carry a data envelope. */
export function unwrapData(response) {
  return response && typeof response === "object" && Object.hasOwn(response, "data") ? response.data : response;
}

/** Plugin storage differs from session API: entries are key/value objects. */
export function storageEntries(page) {
  if (!Array.isArray(page?.entries)) throw new Error("Invalid plugin storage page");
  return page.entries.map(entry => {
    if (!entry || typeof entry.key !== "string" || !Object.hasOwn(entry, "value")) throw new Error("Invalid plugin storage entry");
    return [entry.key, entry.value];
  });
}
