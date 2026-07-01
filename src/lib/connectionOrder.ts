/**
 * Ensure a dragged item belongs to the group identified by its drop target.
 *
 * dnd-kit's projected result can retain the source group when the target is a
 * folder header, because folder headers themselves live in a separate sortable
 * group. The target's folder metadata is authoritative in that case.
 */
export function reconcileItemGroup(
  groups: Record<string, string[]>,
  itemId: string,
  destinationGroup: string,
  destinationIndex: number,
): Record<string, string[]> {
  const next = Object.fromEntries(
    Object.entries(groups).map(([group, items]) => [group, [...items]]),
  );
  if (!next[destinationGroup]) return next;

  const currentGroup = Object.keys(next).find((group) => next[group].includes(itemId));
  if (currentGroup === destinationGroup) return next;

  for (const items of Object.values(next)) {
    const index = items.indexOf(itemId);
    if (index >= 0) items.splice(index, 1);
  }

  const destination = next[destinationGroup];
  const index = Math.max(0, Math.min(destinationIndex, destination.length));
  destination.splice(index, 0, itemId);
  return next;
}

/** Resolve a destination while ignoring dnd-kit's internal `folder-order` group. */
export function resolveConnectionDropFolder(
  folders: string[],
  hoveredFolder: string | null,
  projectedGroup: string | null,
  targetFolder: string | null,
): string | null {
  const projectedFolder = projectedGroup?.startsWith("folder:")
    ? projectedGroup.slice("folder:".length)
    : null;
  return [hoveredFolder, projectedFolder, targetFolder]
    .find((folder): folder is string => !!folder && folders.includes(folder)) ?? null;
}
