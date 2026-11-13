const registry = new Map();

export function registerShape(definition) {
  if (!definition || !definition.id) {
    throw new Error('A shape definition needs an id.');
  }
  if (registry.has(definition.id)) {
    throw new Error(`Shape already registered: ${definition.id}`);
  }
  registry.set(definition.id, definition);
  return definition;
}

export function getShape(id) {
  const shape = registry.get(id);
  if (!shape) throw new Error(`Unknown shape: ${id}`);
  return shape;
}

export function listShapes() {
  return [...registry.values()];
}

export function hasMultipleShapes() {
  return registry.size > 1;
}
