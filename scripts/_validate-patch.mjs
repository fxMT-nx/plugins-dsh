#!/usr/bin/env node
// ============================================================================
// _validate-patch.mjs
//
// Valida un patch del Loader usando el compositor REAL de esta instalacion de
// DSH (el mismo modulo que compone el perfil al arrancar y el que usa HMR para
// recomponer en caliente):
//
//   recon/asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js
//   -> loadOptionalPatches(binName, ruta)  parsea el YAML (js-yaml, admite !!js)
//   -> composeEntries([capas...])          aplica insert/override como en boot
//
// No escribe nada: lee ficheros y escribe JSON en stdout.
//
// Uso:
//   node _validate-patch.mjs --mode check|install|uninstall \
//        --app-boot <ruta a dsh-app-boot/lib/index.js> \
//        --candidate <yml candidato> [--baseline <yml de referencia>] \
//        [--home <yml de la capa home>] [--row-id mcp-console]
//
// Codigo de salida: 0 = ok, 1 = fallo de validacion, 2 = error de uso.
// ============================================================================

import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const out = { mode: 'check', rowId: 'mcp-console' }
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    switch (key) {
      case '--mode': out.mode = value; i++; break
      case '--app-boot': out.appBoot = value; i++; break
      case '--candidate': out.candidate = value; i++; break
      case '--baseline': out.baseline = value; i++; break
      case '--home': out.home = value; i++; break
      case '--row-id': out.rowId = value; i++; break
      default: break
    }
  }
  return out
}

const args = parseArgs(process.argv)
const result = {
  ok: false,
  mode: args.mode,
  rowId: args.rowId,
  candidate: args.candidate ?? null,
  baseline: args.baseline ?? null,
  home: args.home ?? null,
  beforeRows: 0,
  afterRows: 0,
  delta: 0,
  rowCountBefore: 0,
  rowCountAfter: 0,
  addedRow: null,
  removedRow: null,
  errors: [],
  warnings: [],
  noise: [],
}

function finish(code) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  process.exit(code)
}

if (!args.candidate) {
  result.errors.push('falta --candidate')
  finish(2)
}
if (!args.appBoot || !existsSync(args.appBoot)) {
  result.errors.push('no existe el compositor: ' + String(args.appBoot))
  finish(2)
}
if (!existsSync(args.candidate)) {
  result.errors.push('no existe el candidato: ' + args.candidate)
  finish(2)
}

let mod
try {
  mod = await import(pathToFileURL(args.appBoot).href)
} catch (error) {
  result.errors.push('no se pudo importar el compositor: ' + (error?.message ?? String(error)))
  finish(1)
}
const { loadOptionalPatches, composeEntries } = mod
if (typeof loadOptionalPatches !== 'function' || typeof composeEntries !== 'function') {
  result.errors.push('el compositor no exporta loadOptionalPatches/composeEntries')
  finish(1)
}

function load(label, file) {
  try {
    return loadOptionalPatches('dsh', file) ?? []
  } catch (error) {
    result.errors.push(label + ': ' + String(error?.message ?? error).split('\n')[0])
    return undefined
  }
}

const candidateOps = load('candidato', args.candidate)
if (candidateOps === undefined) finish(1)

let baselineOps = undefined
if (args.baseline && existsSync(args.baseline)) {
  baselineOps = load('referencia', args.baseline)
  if (baselineOps === undefined) finish(1)
}

let homeOps = []
if (args.home && existsSync(args.home)) {
  const loaded = load('capa home', args.home)
  if (loaded === undefined) finish(1)
  homeOps = loaded
  result.homeRows = homeOps.length
}

/** Serializacion estable y total: nunca lanza con valores raros de !!js. */
function stable(value, depth = 0) {
  if (depth > 12) return '"[deep]"'
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return JSON.stringify(value)
  if (t === 'function') return JSON.stringify('[fn]')
  if (Array.isArray(value)) return '[' + value.map((v) => stable(v, depth + 1)).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k], depth + 1)).join(',') + '}'
  }
  return JSON.stringify(String(value))
}

const rowKey = (row) => stable(row)
const rowIds = (rows) => rows.map((r) => String(r?.id ?? r?.name ?? '?'))

function compose(ops) {
  try {
    // El compositor tolera capas vacias; el mismo orden que usa el arranque:
    // patch del perfil y despues capa home (recon/mcp-runtime.md seccion 5).
    const layers = []
    if (ops !== undefined) layers.push(ops)
    if (homeOps.length > 0) layers.push(homeOps)
    return composeEntries(layers, (message) => {
      // "patch: entry X not found" es ruido esperado: componemos sin las capas
      // de bundle, asi que los overrides del perfil no encuentran su fila.
      if (/^patch: entry .* not found$/.test(String(message))) { result.noise.push(String(message)); return }
      result.warnings.push('compositor: ' + message)
    })
  } catch (error) {
    result.errors.push('composeEntries: ' + String(error?.message ?? error).split('\n')[0])
    return undefined
  }
}

const after = compose(candidateOps)
if (after === undefined) finish(1)
const before = baselineOps === undefined ? undefined : compose(baselineOps)
if (baselineOps !== undefined && before === undefined) finish(1)

const ours = (rows) => rows.filter((r) => String(r?.id) === args.rowId)

result.afterRows = after.length
result.rowCountAfter = ours(after).length
if (before !== undefined) {
  result.beforeRows = before.length
  result.rowCountBefore = ours(before).length
}

// --- comprobaciones comunes ------------------------------------------------
if (result.rowCountAfter > 1) {
  result.errors.push('la fila "' + args.rowId + '" aparece ' + result.rowCountAfter + ' veces en la composicion')
}

if (args.mode === 'check') {
  if (result.rowCountAfter === 0) result.warnings.push('la fila "' + args.rowId + '" no esta en el patch del perfil')
  const names = ours(after).map((r) => String(r?.name ?? ''))
  if (names.length > 0) result.addedRow = { id: args.rowId, name: names[0] }
  result.ok = result.errors.length === 0
  finish(result.ok ? 0 : 1)
}

// --- comparacion contra la referencia --------------------------------------
if (before !== undefined) {
  const idsBefore = rowIds(before)
  const idsAfter = rowIds(after)

  if (args.mode === 'install') {
    // El candidato debe anadir EXACTAMENTE una fila nuestra. El orden compuesto
    // no es "al final": el patch del perfil se compone antes que la capa home,
    // asi que nuestra fila sale la primera. Lo que se exige es que al quitarla
    // quede exactamente la composicion de referencia, en el mismo orden.
    const addedIdx = after.findIndex(
      (row) => String(row?.id) === args.rowId && !before.some((b) => rowKey(b) === rowKey(row)),
    )
    const added = addedIdx < 0 ? [] : [after[addedIdx]]
    if (added.length !== 1) {
      result.errors.push('se esperaba exactamente 1 fila nueva "' + args.rowId + '"; hay ' + added.length)
    } else {
      result.addedRow = { id: added[0]?.id ?? null, name: added[0]?.name ?? null }
      const restAfter = after.filter((_, i) => i !== addedIdx)
      if (JSON.stringify(restAfter.map(rowKey)) !== JSON.stringify(before.map(rowKey))) {
        const beforeKeys = before.map(rowKey)
        const afterKeys = restAfter.map(rowKey)
        const at = beforeKeys.findIndex((v, i) => v !== afterKeys[i])
        result.errors.push('la composicion cambia ademas de nuestra fila: primera diferencia en la posicion ' +
          (at + 1) + ' (' + String(idsBefore[at] ?? '?') + '); filas antes=' + before.length +
          ' despues=' + restAfter.length)
      }
    }
    result.delta = result.afterRows - result.beforeRows
  } else {
    // uninstall: el resultado debe quedar igual que la referencia.
    result.delta = result.afterRows - result.beforeRows
    if (result.rowCountAfter !== 0) {
      result.errors.push('la fila "' + args.rowId + '" sigue presente tras la desinstalacion')
    }
    if (JSON.stringify(idsAfter) !== JSON.stringify(idsBefore)) {
      const at = idsAfter.findIndex((v, i) => v !== idsBefore[i])
      result.errors.push('quedan diferencias frente a la referencia en la posicion ' + (at + 1) +
        ': ' + JSON.stringify(idsBefore.slice(0, 5)) + ' -> ' + JSON.stringify(idsAfter.slice(0, 5)))
    } else {
      const beforeRows = before.map(rowKey)
      const afterRows = after.map(rowKey)
      const at = beforeRows.findIndex((v, i) => v !== afterRows[i])
      if (at >= 0) {
        result.warnings.push('mismas filas pero contenido distinto en la posicion ' + (at + 1) +
          ' (' + String(idsBefore[at] ?? '?') + ')')
      }
    }
  }
} else {
  result.warnings.push('sin referencia: solo se comprueba que el YAML parsea y el recuento de filas')
}

result.ok = result.errors.length === 0
finish(result.ok ? 0 : 1)
