export function moveItem(ids, id, targetId = null, after = false) {
  if (id === targetId) {
    return [...ids];
  }

  const order = [...new Set(ids)].filter(item => item !== id);
  const index = targetId === null ? order.length : order.indexOf(targetId);
  if (index < 0) {
    return null;
  }

  order.splice(index + (after && targetId !== null ? 1 : 0), 0, id);
  return order;
}
