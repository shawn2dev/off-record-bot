const fields = { userId: 'displayName', actorId: 'actorDisplayName' };

export function memberIds(value) {
  const ids = new Set();
  const visit = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const [key, child] of Object.entries(item)) {
      if (Object.hasOwn(fields, key) && typeof child === 'string')
        ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...ids];
}

export function withMemberNames(value, names) {
  if (Array.isArray(value))
    return value.map((item) => withMemberNames(item, names));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      withMemberNames(child, names),
    ]),
  );
  for (const [idField, nameField] of Object.entries(fields)) {
    if (typeof value[idField] === 'string')
      result[nameField] = names[value[idField]] ?? null;
  }
  return result;
}
