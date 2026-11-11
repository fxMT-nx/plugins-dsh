<#
.SYNOPSIS
    Instala el plugin @local/dsh-mcp-console en el perfil `desktop` de DSH.

.DESCRIPTION
    Instalacion manual y reproducible. La herramienta oficial (plugin_manager)
    esta desactivada en este perfil (tool-plugin-manager: disabled: true), asi
    que se reproducen a mano los dos efectos de `installBundle` que hacen falta:

      1. el paquete se COPIA a
         ~/.dsh/profiles/desktop/node_modules/@local/dsh-mcp-console
         (ficheros reales, espejo del repo con robocopy /MIR; la copia es la
         que se ejecuta, el repo no);
      2. el patch del perfil gana UNA fila que monta ese paquete:
             - insert:
                 - id: mcp-console
                   name: '@local/dsh-mcp-console'

    Por que copia y no junction: el Host decide la capa de resolucion de un
    modulo por su ruta. Solo lo que cae bajo ~/.dsh/profiles/ es capa `profile`
    y tiene sus dependencias resueltas contra la instalacion
    (dsh-app-boot/lib/index.js:1337-1345, :1625-1675). La tabla de rutas
    "linked" se calcula al construir la resolucion (:664-692), no al importar.

    Nada mas se toca: el resto del patch se conserva byte a byte (se comprueba),
    y la capa home (~/.dsh/cordis.patch.yml) solo se LEE.

    Antes de escribir hay backup con fecha y validacion con el compositor real
    de DSH, y despues se relee el fichero del disco para confirmar el hash.

    IDEMPOTENTE y RE-EJECUTABLE: volver a lanzarlo tras cambiar el codigo del
    paquete vuelve a espejar la copia y deja el resto igual. Con -Update solo
    sincroniza la copia y no toca el patch (bucle de desarrollo).

.PARAMETER ProfileName
    Perfil de DSH. Por defecto `desktop` (decision del jefe).

.PARAMETER ProjectRoot
    Raiz del proyecto (donde estan plugins/ y recon/). Por defecto, el padre de
    este script.

.PARAMETER PackagePath
    Directorio del paquete. Por defecto <ProjectRoot>\plugins\dsh-mcp-console.

.PARAMETER DryRun
    Ensenya exactamente lo que haria (y el diff), sin escribir nada.
    `-WhatIf` hace lo mismo.

.PARAMETER Force
    Reemplaza lo que haya en el destino si no es una copia nuestra (p.ej. un
    enlace de una version anterior). Sin -Force, eso es un error (15).

.PARAMETER Update
    Solo sincroniza la copia instalada con el repo (no toca el patch ni pide
    backup). Para el ciclo "edito el plugin -> quiero verlo en la GUI".

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-mcp-console.ps1 -DryRun

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-mcp-console.ps1

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-mcp-console.ps1 -Update

.NOTES
    Codigos de salida:
      0  instalado (o ya estaba instalado y consistente)
      10 precondiciones del entorno (perfil, patch, node)
      11 paquete invalido (package.json, node --check, exports)
      12 fallo al crear el backup
      13 el YAML candidato no valida (no se ha escrito nada)
      14 fallo al escribir o al releer el patch (se intenta restaurar)
      15 problema con la copia del paquete en node_modules
      16 estado inconsistente (fila duplicada, o fila tambien en la capa home)
      17 verificacion posterior fallida (se restaura el backup)
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$ProfileName = 'desktop',
    [string]$ProjectRoot = '',
    [string]$PackagePath = '',
    [string]$ProfileDir = '',
    [switch]$DryRun,
    [switch]$Force,
    [switch]$Update
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

. (Join-Path $PSScriptRoot '_mcp-console-common.ps1')

$ctx = Get-McpConsoleContext -ProfileName $ProfileName -ProjectRoot $ProjectRoot -PackagePath $PackagePath -ProfileDirOverride $ProfileDir
$dry = Test-DryRun -DryRun:$DryRun

Write-Host ''
Write-Host '============================================================'
Write-Host ' install-mcp-console.ps1'
Write-Host (' perfil   : ' + $ctx.ProfileName + '  (' + $ctx.ProfileDir + ')')
Write-Host (' paquete  : ' + $ctx.PackagePath)
Write-Host (' modo     : ' + $(if ($dry) { 'DRY-RUN (no se escribe nada)' } else { 'REAL' }))
Write-Host '============================================================'

# ---------------------------------------------------------------------------
# 1. Precondiciones
# ---------------------------------------------------------------------------
Write-Section '1. Precondiciones'

if (-not (Test-Path -LiteralPath $ctx.ProfileDir)) {
    Fail-With 10 ('No existe el perfil: ' + $ctx.ProfileDir)
}
Write-Ok ('perfil encontrado: ' + $ctx.ProfileName)

if (-not (Test-Path -LiteralPath $ctx.PatchPath)) {
    Fail-With 10 ('No existe el patch del perfil: ' + $ctx.PatchPath)
}
$originalText = Read-Utf8Text $ctx.PatchPath
$originalHash = Get-Sha256 $ctx.PatchPath
$originalLines = Get-LineCount $originalText
Write-Ok ('patch del perfil: ' + $originalLines + ' lineas, ' + (Get-Item $ctx.PatchPath).Length + ' bytes, sha256=' + $originalHash.Substring(0, 16) + '...')

if ([string]::IsNullOrWhiteSpace($ctx.NodeExe) -or -not (Test-Path -LiteralPath $ctx.NodeExe)) {
    Fail-With 10 'No encuentro node (ni en el runtime de DSH ni en PATH). Necesario para node --check.'
}
Write-Ok ('node: ' + $ctx.NodeExe)

if (-not (Test-Path -LiteralPath $ctx.PackagePath)) {
    Fail-With 11 ('No existe el paquete: ' + $ctx.PackagePath)
}
$pkgJsonPath = Join-Path $ctx.PackagePath 'package.json'
if (-not (Test-Path -LiteralPath $pkgJsonPath)) {
    Fail-With 11 ('No existe ' + $pkgJsonPath)
}
try { $pkg = (Read-Utf8Text $pkgJsonPath) | ConvertFrom-Json }
catch { Fail-With 11 ('package.json no parsea: ' + $_.Exception.Message) }

if ($pkg.name -ne $ctx.PackageName) {
    Fail-With 11 ('package.json.name es "' + $pkg.name + '", se esperaba "' + $ctx.PackageName + '"')
}
Write-Ok ('package.json: name=' + $pkg.name + ' version=' + $pkg.version)

if ($null -eq $pkg.dsh -or $null -eq $pkg.dsh.client) {
    Fail-With 11 'package.json no declara dsh.client (la mitad cliente no se servira)'
}
if ($pkg.dsh.client.platform -ne 'web') {
    Fail-With 11 ('dsh.client.platform es "' + $pkg.dsh.client.platform + '", debe ser "web"')
}
$clientExport = $null
if ($pkg.exports) { $clientExport = $pkg.exports.'./client' }
if (-not $clientExport) {
    Fail-With 11 'package.json no declara exports["./client"]'
}
Write-Ok ('dsh.client.platform=web, exports["./client"]=' + $clientExport)

$hasClientBundle = Test-Path -LiteralPath (Join-Path $ctx.PackagePath 'client.js')
if ($hasClientBundle) {
    foreach ($required in @('index.js', 'client.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ctx.PackagePath $required))) { Fail-With 11 ('falta ' + $required + ' en el paquete') }
    }
} else {
    # Sin client.js la copia instalada NO debe declarar dsh.client: dsh-client-modules
    # lanza MissingClientBundleError si la fila lo declara y el artefacto no existe
    # (dsh-client-modules/lib/index.js:830-841, reportado por entrada en :870-874).
    if (-not (Test-Path -LiteralPath (Join-Path $ctx.PackagePath 'index.js'))) { Fail-With 11 'falta index.js en el paquete' }
    Write-Warn 'el repo no tiene client.js: la copia se instalara SIN dsh.client (solo mitad Host, sin UI)'
}
foreach ($optional in @('cordis.patch.yml', 'locale\en.json', 'locale\es.json', 'icon.svg')) {
    if (-not (Test-Path -LiteralPath (Join-Path $ctx.PackagePath $optional))) {
        Write-Warn ('falta ' + $optional + ' (no impide la instalacion, pero el Plugin Manager lo echara en falta)')
    }
}

$syntaxTargets = @('index.js')
if ($hasClientBundle) { $syntaxTargets += 'client.js' }
foreach ($js in $syntaxTargets) {
    $file = Join-Path $ctx.PackagePath $js
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $proc = Start-Process -FilePath ('"' + $ctx.NodeExe + '"') -ArgumentList ('"--check" "' + $file + '"') `
            -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile -RedirectStandardOutput ([System.IO.Path]::GetTempFileName())
        if ($proc.ExitCode -ne 0) {
            $msg = Read-Utf8Text $errFile
            Fail-With 11 ('node --check ' + $js + ' falla: ' + $msg.Trim())
        }
    } finally {
        Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    }
    Write-Ok ('node --check ' + $js + ': sintaxis valida')
}

# La capa home no se toca NUNCA; solo se comprueba que no tenga ya nuestra fila.
$homeOcc = $null
if (Test-Path -LiteralPath $ctx.HomePatchPath) {
    $homeText = Read-Utf8Text $ctx.HomePatchPath
    $homeOcc = Get-RowOccurrences -Text $homeText
    if ($homeOcc.IdCount -gt 0) {
        Fail-With 16 ('La capa home ya contiene la fila "' + $ctx.RowId + '" (' + $ctx.HomePatchPath + '). No se toca esa capa: revisar a mano.')
    }
    Write-Ok ('capa home sin nuestra fila (no se escribe en ella): ' + (Get-LineCount $homeText) + ' lineas')
} else {
    Write-Warn ('no existe la capa home (' + $ctx.HomePatchPath + '); se omite su comprobacion')
}

# ---------------------------------------------------------------------------
# 2. Estado actual de la fila y de la copia instalada
# ---------------------------------------------------------------------------
Write-Section '2. Estado actual'

$occ = Get-RowOccurrences -Text $originalText
$rowPresent = ($occ.IdCount -gt 0)
if ($occ.IdCount -gt 1) {
    Fail-With 16 ('La fila "' + $ctx.RowId + '" aparece ' + $occ.IdCount + ' veces en el patch (lineas ' + ($occ.IdLines -join ', ') + '). Arreglar a mano antes de instalar.')
}
if ($rowPresent) {
    $nameFound = Get-NameAfterRowId -Text $originalText
    if ($nameFound -and $nameFound -ne $ctx.PackageName) {
        Fail-With 16 ('La fila "' + $ctx.RowId + '" ya existe pero apunta a "' + $nameFound + '", no a "' + $ctx.PackageName + '"')
    }
    Write-Warn ('la fila ya esta en el patch (linea ' + ($occ.IdLines -join ', ') + '): no se reescribira (idempotente)')
} else {
    Write-Info 'la fila no esta en el patch: se anadira al final'
}

$destInfo = Get-LinkInfo -LinkPath $ctx.LinkPath
$copyAction = 'create'
if ($destInfo.Exists) {
    if ($destInfo.IsLink -or $destInfo.Unreadable) {
        $copyAction = 'migrate'
        Write-Warn ('el destino es un ENLACE (version anterior de estos scripts): se sustituye por copia real')
        if (-not $Force) { Fail-With 15 ('Hay un enlace en ' + $ctx.LinkPath + '. Repetir con -Force para sustituirlo por una copia real.') }
    } elseif (-not $destInfo.IsDirectory) {
        Fail-With 15 ('Hay un fichero (no un directorio) en ' + $ctx.LinkPath)
    } else {
        $copyAction = 'sync'
        $destManifest = Get-TreeManifest -Path $ctx.LinkPath -Exclude @('package.json')
        $srcManifest = Get-TreeManifest -Path $ctx.PackagePath -Exclude @('package.json')
        $cmp = Compare-TreeManifest -Left $srcManifest -Right $destManifest
        if ($cmp.Equal) {
            Write-Ok ('copia ya sincronizada con el repo (' + $srcManifest.Count + ' ficheros, mismos hashes)')
        } else {
            Write-Warn ('copia desincronizada: ' + $cmp.Different.Count + ' distinto(s), ' + $cmp.OnlyRight.Count + ' sobrante(s), ' + $cmp.OnlyLeft.Count + ' que falta(n); se resincroniza')
        }
    }
} else {
    Write-Info ('no hay copia todavia: se copiara a ' + $ctx.LinkPath)
}

# ---------------------------------------------------------------------------
# 3. Plan / dry-run
# ---------------------------------------------------------------------------
Write-Section '3. Plan'

if ($copyAction -eq 'create') { Write-Info ('copiar paquete: ' + $ctx.PackagePath + ' -> ' + $ctx.LinkPath) }
elseif ($copyAction -eq 'sync') { Write-Info ('espejar paquete (robocopy /MIR): ' + $ctx.PackagePath + ' -> ' + $ctx.LinkPath) }
else { Write-Info ('sustituir enlace por copia real en ' + $ctx.LinkPath) }

if ($rowPresent) {
    Write-Info 'patch: sin cambios (la fila ya estaba)'
} elseif ($Update) {
    Write-Info 'patch: -Update, no se toca'
} else {
    Write-Info ('patch: anadir 1 fila al final; backup previo con sufijo -bak-mcpconsole-<fecha>')
}

if (-not $rowPresent) {
    $append = Get-AppendText
    $append = $append -replace "`r`n", "`n"
    $candidateText = $originalText + $append
    Write-Host ''
    Write-Host '  --- diff exacto (patch del perfil) ---'
    Write-Host ('    ' + $originalLines + ' lineas sin tocar, ' + (Get-LineCount $append) + ' lineas anadidas al final:')
    foreach ($line in ($append -split "`n")) {
        if ($line -ne '') { Write-Host ('    + ' + $line) -ForegroundColor Green }
        else { Write-Host '    +' -ForegroundColor Green }
    }
    # Prueba de que el resto no cambia: el candidato empieza por el original entero.
    $prefixOk = $candidateText.StartsWith($originalText, [System.StringComparison]::Ordinal)
    if (-not $prefixOk) { Fail-With 13 'El texto candidato no conserva el original como prefijo; abortado sin escribir.' }
    Write-Ok ('comprobado: los primeros ' + $originalText.Length + ' bytes son identicos (nada ajeno cambia)')
} else {
    $candidateText = $originalText
}

if ($dry) {
    Write-Section 'Dry-run: no se ha escrito nada'
    Write-Info 'repetir sin -DryRun para instalar de verdad'
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Copia del paquete (ficheros reales, espejo del repo)
# ---------------------------------------------------------------------------
Write-Section '4. Copia del paquete'

$copyResult = Invoke-PackageCopy -Source $ctx.PackagePath -Destination $ctx.LinkPath -DryRun:$false
if (-not $copyResult.Ok) {
    Fail-With 15 ('No se pudo copiar el paquete: ' + $copyResult.Detail)
}
Write-Ok ('copia ' + $copyResult.Mechanism + ': ' + $ctx.PackagePath + ' -> ' + $ctx.LinkPath)

$destInfo = Get-LinkInfo -LinkPath $ctx.LinkPath
if ($destInfo.IsLink) { Fail-With 15 'El destino sigue siendo un enlace; debe ser una copia real' }
if (-not (Test-Path -LiteralPath (Join-Path $ctx.LinkPath 'package.json'))) { Fail-With 15 'La copia no tiene package.json' }

# La copia declara dsh.client solo si hay artefacto de cliente en la copia.
$installedPkgJson = Join-Path $ctx.LinkPath 'package.json'
$installedPkg = $null
try { $installedPkg = (Read-Utf8Text $installedPkgJson) | ConvertFrom-Json } catch { Fail-With 15 ('package.json de la copia no parsea: ' + $_.Exception.Message) }
$copyHasClient = Test-Path -LiteralPath (Join-Path $ctx.LinkPath 'client.js')
$copyDeclaresClient = ($null -ne $installedPkg.dsh -and $null -ne $installedPkg.dsh.client)
if ($copyHasClient -and -not $copyDeclaresClient) {
    Fail-With 15 'La copia tiene client.js pero no declara dsh.client: la UI no se servira'
}
if (-not $copyHasClient -and $copyDeclaresClient) {
    $stripped = Remove-ClientDeclaration -PackageJsonPath $installedPkgJson -NodeExe $ctx.NodeExe -StripperJs $ctx.StripperJs
    if (-not $stripped) { Fail-With 15 'No se pudo quitar dsh.client de la copia (faltaria client.js)' }
    $installedPkg = (Read-Utf8Text $installedPkgJson) | ConvertFrom-Json
}
$copyManifest = Get-TreeManifest -Path $ctx.LinkPath -Exclude @('package.json')
$srcManifest = Get-TreeManifest -Path $ctx.PackagePath -Exclude @('package.json')
$cmp = Compare-TreeManifest -Left $srcManifest -Right $copyManifest
if (-not $cmp.Equal) {
    Write-Warn ('la copia no es espejo exacto: distinto=' + ($cmp.Different -join ',') + ' sobran=' + ($cmp.OnlyRight -join ',') + ' faltan=' + ($cmp.OnlyLeft -join ','))
} else {
    Write-Ok ('copia verificada: ' + $copyManifest.Count + ' ficheros con los mismos hashes que el repo')
}
if ($copyHasClient) { Write-Ok 'la copia declara dsh.client (mitad cliente disponible)' }
else { Write-Warn 'la copia NO declara dsh.client (solo mitad Host)' }

# ---------------------------------------------------------------------------
# 5. Patch del perfil
# ---------------------------------------------------------------------------
if ($Update) {
    Write-Section '5. Patch del perfil'
    Write-Ok '-Update: no se toca el patch (solo se sincronizo la copia)'
    Write-Host ''
    Write-Host '  La copia instalada ya coincide con el repo. El Host sirve el codigo de la copia,'
    Write-Host '  asi que para ver un cambio de index.js hace falta re-ejecutar este script y que el'
    Write-Host '  Host recomponga (HMR del patch) o, si solo cambio el codigo, reiniciar la app.'
    Write-Host ''
    Write-Host 'SALIDA: 0'
    exit 0
}

if ($rowPresent) {
    Write-Section '5. Patch del perfil'
    Write-Ok 'sin cambios: la fila ya estaba (idempotente)'
    Write-Host ''
    Write-Host '  El plugin ya esta instalado: copia sincronizada + fila en el patch.'
    Write-Host ('  Comprobar con: powershell -NoProfile -ExecutionPolicy Bypass -File ' + (Join-Path $PSScriptRoot 'verify-mcp-console.ps1'))
    Write-Host ''
    Write-Host 'SALIDA: 0'
    exit 0
}

Write-Section '5. Patch del perfil'

$backupPath = $null
try { $backupPath = New-PatchBackup -PatchPath $ctx.PatchPath -DryRun:$false }
catch { Fail-With 12 ('No se pudo crear el backup: ' + $_.Exception.Message) }

# Candidato en un fichero temporal del MISMO directorio: se valida antes de tocar nada.
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$candidatePath = Join-Path $ctx.ProfileDir ('cordis.patch.yml.candidate-mcpconsole-' + $stamp)
try {
    Write-Utf8Text $candidatePath $candidateText
    $reread = Read-Utf8Text $candidatePath
    if ($reread -ne $candidateText) { Fail-With 13 'El fichero candidato no se relee igual (codificacion)' }

    $emptyInserts = Get-EmptyInsertBlocks -Text $candidateText
    if ($emptyInserts.Count -gt 0) {
        Fail-With 13 ('El patch candidato tiene ' + $emptyInserts.Count + ' "- insert:" sin hijos (lineas ' + ($emptyInserts.Lines -join ', ') + '): rompe la composicion. No se ha escrito nada.')
    }
    Write-Info 'validando el YAML candidato con el compositor real de DSH...'
    $validation = Invoke-PatchValidation -Mode 'install' -CandidatePath $candidatePath `
        -BaselinePath $ctx.PatchPath -HomePatchPath $ctx.HomePatchPath `
        -AppBootJs $ctx.AppBootJs -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
    if (-not (Show-ValidationResult -Result $validation)) {
        Fail-With 13 'El patch candidato no valida. No se ha escrito nada en el patch del perfil.'
    }
} finally {
    if (Test-Path -LiteralPath $candidatePath) { Remove-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue }
}

# Escritura atomica: temporal + replace. El watcher de HMR vera un cambio real y
# recompondra la capa (~2 s, recon/mcp-runtime.md seccion 5).
$expectedHash = $null
$tmpPath = $ctx.PatchPath + '.tmp-mcpconsole'
try {
    Write-Utf8Text $tmpPath $candidateText
    $expectedHash = Get-Sha256 $tmpPath
    [System.IO.File]::Replace($tmpPath, $ctx.PatchPath, $null)
} catch {
    if (Test-Path -LiteralPath $tmpPath) {
        try { Move-Item -LiteralPath $tmpPath -Destination $ctx.PatchPath -Force -ErrorAction Stop }
        catch { Fail-With 14 ('No se pudo escribir el patch: ' + $_.Exception.Message + ' (backup: ' + $backupPath + ')') }
    } else {
        Fail-With 14 ('No se pudo escribir el patch: ' + $_.Exception.Message + ' (backup: ' + $backupPath + ')')
    }
} finally {
    if (Test-Path -LiteralPath $tmpPath) { Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------
# 6. Verificacion posterior (releer del disco)
# ---------------------------------------------------------------------------
Write-Section '6. Verificacion'

$onDiskText = Read-Utf8Text $ctx.PatchPath
$onDiskHash = Get-Sha256 $ctx.PatchPath
if ($onDiskText -ne $candidateText) {
    Copy-Item -LiteralPath $backupPath -Destination $ctx.PatchPath -Force -ErrorAction SilentlyContinue
    Fail-With 14 'El patch en disco no coincide con el candidato; restaurado el backup.'
}
if ($expectedHash -and $onDiskHash -ne $expectedHash) {
    Write-Warn ('hash en disco distinto del esperado: ' + $onDiskHash + ' vs ' + $expectedHash)
}
Write-Ok ('patch escrito: ' + (Get-LineCount $onDiskText) + ' lineas, sha256=' + $onDiskHash.Substring(0, 16) + '...')

$postEmpty = Get-EmptyInsertBlocks -Text $onDiskText
if ($postEmpty.Count -gt 0) {
    Copy-Item -LiteralPath $backupPath -Destination $ctx.PatchPath -Force -ErrorAction SilentlyContinue
    Fail-With 17 ('Tras escribir hay ' + $postEmpty.Count + ' "- insert:" sin hijos (lineas ' + ($postEmpty.Lines -join ', ') + '). Restaurado el backup.')
}
$postOcc = Get-RowOccurrences -Text $onDiskText
if ($postOcc.IdCount -ne 1) {
    Copy-Item -LiteralPath $backupPath -Destination $ctx.PatchPath -Force -ErrorAction SilentlyContinue
    Fail-With 17 ('Tras escribir hay ' + $postOcc.IdCount + ' filas "' + $ctx.RowId + '" (se esperaba 1). Restaurado el backup.')
}
Write-Ok ('fila "' + $ctx.RowId + '" presente una sola vez (linea ' + ($postOcc.IdLines -join ', ') + ')')

$postValidation = Invoke-PatchValidation -Mode 'check' -CandidatePath $ctx.PatchPath `
    -AppBootJs $ctx.AppBootJs -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
if ($postValidation -and -not $postValidation.ok) {
    Copy-Item -LiteralPath $backupPath -Destination $ctx.PatchPath -Force -ErrorAction SilentlyContinue
    Show-ValidationResult -Result $postValidation | Out-Null
    Fail-With 17 'El patch escrito no valida; restaurado el backup.'
}
if ($postValidation) { Write-Ok ('YAML en disco valido: ' + $postValidation.afterRows + ' filas compuestas') }

# ---------------------------------------------------------------------------
# 7. Estado esperado
# ---------------------------------------------------------------------------
Write-Section '7. Instalado'
Write-Host ''
Write-Host '  Estado esperado:'
Write-Host ('    - fila      : id=' + $ctx.RowId + '  name=' + $ctx.PackageName + '  (patch del perfil)')
Write-Host ('    - paquete   : ' + $ctx.LinkPath + '   (COPIA real del repo)')
Write-Host ('    - mitad UI  : /plugins/' + $ctx.PackageName + '/client.js (requiere cookie de sesion: desde fuera da 401)')
Write-Host '    - HMR       : el watcher del patch recompone la capa ~2 s despues de guardar; no hay que reiniciar DSH'
Write-Host ''
Write-Host '  Como comprobarlo:'
Write-Host ('    powershell -NoProfile -ExecutionPolicy Bypass -File ' + (Join-Path $PSScriptRoot 'verify-mcp-console.ps1'))
Write-Host '    En la GUI: pagina Plugins (la fila aparece) y el boton del plugin en la barra lateral.'
Write-Host ''
Write-Host ('  Backup del patch previo: ' + $backupPath)
Write-Host ('  Para revertir:           powershell -NoProfile -ExecutionPolicy Bypass -File ' + (Join-Path $PSScriptRoot 'uninstall-mcp-console.ps1'))
Write-Host ''
Write-Host '  Recordatorio: la copia instalada es la que se ejecuta. Tras cambiar el'
Write-Host '  codigo del plugin, re-ejecutar este script (o con -Update) para resincronizarla.'
Write-Host '  Nota: no se ha tocado ningun servidor MCP ni se ha reiniciado DSH.'
Write-Host ''
Write-Host 'SALIDA: 0'
exit 0
