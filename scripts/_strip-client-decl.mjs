#!/usr/bin/env node
// ============================================================================
// _strip-client-decl.mjs
//
// Quita `dsh.client` del package.json de la COPIA instalada, dejando el resto
// intacto (mismo orden de claves, 2 espacios, salto final).
//
// Por que: `dsh-client-modules` construye un bundle de cliente para cada fila
// con `dsh.client` y falla con MissingClientBundleError si el artefacto no
// existe (dsh-client-modules/lib/index.js:830-841, capturado por entrada en
// processOne :870-874). Mientras el paquete del repo no tenga client.js, la
// copia no debe declarar la mitad cliente.
//
// Uso: node _strip-client-decl.mjs <ruta al package.json de la copia>
// Salida: JSON { rewritten, hasClient }  ·  exit 0 ok, 1 error.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) {
  process.stdout.write(JSON.stringify({ rewritten: false, error: 'falta la ruta del package.json' }) + '\n')
  process.exit(1)
}

try {
  const text = readFileSync(file, 'utf8')
  const pkg = JSON.parse(text)
  let rewritten = false
  if (pkg.dsh && typeof pkg.dsh === 'object' && pkg.dsh.client !== undefined) {
    delete pkg.dsh.client
    if (Object.keys(pkg.dsh).length === 0) delete pkg.dsh
    rewritten = true
  }
  if (rewritten) writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  process.stdout.write(JSON.stringify({ rewritten, hasClient: pkg.dsh?.client !== undefined }) + '\n')
  process.exit(0)
} catch (error) {
  process.stdout.write(JSON.stringify({ rewritten: false, error: String(error?.message ?? error) }) + '\n')
  process.exit(1)
}
