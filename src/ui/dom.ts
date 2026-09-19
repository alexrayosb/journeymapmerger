/** Tiny DOM builder. Text goes through textContent, never innerHTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string; testId?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { testId, ...rest } = props;
  Object.assign(node, rest);
  if (testId !== undefined) node.dataset['testid'] = testId;
  node.append(...children);
  return node;
}
