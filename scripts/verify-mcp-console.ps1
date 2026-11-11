<#
.SYNOPSIS
    Verificacion de salud, SOLO LECTURA, de @local/dsh-mcp-console en el perfil.

.DESCRIPTION
    No escribe nada (ni backups): se puede ejecutar tantas veces como se quiera.
    Comprueba, en este orden:

      1. entorno        : perfil, patch, node del runtime
      2. YAML           : el patch parsea y compone con el compositor real de DSH
      3. fila (perfil)  : la fila mcp-console esta UNA vez en el patch del perfil
      4. fila (home)    : no esta en la capa home (prohibido tocarla)
      5. copia          : node_modules\@local\dsh-mcp-console es una COPIA real
                          (no un enlace) y sus hashes coinciden con el repo
      6. paquete        : package.json, dsh.client, exports, sintaxis de index/client
      7. servidores MCP : procesos hijo *-cli.exe del host + filas mcp-* de la capa home
      8. tools          : recuento de tools mcp__*  (normalmente NO disponible)
      9. GUI            : el servidor web del host responde (401 sin cookie = vivo)

.PARAMETER HostPid
    PID del proceso Host. Por defecto se deduce: el padre mayoritario de los
    procesos *-cli.exe (los servidores MCP stdio son hijos del host).

.PARAMETER SkipProcessCheck
    Omite el bloque 7 (procesos). Util en un entorno sin DSH arrancado.

.PARAMETER SkipWeb
    Omite el bloque 9 (comprobacion HTTP local).

.PARAMETER Json
    Salida JSON en vez de texto (para encadenar con otras herramientas).

.EXAMPLE
    pwsh -File scripts\verify-mcp-console.ps1

.NOTES
    Codigos de salida:
      0  sano (todo PASS)
      30 sano con avisos (WARN: p.ej. el plugin no esta instalado, o tools N/D)
      31 hay fallos (FAIL)
#>

[CmdletBinding()]
param(
    [string]$ProfileName = 'desktop',
    [string]$ProjectRoot = '',
    [string]$ProfileDir = '',
    [int]$HostPid = 0,
    [switch]$SkipProcessCheck,
    [switch]$SkipWeb,
    [switch]$Json
)

try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

. (Join-Path $PSScriptRoot '_mcp-console-common.ps1')

$ctx = Get-McpConsoleContext -ProfileName $ProfileName -ProjectRoot $ProjectRoot -ProfileDirOverride $ProfileDir

$checks = New-Object System.Collections.ArrayList
function Add-Check {
    param([string]$Id, [string]$Status, [string]$Detail)
    $null = $checks.Add([pscustomobject]@{ check = $Id; status = $Status; detail = $Detail })
}

# 1. entorno -----------------------------------------------------------------
$envOk = $true
if (-not (Test-Path -LiteralPath $ctx.ProfileDir)) { Add-Check 'entorno/perfil' 'FAIL' ('no existe ' + $ctx.ProfileDir); $envOk = $false }
else { Add-Check 'entorno/perfil' 'PASS' $ctx.ProfileDir }

if (-not (Test-Path -LiteralPath $ctx.PatchPath)) { Add-Check 'entorno/patch' 'FAIL' ('no existe ' + $ctx.PatchPath); $envOk = $false }

$nodeOk = (-not [string]::IsNullOrWhiteSpace($ctx.NodeExe)) -and (Test-Path -LiteralPath $ctx.NodeExe)
if ($nodeOk) { Add-Check 'entorno/node' 'PASS' $ctx.NodeExe } else { Add-Check 'entorno/node' 'WARN' 'sin node: no se validara el YAML ni la sintaxis' }

$patchText = $null
if (Test-Path -LiteralPath $ctx.PatchPath) {
    try { $patchText = Read-Utf8Text $ctx.PatchPath; Add-Check 'entorno/patch' 'PASS' ((Get-LineCount $patchText).ToString() + ' lineas, sha256=' + (Get-Sha256 $ctx.PatchPath).Substring(0, 16) + '...') }
    catch { Add-Check 'entorno/patch' 'FAIL' ('no se puede leer: ' + $_.Exception.Message) }
}

# 2. YAML --------------------------------------------------------------------
if ($envOk -and $nodeOk -and (Test-Path -LiteralPath $ctx.PatchPath)) {
    $val = Invoke-PatchValidation -Mode 'check' -CandidatePath $ctx.PatchPath `
        -HomePatchPath $ctx.HomePatchPath -AppBootJs $ctx.AppBootJs `
        -ValidatorJs $ctx.ValidatorJs -NodeExe $ctx.NodeExe -RowId $ctx.RowId
    if ($null -eq $val) { Add-Check 'yaml/compositor' 'WARN' 'validador no disponible (ver recon/asar)' }
    elseif ($val.ok) { Add-Check 'yaml/compositor' 'PASS' ($val.afterRows.ToString() + ' filas compuestas (perfil + home)') }
    else { Add-Check 'yaml/compositor' 'FAIL' (($val.errors -join ' | ')) }
} else {
    Add-Check 'yaml/compositor' 'WARN' 'omitido: faltan precondiciones'
}

# 2b. inserts vacios (comprobacion estatica, sin depender del compositor) -----
if ($patchText) {
    $emptyInserts = Get-EmptyInsertBlocks -Text $patchText
    if ($emptyInserts.Count -eq 0) { Add-Check 'yaml/insert-vacio' 'PASS' 'ningun "- insert:" sin hijos' }
    else { Add-Check 'yaml/insert-vacio' 'FAIL' ($emptyInserts.Count.ToString() + ' "- insert:" sin hijos (lineas ' + ($emptyInserts.Lines -join ',') + '): rompe la composicion') }
}

# 3. fila en el patch del perfil ---------------------------------------------
if ($patchText) {
    $occ = Get-RowOccurrences -Text $patchText
    $nameFound = Get-NameAfterRowId -Text $patchText
    if ($occ.IdCount -eq 1) {
        if ($nameFound -eq $ctx.PackageName) { Add-Check 'fila/perfil' 'PASS' ('id=' + $ctx.RowId + ' name=' + $nameFound + ' (linea ' + ($occ.IdLines -join ',') + ')') }
        else { Add-Check 'fila/perfil' 'FAIL' ('la fila apunta a "' + $nameFound + '", se esperaba "' + $ctx.PackageName + '"') }
    } elseif ($occ.IdCount -eq 0) {
        Add-Check 'fila/perfil' 'WARN' ('la fila "' + $ctx.RowId + '" no esta en el patch: el plugin no esta instalado')
    } else {
        Add-Check 'fila/perfil' 'FAIL' ($occ.IdCount.ToString() + ' apariciones (lineas ' + ($occ.IdLines -join ',') + '): fila duplicada')
    }
}

# 4. fila en la capa home ----------------------------------------------------
if (Test-Path -LiteralPath $ctx.HomePatchPath) {
    $homeText = Read-Utf8Text $ctx.HomePatchPath
    $homeOcc = Get-RowOccurrences -Text $homeText
    if ($homeOcc.IdCount -eq 0) { Add-Check 'fila/home' 'PASS' 'no esta en la capa home (correcto: esa capa no se toca)' }
    else { Add-Check 'fila/home' 'FAIL' ('la fila esta tambien en la capa home (lineas ' + ($homeOcc.IdLines -join ',') + ')') }

    # 7b. filas mcp-* de la capa home: son los servidores reales del usuario.
    $mcpNames = @()
    $mcpPattern = "(?m)^[ \t]*-?[ \t]*name:[ \t]*['`"]?@deepseek-ai/dsh-mcp-client['`"]?[ \t]*$"
    $mcpNames = @([regex]::Matches($homeText, $mcpPattern)).Count
    Add-Check 'servidores/filas-mcp' 'PASS' ($mcpNames.ToString() + ' filas @deepseek-ai/dsh-mcp-client en la capa home')
} else {
    Add-Check 'fila/home' 'WARN' ('no existe la capa home: ' + $ctx.HomePatchPath)
}

# 5. copia instalada del paquete --------------------------------------------
$installed = Get-LinkInfo -LinkPath $ctx.LinkPath
$pkgJsonInstalled = Join-Path $ctx.LinkPath 'package.json'
$copyRoot = $ctx.LinkPath
if (-not $installed.Exists) {
    Add-Check 'copia' 'WARN' ('no hay copia del paquete en ' + $ctx.LinkPath)
} elseif ($installed.IsLink) {
    Add-Check 'copia' 'FAIL' ('es un ENLACE, no una copia real (el Host resuelve por ruta: dsh-app-boot/lib/index.js:1337-1345). Reinstalar con install-mcp-console.ps1 -Force')
} elseif (-not $installed.IsDirectory) {
    Add-Check 'copia' 'FAIL' 'el destino existe pero no es un directorio'
} elseif (-not (Test-Path -LiteralPath $pkgJsonInstalled)) {
    Add-Check 'copia' 'FAIL' 'la copia no tiene package.json'
} else {
    Add-Check 'copia' 'PASS' ($copyRoot + ' (ficheros reales)')

    # Espejo con el repo: un plugin instalado que ya no coincide con el repo es
    # un fallo silencioso caro de depurar (se ejecuta la copia, no el repo).
    if (Test-Path -LiteralPath (Join-Path $ctx.PackagePath 'package.json')) {
        $srcManifest = Get-TreeManifest -Path $ctx.PackagePath -Exclude @('package.json')
        $copyManifest = Get-TreeManifest -Path $copyRoot -Exclude @('package.json')
        $cmp = Compare-TreeManifest -Left $srcManifest -Right $copyManifest
        if ($cmp.Equal) {
            Add-Check 'copia/espejo' 'PASS' ($srcManifest.Count.ToString() + ' ficheros con los mismos hashes que el repo')
        } else {
            $detail = 'DESINCRONIZADA con el repo: distinto=' + $cmp.Different.Count + ' sobran=' + $cmp.OnlyRight.Count + ' faltan=' + $cmp.OnlyLeft.Count
            if ($cmp.Different.Count -gt 0) { $detail += ' [' + (($cmp.Different | Select-Object -First 5) -join ', ') + ']' }
            Add-Check 'copia/espejo' 'WARN' ($detail + ' -> re-ejecutar install-mcp-console.ps1 -Update')
        }
    } else {
        Add-Check 'copia/espejo' 'WARN' ('no esta el paquete del repo en ' + $ctx.PackagePath + ': no se puede comparar')
    }

    # dsh.client solo si hay client.js en la copia (si no, MissingClientBundleError
    # en dsh-client-modules/lib/index.js:830-841).
    $copyHasClient = Test-Path -LiteralPath (Join-Path $copyRoot 'client.js')
    $declares = $false
    try {
        $instPkg = (Read-Utf8Text $pkgJsonInstalled) | ConvertFrom-Json
        $declares = ($null -ne $instPkg.dsh -and $null -ne $instPkg.dsh.client)
    } catch {
        Add-Check 'copia/package.json' 'FAIL' ('no parsea: ' + $_.Exception.Message)
    }
    if ($copyHasClient -and $declares) { Add-Check 'copia/dsh.client' 'PASS' 'declara dsh.client y client.js existe' }
    elseif ($copyHasClient -and -not $declares) { Add-Check 'copia/dsh.client' 'FAIL' 'tiene client.js pero no declara dsh.client (la UI no se sirve)' }
    elseif (-not $copyHasClient -and $declares) { Add-Check 'copia/dsh.client' 'FAIL' 'declara dsh.client sin client.js (MissingClientBundleError)' }
    else { Add-Check 'copia/dsh.client' 'WARN' 'sin mitad cliente (solo Host); correcto si el repo aun no tiene client.js' }

    # Instrumentacion de spike en la copia (traceFile / spikeSelfTest): si aparece,
    # lo que se ejecuta no es el codigo limpio del repo.
    $spikeHits = @()
    foreach ($js in @(Get-ChildItem -LiteralPath $copyRoot -Recurse -File -Filter '*.js' -ErrorAction SilentlyContinue)) {
        $txt = Read-Utf8Text $js.FullName
        if ($txt -match 'traceFile|spikeSelfTest') { $spikeHits += $js.FullName.Substring($copyRoot.Length).TrimStart('\') }
    }
    if ($spikeHits.Count -gt 0) {
        Add-Check 'copia/instrumentacion' 'WARN' ('la copia tiene instrumentacion de spike en ' + ($spikeHits -join ', ') + ' -> reinstalar desde el repo')
    } else {
        Add-Check 'copia/instrumentacion' 'PASS' 'sin traceFile/spikeSelfTest en la copia'
    }
}

# 5a. hermanos en node_modules\@local (transparencia; no son nuestros) --------
if (Test-Path -LiteralPath $ctx.ScopeDir) {
    $siblings = @(Get-ChildItem -LiteralPath $ctx.ScopeDir -Force -ErrorAction SilentlyContinue)
    $nuestro = Split-Path -Leaf $ctx.LinkPath
    $otros = @($siblings | Where-Object { $_.Name -ne $nuestro })
    if ($otros.Count -eq 0) {
        Add-Check 'copia/hermanos' 'PASS' 'node_modules\@local solo contiene nuestro paquete'
    } else {
        $conPaquete = @()
        $sinPaquete = @()
        foreach ($o in $otros) {
            if (Test-Path -LiteralPath (Join-Path $o.FullName 'package.json')) { $conPaquete += $o.Name } else { $sinPaquete += $o.Name }
        }
        if ($conPaquete.Count -gt 0) {
            Add-Check 'copia/hermanos' 'WARN' ('hay otro PAQUETE instalado en @local: ' + ($conPaquete -join ', ') + ' (no es nuestro; revisar quien lo puso)')
        }
        if ($sinPaquete.Count -gt 0) {
            Add-Check 'copia/hermanos' 'PASS' ('entradas ajenas sin package.json (no instaladas, p. ej. restos de un spike): ' + ($sinPaquete -join ', '))
        }
    }
}

# 5b. grafo de cliente (no observable desde fuera) ---------------------------
# dsh-client-modules no borra el registro de una fila de cliente al quitarla en
# caliente (lib/index.js:545-548): el grafo solo se limpia con F5 o reinicio del
# Host. Desde un script no hay forma de leer window.__DSH_BOOT__ (los endpoints
# /api exigen cookie de sesion), asi que se informa en vez de fingir un PASS.
Add-Check 'grafo/cliente' 'WARN' 'no comprobable desde fuera: una desinstalacion en caliente deja el registro en __DSH_BOOT__ hasta F5 o reinicio del Host (dsh-client-modules/lib/index.js:545-548)'

# 6. paquete -----------------------------------------------------------------
$pkgRoot = $ctx.PackagePath
if (-not (Test-Path -LiteralPath (Join-Path $pkgRoot 'package.json'))) {
    Add-Check 'paquete' 'FAIL' ('no existe el paquete en ' + $pkgRoot)
} else {
    $pkgErr = $null
    try {
        $pkg = (Read-Utf8Text (Join-Path $pkgRoot 'package.json')) | ConvertFrom-Json
        if ($pkg.name -ne $ctx.PackageName) { $pkgErr = 'name=' + $pkg.name }
        elseif ($null -eq $pkg.dsh -or $null -eq $pkg.dsh.client) { $pkgErr = 'sin dsh.client' }
        elseif ($pkg.dsh.client.platform -ne 'web') { $pkgErr = 'platform=' + $pkg.dsh.client.platform }
        elseif (-not $pkg.exports.'./client') { $pkgErr = 'sin exports["./client"]' }
    } catch { $pkgErr = 'package.json no parsea: ' + $_.Exception.Message }

    if ($pkgErr) { Add-Check 'paquete' 'FAIL' $pkgErr }
    else { Add-Check 'paquete' 'PASS' ('name=' + $pkg.name + ' version=' + $pkg.version + ' platform=web') }

    foreach ($required in @('index.js', 'client.js')) {
        $p = Join-Path $pkgRoot $required
        if (-not (Test-Path -LiteralPath $p)) { Add-Check ('paquete/' + $required) 'FAIL' 'falta'; continue }
        if (-not $nodeOk) { Add-Check ('paquete/' + $required) 'WARN' 'presente, sintaxis sin comprobar'; continue }
        $errFile = [System.IO.Path]::GetTempFileName()
        try {
            $proc = Start-Process -FilePath ('"' + $ctx.NodeExe + '"') -ArgumentList ('"--check" "' + $p + '"') `
                -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile -RedirectStandardOutput ([System.IO.Path]::GetTempFileName())
            if ($proc.ExitCode -eq 0) { Add-Check ('paquete/' + $required) 'PASS' 'node --check ok' }
            else { Add-Check ('paquete/' + $required) 'FAIL' (Read-Utf8Text $errFile).Trim() }
        } finally {
            Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
        }
    }

    foreach ($optional in @('cordis.patch.yml', 'locale\en.json', 'locale\es.json', 'icon.svg')) {
        if (-not (Test-Path -LiteralPath (Join-Path $pkgRoot $optional))) {
            Add-Check ('paquete/' + $optional) 'WARN' 'falta'
        }
    }
}

# 7. procesos MCP ------------------------------------------------------------
if ($SkipProcessCheck) {
    Add-Check 'servidores/procesos' 'WARN' 'comprobacion omitida (-SkipProcessCheck)'
} else {
    $map = Get-McpProcessMap -HostPid $HostPid
    if ($map.HostPid -le 0) {
        Add-Check 'servidores/procesos' 'WARN' 'no he encontrado procesos *-cli.exe: DSH puede estar apagado'
    } else {
        $kids = @($map.Children)
        $names = @($kids | ForEach-Object { [System.IO.Path]::GetFileNameWithoutExtension($_.Name) } | Sort-Object)
        $detail = 'host pid=' + $map.HostPid + ', hijos *-cli.exe=' + $kids.Count
        if ($names.Count -gt 0) { $detail += ' [' + ($names -join ', ') + ']' }
        if ($kids.Count -gt 0) { Add-Check 'servidores/procesos' 'PASS' $detail }
        else { Add-Check 'servidores/procesos' 'WARN' ($detail + ' -> ningun servidor MCP hijo vivo') }
        Add-Check 'servidores/pids' 'PASS' (($kids | ForEach-Object { $_.Name + '=' + $_.ProcessId } | Sort-Object) -join ', ')
    }
}

# 8. recuento de tools -------------------------------------------------------
Add-Check 'tools' 'WARN' 'no disponible fuera del proceso Host: dsh-mcp-client no publica estado (recon/mcp-runtime.md seccion 3) y los endpoints /api exigen cookie de sesion. El recuento real lo da la mitad Host del plugin.'

# 9. GUI ---------------------------------------------------------------------
if ($SkipWeb) {
    Add-Check 'gui' 'WARN' 'comprobacion omitida (-SkipWeb)'
} else {
    $url = 'http://127.0.0.1:53992/'
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
        Add-Check 'gui' 'PASS' ($url + ' -> HTTP ' + [int]$resp.StatusCode)
    } catch {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = $null }
        if ($code -eq 401) { Add-Check 'gui' 'PASS' ($url + ' -> HTTP 401 (vivo; sin cookie es lo esperado)') }
        elseif ($code) { Add-Check 'gui' 'WARN' ($url + ' -> HTTP ' + $code) }
        else { Add-Check 'gui' 'WARN' ($url + ' no responde: ' + $_.Exception.Message.Split("`n")[0]) }
    }
}

# ---------------------------------------------------------------- resultado --
$fails = @($checks | Where-Object { $_.status -eq 'FAIL' })
$warns = @($checks | Where-Object { $_.status -eq 'WARN' })
$code = 0
if ($fails.Count -gt 0) { $code = 31 } elseif ($warns.Count -gt 0) { $code = 30 }

if ($Json) {
    [pscustomobject]@{
        profile    = $ctx.ProfileName
        patch      = $ctx.PatchPath
        package    = $ctx.PackagePath
        link       = $ctx.LinkPath
        installed  = ($checks | Where-Object { $_.check -eq 'fila/perfil' -and $_.status -eq 'PASS' }) -ne $null
        pass       = @($checks | Where-Object { $_.status -eq 'PASS' }).Count
        warn       = $warns.Count
        fail       = $fails.Count
        exitCode   = $code
        checks     = $checks
    } | ConvertTo-Json -Depth 5
    exit $code
}

Write-Host ''
Write-Host '============================================================'
Write-Host (' verify-mcp-console.ps1   perfil: ' + $ctx.ProfileName)
Write-Host '============================================================'
foreach ($c in $checks) {
    $tag = switch ($c.status) { 'PASS' { '[PASS] ' } 'WARN' { '[WARN] ' } default { '[FAIL] ' } }
    $color = switch ($c.status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } default { 'Red' } }
    Write-Host ("  " + $tag + $c.check.PadRight(26) + ' ' + $c.detail) -ForegroundColor $color
}
Write-Host ''
Write-Host ('  PASS=' + @($checks | Where-Object { $_.status -eq 'PASS' }).Count + '  WARN=' + $warns.Count + '  FAIL=' + $fails.Count)
if ($code -eq 0) { Write-Host '  RESULTADO: sano' -ForegroundColor Green }
elseif ($code -eq 30) { Write-Host '  RESULTADO: sano con avisos' -ForegroundColor Yellow }
else { Write-Host '  RESULTADO: hay fallos' -ForegroundColor Red }
Write-Host ''
Write-Host ('SALIDA: ' + $code)
exit $code
