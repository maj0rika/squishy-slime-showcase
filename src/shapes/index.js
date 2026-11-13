import { registerShape } from './registry.js';
import { slimeShape } from './slime.js';

/**
 * Registering a shape is the only wiring a new shape needs.
 * Add the import and the registerShape() call, and the UI, input, physics and
 * camera systems pick it up without modification.
 */
registerShape(slimeShape);

export { getShape, listShapes, hasMultipleShapes } from './registry.js';
