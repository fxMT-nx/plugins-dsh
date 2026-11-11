<#
.SYNOPSIS
    Desinstala @local/dsh-mcp-console del perfil `desktop` de DSH.

.DESCRIPTION
    Operacion inversa exacta de install-mcp-console.ps1:

      1. quita del patch del perfil SOLO nuestra fila (- insert: id mcp-console);
      2. borra la COPIA instalada del paquete en node_modules (el paquete del
         repo no se toca: la copia es un espejo, no un enlace);
      3. comprueba que el patch queda equivalente al que habia antes de instalar:
         mismo hash si nada ajeno cambio, o diff explicito si otro especialista
         edito el patch mientras tanto.

    Idempotente: si no hay fila ni copia, no hace nada y sale 0.
    Nunca escribe en la capa home (~/.dsh/cordis.patch.yml).

.PARAMETER DropOrphanComments
    Quita tambien un bloque de comentarios AL FINAL del fichero que mencione nuestra
    fila o nuestro paquete (p. ej. el '# -- spike @local/dsh-mcp-console ...' que dejo
    un instalador ajeno). Necesario para que el patch vuelva a ser byte a byte igual
    al original. Solo actua sobre comentarios finales que nos mencionen.

.PARAMETER KeepCopy
    Quita la fila pero deja la copia del paquete en node_modules.

.PARAMETER RestoreBackup
    Si el patch no queda equivalente al original, restaura el backup previo a la
    instalacion (antes hace copia del estado actual). Por defecto NO se restaura:
    se informa y se deja el patch como este.

.PARAMETER DryRun
    Ensenya lo que haria sin escribir nada. `-WhatIf` hace lo mismo.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-mcp-console.ps1 -DryRun

.NOTES
    Codigos de salida:
      0  desinstalado (o no habia nada que quitar)
      20 precondiciones del entorno
      21 fallo al crear el backup previo
      22 fallo al escribir el patch (no se toco nada)
      23 no se pudo quitar la copia del paquete
      24 el patch quedo con restos de nuestra fila o no valida (se informa y se
         intenta restaurar el backup)
      25 no se pudo demostrar la equivalencia con el original (diff ajeno)
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$ProfileName = 'desktop',
    [string]$ProjectRoot = '',
    [string]$ProfileDir = '',
    [switch]$DryRun,
    [switch]$KeepCopy,
    [switch]$DropOrphanComments,
    [switch]$RestoreBackup
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

. (Join-Path $PSScriptRoot '_mcp-console-common.ps1')

$ctx = Get-McpConsoleContext -ProfileName $ProfileName -ProjectRoot $ProjectRoot -ProfileDirOverride $ProfileDir
$dry = Test-DryRun -DryRun:$DryRun

Write-Host ''
Write-Host '============================================================'
Write-Host ' uninstall-mcp-console.ps1'
Write-Host (' perfil   : ' + $ctx.ProfileName + '  (' + $ctx.ProfileDir + ')')
Write-Host (' modo     : ' + $(if ($dry) { 'DRY-RUN (no se escribe nada)' } else { 'REAL' }))
Write-Host '============================================================'

# ---------------------------------------------------------------------------
# 1. Precondiciones
# ---------------------------------------------------------------------------
Write-Section '1. Precondiciones'

if (-not (Test-Path -LiteralPath $ctx.ProfileDir)) { Fail-With 20 ('No existe el perfil: ' + $ctx.ProfileDir) }
if (-not (Test-Path -LiteralPath $ctx.PatchPath)) { Fail-With 20 ('No existe el patch del perfil: ' + $ctx.PatchPath) }

$currentText = Read-Utf8Text $ctx.PatchPath
$currentHash = Get-Sha256 $ctx.PatchPath
Write-Ok ('patch del perfil: ' + (Get-LineCount $currentText) + ' lineas, sha256=' + $currentHash.Substring(0, 16) + '...')

if (Test-Path -LiteralPath $ctx.HomePatchPath) {
    $homeOcc = Get-RowOccurrences -Text (Read-Utf8Text $ctx.HomePatchPath)
    if ($homeOcc.IdCount -gt 0) {
        Write-Warn ('la capa home tambien contiene la fila "' + $ctx.RowId + '": NO se toca (prohibido). Quitarla a mano si procede.')
    } else {
        Write-Ok 'capa home sin nuestra fila (no se escribe en ella)'
    }
}

# ---------------------------------------------------------------------------
# 2. Estado actual
# ---------------------------------------------------------------------------
Write-Section '2. Estado actual'

$occ = Get-RowOccurrences -Text $currentText
$installed = Get-LinkInfo -LinkPath $ctx.LinkPath

if ($occ.IdCount -eq 0) { Write-Info 'la fila no esta en el patch' }
elseif ($occ.IdCount -eq 1) { Write-Info ('la fila esta en el patch (linea ' + ($occ.IdLines -join ', ') + ')') }
else { Write-Warn ('la fila aparece ' + $occ.IdCount + ' veces (lineas ' + ($occ.IdLines -join ', ') + '): se quitaran todas') }

if (-not $installed.Exists) {
    Write-Info 'no hay copia del paquete en node_modules'
} elseif ($installed.IsLink) {
    Write-Warn ('hay un ENLACE (no una copia) en ' + $ctx.LinkPath + ' -> ' + $installed.Target)
} elseif ($installed.IsDirectory) {
    $n = @(Get-ChildItem -LiteralPath $ctx.LinkPath -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    Write-Info ('hay copia del paquete en ' + $ctx.LinkPath + ' (' + $n + ' ficheros)')
} else {
    Write-Warn ('hay algo que no es un directorio en ' + $ctx.LinkPath)
}

$backups = Get-PatchBackups -PatchPath $ctx.PatchPath
$reference = $null
foreach ($b in $backups) {
    $t = Read-Utf8Text $b.FullName
    if ((Get-RowOccurrences -Text $t).IdCount -eq 0) { $reference = $b; break }
}
if ($reference) { Write-Info ('referencia previa a la instalacion: ' + $reference.Name) }
else { Write-Warn 'no hay backup previo a la instalacion (no se podra comparar con el original)' }

if ($occ.IdCount -eq 0 -and -not $installed.Exists) {
    Write-Section '3. Nada que quitar'
    Write-Ok 'el plugin no esta instalado en este perfil (idempotente)'
    Write-Host ''
    Write-Host 'SALIDA: 0'
    exit 0
}

# ---------------------------------------------------------------------------
# 3. Calcular el patch sin nuestra fila
# ---------------------------------------------------------------------------
Write-Section '3. Patch sin nuestra fila'

$newText = $currentText
$strategies = @()
$guard = 0
while ($true) {
    $r = Remove-RowBlock -Text $newText
    if (-not $r.Removed) { break }
    $strategies += $r.Strategy
    $newText = $r.Text
    $guard++
    if ($guard -gt 8) { break }
}
# Comentario huerfano: un instalador ajeno (un spike) puede dejar
# "# -- spike @local/dsh-mcp-console ..." justo encima de la fila. Quitarlo es
# opcional (-DropOrphanComments) y solo afecta a comentarios FINALES que
# mencionen nuestra fila o nuestro paquete.
if ($DropOrphanComments -and $strategies.Count -gt 0) {
    $stripped = Remove-OrphanTrailingComments -Text $newText -Mention ($ctx.RowId + '|' + [regex]::Escape($ctx.PackageName))
    if ($stripped -ne $newText) {
        $strategies += 'orphan-comment'
        $newText = $stripped
        Write-Ok 'comentario huerfano (del spike) eliminado tambien'
    } else {
        Write-Info 'no habia comentarios huerfanos que quitar'
    }
}
$emptyInserts = Get-EmptyInsertBlocks -Text $newText
if ($emptyInserts.Count -gt 0) {
    Fail-With 24 ('El patch resultante tendria ' + $emptyInserts.Count + ' "- insert:" sin hijos (lineas ' + ($emptyInserts.Lines -join ', ') + '): rompe la composicion. No se ha escrito nada.')
}
$rowStillThere = (Get-RowOccurrences -Text $newText).IdCount

if ($strategies.Count -eq 0) {
    Write-Warn 'no he reconocido el bloque de la fila; no se toca el patch'
} else {
    Write-Ok ('bloque eliminado (estrategia: ' + ($strategies -join ', ') + ')')
    Write-Host ''
    Write-Host '  --- diff exacto (patch del perfil) ---'
    Write-Host ('    ' + (Get-LineCount $currentText) + ' lineas -> ' + (Get-LineCount $newText) + ' lineas')
    $showed = 0
    foreach ($line in ($currentText -split "`n")) {
        if ($line -match ([regex]::Escape($ctx.RowId)) -and $showed -lt 12) {
            Write-Host ('    - ' + $line) -ForegroundColor Red
            $showed++
        }
    }
    $removedLines = (Get-LineCount $currentText) - (Get-LineCount $newText)
    Write-Info ('lineas eliminadas: ' + $removedLines + ' (ninguna otra linea se modifica)')
}

if ($rowStillThere -gt 0) {
    Fail-With 24 ('Quedan ' + $rowStillThere + ' apariciones de "' + $ctx.RowId + '" que este script no sabe quitar. No se ha escrito nada; revisar el patch a mano.')
}

if ($dry) {
    Write-Section 'Dry-run: no se ha escrito nada'
    Write-Info 'acciones previstas:'
    if ($newText -ne $currentText) {
        Write-Info ('  - backup del patch y reescritura sin la fila (' + (Get-LineCount $newText) + ' lineas)')
    } else {
        Write-Info '  - el patch no necesita cambios'
    }
    if ($installed.Exists -and -not $KeepCopy) { Write-Info ('  - borrar la copia del paquete ' + $ctx.LinkPath + ' (el repo no se toca)') }
    elseif ($KeepCopy) { Write-Info '  - la copia se conserva (-KeepCopy)' }
    exit 0
}

# ---------------------------------------------------------------------------
# 4. Backup + validacion + escritura
# ---------------------------------------------------------------------------
Write-Section '4. Escritura del patch'

$backupPath = $null
if ($newText -ne $currentText) {
    try { $backupPath = New-PatchBackup -PatchPath $ctx.PatchPath -FailureCode 21 }
    catch { Fail-With 21 ('No se pudo crear el backup: ' + $_.Exception.Message) }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $candidatePath = Join-Path $ctx.ProfileDir ('cordis.patch.yml.candidate-mcpconsole-' + $stamp)
    try {
        Write-Utf8Text $candidatePath $newText
        if ((Read-Utf8Text $candidatePath) -ne $newText) { Fail-With 22 'El candidato no se relee igual (codificacion)' }

        Write-Info 'validando el YAML resultante con el compositor real de DSH...'
        $validation = $null
        if ($reference) {
            $validation = Invoke-PatchValidation -Mode 'uninstall' -CandidatePath $candidatePath `
                -BaselinePath $reference.FullName -AppBootJs $ctx.AppBootJs `
                -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
        } else {
            $validation = Invoke-PatchValidation -Mode 'check' -CandidatePath $candidatePath `
                -AppBootJs $ctx.AppBootJs -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
        }
        if (-not (Show-ValidationResult -Result $validation)) {
            Fail-With 22 'El patch resultante no valida. No se ha escrito nada en el patch del perfil.'
        }
    } finally {
        if (Test-Path -LiteralPath $candidatePath) { Remove-Item -LiteralPath $candidatePath -Force -ErrorAction SilentlyContinue }
    }

    $tmpPath = $ctx.PatchPath + '.tmp-mcpconsole'
    try {
        Write-Utf8Text $tmpPath $newText
        [System.IO.File]::Replace($tmpPath, $ctx.PatchPath, $null)
    } catch {
        if (Test-Path -LiteralPath $tmpPath) {
            try { Move-Item -LiteralPath $tmpPath -Destination $ctx.PatchPath -Force -ErrorAction Stop }
            catch { Fail-With 22 ('No se pudo escribir el patch: ' + $_.Exception.Message + ' (backup: ' + $backupPath + ')') }
        } else {
            Fail-With 22 ('No se pudo escribir el patch: ' + $_.Exception.Message + ' (backup: ' + $backupPath + ')')
        }
    } finally {
        if (Test-Path -LiteralPath $tmpPath) { Remove-Item -LiteralPath $tmpPath -Force -ErrorAction SilentlyContinue }
    }

    $onDisk = Read-Utf8Text $ctx.PatchPath
    if ($onDisk -ne $newText) {
        Copy-Item -LiteralPath $backupPath -Destination $ctx.PatchPath -Force -ErrorAction SilentlyContinue
        Fail-With 22 'El patch en disco no coincide con lo esperado; restaurado el backup previo.'
    }
    Write-Ok ('patch reescrito: ' + (Get-LineCount $onDisk) + ' lineas, sha256=' + (Get-Sha256 $ctx.PatchPath).Substring(0, 16) + '...')
} else {
    Write-Ok 'el patch no necesita cambios'
}

# ---------------------------------------------------------------------------
# 5. Copia instalada del paquete
# ---------------------------------------------------------------------------
Write-Section '5. Copia del paquete'

if (-not $installed.Exists) {
    Write-Ok 'no habia copia del paquete: nada que quitar'
} elseif ($KeepCopy) {
    Write-Warn 'copia conservada (-KeepCopy)'
} else {
    # Red de seguridad: nunca borrar recursivamente por una ruta que no sea
    # exactamente la nuestra, y nunca seguir un enlace (borraria el destino).
    $expectedPrefix = $ctx.NodeModules.TrimEnd('\') + '\'
    $isOurPath = $ctx.LinkPath.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    if (-not $isOurPath) {
        Fail-With 23 ('Rechazo borrar ' + $ctx.LinkPath + ': no esta bajo ' + $ctx.NodeModules)
    }
    if ($installed.IsLink -or $installed.Unreadable) {
        try {
            [System.IO.Directory]::Delete($ctx.LinkPath, $false)   # no recursivo: nunca toca el destino
            Write-Ok ('enlace eliminado (sin tocar su destino: ' + $installed.Target + ')')
        } catch {
            Fail-With 23 ('No se pudo quitar el enlace: ' + $_.Exception.Message)
        }
    } else {
        # Comprobar que lo que vamos a borrar es de verdad una copia de NUESTRO paquete.
        $copyPkg = Join-Path $ctx.LinkPath 'package.json'
        $copyName = $null
        if (Test-Path -LiteralPath $copyPkg) {
            try { $copyName = ((Read-Utf8Text $copyPkg) | ConvertFrom-Json).name } catch { $copyName = $null }
        }
        if ($copyName -ne $ctx.PackageName) {
            Fail-With 23 ('Rechazo borrar ' + $ctx.LinkPath + ': su package.json dice "' + $copyName + '", no "' + $ctx.PackageName + '"')
        }
        try {
            Remove-Item -LiteralPath $ctx.LinkPath -Recurse -Force -ErrorAction Stop
            Write-Ok ('copia eliminada: ' + $ctx.LinkPath)
        } catch {
            Fail-With 23 ('No se pudo borrar la copia: ' + $_.Exception.Message)
        }
        if (Test-Path -LiteralPath $ctx.LinkPath) { Write-Warn ('la copia sigue ahi: ' + $ctx.LinkPath) }
        if (Test-Path -LiteralPath (Join-Path $ctx.PackagePath 'package.json')) {
            Write-Ok ('paquete del repo intacto: ' + $ctx.PackagePath)
        } else {
            Write-Warn ('OJO: no veo el paquete del repo en ' + $ctx.PackagePath)
        }
    }
    # Limpiar @local si quedo vacio (y solo si vacio).
    if (Test-Path -LiteralPath $ctx.ScopeDir) {
        $left = @(Get-ChildItem -LiteralPath $ctx.ScopeDir -Force -ErrorAction SilentlyContinue)
        if ($left.Count -eq 0) {
            Remove-Item -LiteralPath $ctx.ScopeDir -Force -ErrorAction SilentlyContinue
            Write-Ok 'directorio node_modules\@local vacio: eliminado'
        } else {
            Write-Info ('node_modules\@local conserva ' + $left.Count + ' entrada(s): no se toca')
        }
    }
    if (Test-Path -LiteralPath $ctx.NodeModules) {
        $leftNm = @(Get-ChildItem -LiteralPath $ctx.NodeModules -Force -ErrorAction SilentlyContinue)
        if ($leftNm.Count -eq 0) {
            Remove-Item -LiteralPath $ctx.NodeModules -Force -ErrorAction SilentlyContinue
            Write-Ok 'node_modules quedo vacio: eliminado (el perfil vuelve al estado previo)'
        }
    }
}

# ---------------------------------------------------------------------------
# 6. Equivalencia con el original
# ---------------------------------------------------------------------------
Write-Section '6. Equivalencia con el estado previo'

$finalText = Read-Utf8Text $ctx.PatchPath
$finalHash = Get-Sha256 $ctx.PatchPath
$finalOcc = Get-RowOccurrences -Text $finalText
if ($finalOcc.IdCount -ne 0) {
    Fail-With 24 ('Quedan ' + $finalOcc.IdCount + ' apariciones de la fila tras la desinstalacion')
}

$equivalenceCode = 0
if ($reference) {
    $refText = Read-Utf8Text $reference.FullName
    $refHash = Get-Sha256 $reference.FullName
    if ($finalHash -eq $refHash) {
        Write-Ok ('IDENTICO al patch original, byte a byte (sha256=' + $finalHash + ')')
        Write-Ok ('referencia: ' + $reference.Name)
    } else {
        Write-Warn 'el patch NO es byte a byte igual al original:'
        Write-Info ('  original  (' + $reference.Name + '): sha256=' + $refHash.Substring(0, 16) + '...')
        Write-Info ('  actual                    : sha256=' + $finalHash.Substring(0, 16) + '...')
        $diff = Show-TextDiff -Left $refText -Right $finalText -LeftLabel 'original' -RightLabel 'actual'
        if ($diff -gt 0) {
            Write-Warn ('hay ' + $diff + ' linea(s) de diferencia. Nuestra fila ya no esta; si son cambios de otros, el patch es equivalente respecto a este plugin.')
            $equivalenceCode = 25
        }
    }

    # Prueba de cirugia: el backup previo menos el bloque == lo que hay ahora.
    if ($backupPath) {
        $prevText = Read-Utf8Text $backupPath
        $undo = Remove-RowBlock -Text $prevText
        $undoText = $undo.Text
        if ($DropOrphanComments) {
            $undoText = Remove-OrphanTrailingComments -Text $undoText -Mention ($ctx.RowId + '|' + [regex]::Escape($ctx.PackageName))
        }
        if ($undo.Removed -and $undoText -eq $finalText) {
            Write-Ok 'eliminacion quirurgica: backup_previo - bloque == patch actual (nada ajeno se toco)'
        } else {
            Write-Warn 'no se puede demostrar que la eliminacion fuese quirurgica; revisar el diff de arriba'
        }
    }

    if ($RestoreBackup -and $equivalenceCode -ne 0) {
        $preRestore = New-PatchBackup -PatchPath $ctx.PatchPath -FailureCode 21
        Copy-Item -LiteralPath $reference.FullName -Destination $ctx.PatchPath -Force
        Write-Ok ('patch restaurado desde ' + $reference.Name + ' (copia del estado anterior: ' + (Split-Path -Leaf $preRestore) + ')')
        if ((Get-Sha256 $ctx.PatchPath) -eq $refHash) { Write-Ok 'hash restaurado: identico al original'; $equivalenceCode = 0 }
        else { Write-Bad 'la restauracion no da el hash esperado' }
    }
} else {
    Write-Warn 'sin backup previo a la instalacion: solo se puede afirmar que el YAML es valido y la fila no esta'
}

$post = Invoke-PatchValidation -Mode 'check' -CandidatePath $ctx.PatchPath -AppBootJs $ctx.AppBootJs `
    -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
if ($post -and -not $post.ok) {
    Show-ValidationResult -Result $post | Out-Null
    Fail-With 24 'El patch final no valida'
}
if ($post) { Write-Ok ('YAML final valido: ' + $post.afterRows + ' filas compuestas') }

Write-Section '7. Desinstalado'
Write-Host ''
Write-Host '  Estado esperado:'
Write-Host ('    - fila "' + $ctx.RowId + '" ausente del patch del perfil')
Write-Host ('    - copia del paquete ausente de ' + $ctx.NodeModules + '  (el repo sigue en plugins/)')
Write-Host '    - HMR recompone la capa ~2 s despues de guardar; el plugin se descarga solo'
Write-Host '    - los 16 servidores MCP de la capa home siguen intactos (no se han tocado)'
Write-Host ''
Write-Host '  Los backups se conservan; para borrarlos:'
Write-Host ('    Get-ChildItem "' + $ctx.ProfileDir + '\cordis.patch.yml-bak-mcpconsole-*" | Remove-Item')
Write-Host ''
if ($equivalenceCode -ne 0) { Write-Host ('SALIDA: ' + $equivalenceCode); exit $equivalenceCode }
Write-Host 'SALIDA: 0'
exit 0
