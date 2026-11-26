export function planShowsPack(plan: unknown, productPackKeys: ReadonlySet<string>): boolean {
  if (plan === undefined || plan === null) return true;
  if (typeof plan !== "object" || Array.isArray(plan)) return false;
  const products = (plan as { products?: unknown }).products;
  if (!Array.isArray(products)) return false;
  return products.some((product) => {
    if (typeof product !== "object" || product === null || Array.isArray(product)) return false;
    const { photoKey } = product as { photoKey?: unknown };
    return typeof photoKey !== "string" || productPackKeys.has(photoKey);
  });
}
