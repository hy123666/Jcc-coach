export function rememberBoundedDeliveryKey(
  store: Map<string, true>,
  key: string,
  maxEntries = 256,
) {
  if (store.has(key)) return true;
  store.set(key, true);
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return false;
}
