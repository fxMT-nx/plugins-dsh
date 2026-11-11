/**
 * Typert direct-method markers for a hand-written Host Service.
 *
 * The published packages carry this metadata through the `@Remote()` decorator,
 * which cannot be used from a plain-JavaScript package: Node parses no decorator
 * syntax, and the compiled helper installs the marker from a class initializer.
 * The marker itself is plain data on the owning class prototype, so a package
 * without a build step writes the same record directly.
 *
 * Evidence for the shape: `recon/asar/dsh/node_modules/@deepseek-ai/dsh-typert-protocol/lib/index.js`
 * — `REMOTE_METHOD_DESCRIPTOR` (:315), `mark()` (:449-470), `remoteMethods()` (:424-428),
 * `readRemoteMethodDescriptor()` (:429-439). The Gateway reads this record in
 * `recon/asar/dsh/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`
 * — `resolveSrcDescriptor()` (:1230-1248).
 */

/** Prototype key the Typert Gateway reads Remote markers from. */
export const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods'

/**
 * Build one frozen direct-invocation marker.
 * @param method - public instance method name exposed on the wire.
 * @returns the marker record `mark()` would have produced.
 */
function directMarker(method) {
  return Object.freeze({
    method,
    invocation: Object.freeze({ kind: 'direct' }),
  })
}

/**
 * Declare which instance methods of a Service are callable over the Remote wire.
 *
 * Must be called with the class (not an instance) before the Gateway collects
 * source claims. Idempotent: re-declaring the same list keeps one record, so a
 * restarted fiber does not duplicate it.
 *
 * @param serviceClass - the class whose prototype owns the methods.
 * @param methods - method names; each must be a public instance method.
 * @returns nothing.
 */
export function declareRemoteMethods(serviceClass, methods) {
  const prototype = serviceClass.prototype
  const existing = Object.getOwnPropertyDescriptor(prototype, REMOTE_METHOD_DESCRIPTOR)
  if (existing !== undefined && existing.value?.version === 1) {
    const known = new Set(existing.value.methods.map((marker) => marker.method))
    if (methods.every((method) => known.has(method))) return
  }
  Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
    configurable: true,
    value: Object.freeze({
      version: 1,
      methods: Object.freeze(methods.map(directMarker)),
    }),
  })
}
