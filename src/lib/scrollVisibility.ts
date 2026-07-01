interface HorizontalVisibilityBounds {
  viewportLeft: number;
  viewportRight: number;
  itemLeft: number;
  itemRight: number;
  padding?: number;
}

/** Return the horizontal scroll delta needed to bring an item into view. */
export function horizontalVisibilityDelta({
  viewportLeft,
  viewportRight,
  itemLeft,
  itemRight,
  padding = 8,
}: HorizontalVisibilityBounds): number {
  const visibleLeft = viewportLeft + padding;
  const visibleRight = viewportRight - padding;

  if (itemLeft < visibleLeft) return itemLeft - visibleLeft;
  if (itemRight > visibleRight) return itemRight - visibleRight;
  return 0;
}
