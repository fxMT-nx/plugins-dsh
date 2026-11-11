# ============================================================================
# _mcp-console-common.ps1
#
# Helpers compartidos por install/uninstall/verify de @local/dsh-mcp-console.
# Se carga con dot-sourcing desde los tres scripts: NO lo ejecutes suelto.
#
# Reglas que este fichero implementa (docs/contrato-mcp-console.md):
#   - Solo se escribe en ~/.dsh/profiles/<perfil>/ . La capa home
#     (~/.dsh/cordis.patch.yml) se LEE y nunca se escribe.
#   - El patch se lee y se escribe con .NET y UTF-8 explicito: Get-Content usa
#     la pagina ANSI por defecto en Windows PowerShell 5.1 y corromperia los
#     acentos del fichero (hay em-dashes y texto en castellano).
#   - Antes de cualquier escritura en el patch hay backup con fecha.
#
# Todo el texto es ASCII a proposito (PS 5.1 lee UTF-8 sin BOM como ANSI).
# ============================================================================

$script:McpConsoleRowId      = 'mcp-console'
$script:McpConsolePackage    = '@local/dsh-mcp-console'
$script:McpConsoleScope      = '@local'
$script:McpConsoleDirName    = 'dsh-mcp-console'
$script:McpConsoleUtf8NoBom  = New-Object System.Text.UTF8Encoding($false)

# ---------------------------------------------------------------- contexto ---

function Get-McpConsoleContext {
    param(
        [string]$ProfileName = 'desktop',
        [string]$ProjectRoot = '',
        [string]$PackagePath = '',
        [string]$ProfileDirOverride = ''
    )

    # El nombre del perfil acaba dentro de una ruta. Si admitiera separadores o "..",
    # Join-Path podria salir de ~/.dsh/profiles y escribir en la capa GLOBAL
    # (~/.dsh/cordis.patch.yml), que estos scripts prometen no tocar nunca.
    if ($ProfileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$' -or $ProfileName -match '\.\.') {
        Fail-With 20 ("ProfileName invalido: '" + $ProfileName + "'. Solo letras, digitos, punto, guion y guion bajo, empezando por letra o digito (ejemplo: -ProfileName desktop).")
    }

    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
        $ProjectRoot = Split-Path -Parent $PSScriptRoot
    }
    $ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
    if ([string]::IsNullOrWhiteSpace($PackagePath)) {
        $PackagePath = Join-Path $ProjectRoot 'plugins\dsh-mcp-console'
    }

    $home_ = $env:USERPROFILE
    if ([string]::IsNullOrWhiteSpace($ProfileDirOverride)) {
        $profileDir = Join-Path $home_ ".dsh\profiles\$ProfileName"
    } else {
        # Solo para pruebas: permite ejercitar los scripts contra una copia del
        # perfil en un directorio temporal, sin tocar el perfil vivo.
        $profileDir = [System.IO.Path]::GetFullPath($ProfileDirOverride)
    }

    $ctx = [ordered]@{
        ProfileName   = $ProfileName
        ProjectRoot   = $ProjectRoot
        PackagePath   = [System.IO.Path]::GetFullPath($PackagePath)
        DshHome       = Join-Path $home_ '.dsh'
        ProfileDir    = $profileDir
        PatchPath     = Join-Path $profileDir 'cordis.patch.yml'
        HomePatchPath = Join-Path $home_ '.dsh\cordis.patch.yml'
        NodeModules   = Join-Path $profileDir 'node_modules'
        ScopeDir      = Join-Path (Join-Path $profileDir 'node_modules') $script:McpConsoleScope
        LinkPath      = Join-Path (Join-Path (Join-Path $profileDir 'node_modules') $script:McpConsoleScope) $script:McpConsoleDirName
        RowId         = $script:McpConsoleRowId
        PackageName   = $script:McpConsolePackage
        AppBootJs     = Join-Path $ProjectRoot 'recon\asar\dsh\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js'
        ValidatorJs   = Join-Path $PSScriptRoot '_validate-patch.mjs'
        StripperJs    = Join-Path $PSScriptRoot '_strip-client-decl.mjs'
        NodeExe       = Get-McpConsoleNodeExe
    }
    return $ctx
}

function Get-McpConsoleNodeExe {
    $candidates = @(
        (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c) { return $c }
    }
    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    return $null
}

# ------------------------------------------------------------------ salida ---

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=== ' + $Title)
}

function Write-Ok   { param([string]$m) Write-Host ("  [OK]    " + $m) -ForegroundColor Green }
function Write-Info { param([string]$m) Write-Host ("  [..]    " + $m) }
function Write-Warn { param([string]$m) Write-Host ("  [WARN]  " + $m) -ForegroundColor Yellow }
function Write-Bad  { param([string]$m) Write-Host ("  [ERROR] " + $m) -ForegroundColor Red }
function Write-Plan { param([string]$m) Write-Host ("  [dry-run] " + $m) -ForegroundColor Cyan }

function Fail-With {
    param([int]$Code, [string]$Message)
    Write-Bad $Message
    Write-Host ''
    Write-Host ("SALIDA: " + $Code)
    exit $Code
}

function Test-DryRun {
    # -DryRun propio, o -WhatIf estandar de PowerShell (SupportsShouldProcess).
    param([switch]$DryRun)
    if ($DryRun) { return $true }
    if ($WhatIfPreference) { return $true }
    return $false
}

# ----------------------------------------------------------------- ficheros ---

function Read-Utf8Text {
    param([string]$Path)
    return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
}

function Write-Utf8Text {
    param([string]$Path, [string]$Text)
    [System.IO.File]::WriteAllText($Path, $Text, $script:McpConsoleUtf8NoBom)
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-LineCount {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return 0 }
    return ([regex]::Matches($Text, "`n")).Count + $(if ($Text.EndsWith("`n")) { 0 } else { 1 })
}

# ------------------------------------------------------------------- backup ---

function New-PatchBackup {
    <# Copia el patch con sufijo -bak-mcpconsole-<yyyyMMdd-HHmmss> y comprueba
       que la copia tiene el mismo hash que el original. Devuelve la ruta.
       -FailureCode: codigo de salida si no se puede (12 en install, 21 en uninstall). #>
    param([string]$PatchPath, [switch]$DryRun, [int]$FailureCode = 12)

    # Un patch marcado como solo lectura es una senal explicita del usuario (o de
    # otro plugin): [System.IO.File]::Replace lo reemplazaria igualmente, asi que
    # se comprueba a mano y se para.
    $item = Get-Item -LiteralPath $PatchPath -Force
    if ($item.IsReadOnly) {
        Fail-With $FailureCode ('El patch esta marcado como SOLO LECTURA: ' + $PatchPath + '. Quitar el atributo a proposito (attrib -R) si de verdad se quiere escribir.')
    }

    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backup = "$PatchPath-bak-mcpconsole-$stamp"
    if (Test-Path -LiteralPath $backup) {
        $backup = "$PatchPath-bak-mcpconsole-$stamp-" + (Get-Random -Maximum 9999)
    }

    if ($DryRun) {
        Write-Plan ("crearia backup: " + (Split-Path -Leaf $backup))
        return $backup
    }

    Copy-Item -LiteralPath $PatchPath -Destination $backup -ErrorAction Stop
    $hSrc = Get-Sha256 $PatchPath
    $hDst = Get-Sha256 $backup
    if ($hSrc -ne $hDst) {
        Fail-With 12 ("El backup no coincide con el original: " + $hDst + " != " + $hSrc)
    }
    Write-Ok ("backup: " + (Split-Path -Leaf $backup) + "  sha256=" + $hDst.Substring(0, 16) + "...")
    return $backup
}

function Get-PatchBackups {
    <# Backups del patch, del mas nuevo al mas viejo. Se aceptan las dos
       convenciones de nombre vistas en este perfil:
         cordis.patch.yml-bak-mcpconsole-<fecha>   (estos scripts)
         cordis.patch.yml.bak-mcpconsole-<fecha>   (hecho a mano en el spike)
       #>
    param([string]$PatchPath)
    $dir = Split-Path -Parent $PatchPath
    $leaf = Split-Path -Leaf $PatchPath
    $patterns = @(($leaf + '-bak-mcpconsole-*'), ($leaf + '.bak-mcpconsole-*'))
    $items = @()
    foreach ($pattern in $patterns) {
        $items += @(Get-ChildItem -LiteralPath $dir -Filter $pattern -File -ErrorAction SilentlyContinue)
    }
    return @($items | Sort-Object LastWriteTime -Descending)
}

# -------------------------------------------------------------- fila YAML ----

function Get-RowMarkerText {
    return @"
# dsh-mcp-console: fila del plugin. La anade scripts/install-mcp-console.ps1
# y la quita scripts/uninstall-mcp-console.ps1. No editar a mano.
- insert:
    - id: $script:McpConsoleRowId
      name: '$script:McpConsolePackage'
"@
}

function Get-AppendText {
    <# Texto exacto que se anade al final del patch: linea en blanco de
       separacion + bloque de la fila. Siempre LF, como el resto del fichero. #>
    $marker = Get-RowMarkerText
    $block = $marker -replace "`r`n", "`n"
    return ("`n" + $block)
}

function Get-RowOccurrences {
    <# Cuenta apariciones de NUESTRA fila en un texto YAML.
       - IdCount: lineas 'id: mcp-console' (exactas, no mcp-console-otro)
       - NameCount: apariciones del nombre de paquete
       - IdLines: numeros de linea (1-based) #>
    param([string]$Text)

    $idPattern = "(?m)^[ \t]*-?[ \t]*id:[ \t]*['`"]?" + [regex]::Escape($script:McpConsoleRowId) + "['`"]?[ \t]*$"
    $namePattern = [regex]::Escape($script:McpConsolePackage)

    $idLines = @()
    foreach ($m in [regex]::Matches($Text, $idPattern)) {
        # numero de linea 1-based = saltos de linea antes del match + 1
        $idLines += (([regex]::Matches($Text.Substring(0, $m.Index), "`n")).Count + 1)
    }

    $nameCount = ([regex]::Matches($Text, $namePattern)).Count
    return [pscustomobject]@{
        IdCount   = $idLines.Count
        IdLines   = $idLines
        NameCount = $nameCount
    }
}

function Get-NameAfterRowId {
    <# Devuelve el 'name' de la fila con nuestro id, si esta en formato bloque. #>
    param([string]$Text)
    $pattern = "(?ms)^[ \t]*-?[ \t]*id:[ \t]*['`"]?" + [regex]::Escape($script:McpConsoleRowId) + "['`"]?[ \t]*\r?\n(?<rest>(?:[ \t]+\S.*\r?\n?)*)"
    $m = [regex]::Match($Text, $pattern)
    if (-not $m.Success) { return $null }
    $n = [regex]::Match($m.Groups['rest'].Value, "(?m)^[ \t]*name:[ \t]*['`"]?(?<name>[^'`"\r\n]+)")
    if ($n.Success) { return $n.Groups['name'].Value.Trim() }
    return $null
}

function Remove-RowBlock {
    <# Quita nuestra fila de un texto. Devuelve Text nuevo + estrategia usada.
       Estrategias, en orden:
         1. suffix   : el bloque exacto que anade install esta al final (caso normal)
         2. marker   : el bloque exacto esta en medio (con o sin la linea previa en blanco)
         3. block    : '- insert:' con nuestra fila dentro
         4. inline   : '- insert: [{id: mcp-console, ...}]'
         5. row      : fila suelta '- id: mcp-console' con su name
       No toca ninguna otra linea. #>
    param([string]$Text)

    $block = (Get-AppendText)

    # 1. suffix exacto (bloque + linea en blanco de separacion)
    if ($Text.EndsWith($block)) {
        return [pscustomobject]@{ Text = $Text.Substring(0, $Text.Length - $block.Length); Strategy = 'suffix'; Removed = $true }
    }

    # 2. bloque exacto sin la linea en blanco de separacion
    $bare = $block.TrimStart("`n")
    $idx = $Text.IndexOf($bare, [System.StringComparison]::Ordinal)
    if ($idx -ge 0 -and $Text.IndexOf($bare, $idx + 1, [System.StringComparison]::Ordinal) -lt 0) {
        $new = $Text.Remove($idx, $bare.Length)
        $new = [regex]::Replace($new, "(`r?`n){3,}$", "`n")
        return [pscustomobject]@{ Text = $new; Strategy = 'marker'; Removed = $true }
    }

    # 3. bloque '- insert:' que contenga nuestra fila: se quita SOLO nuestra
    #    fila hija; si el bloque tiene otras filas (p.ej. un spike que instalo
    #    mcp-console y mcp-probe juntas), las demas se conservan. Si no queda
    #    ninguna, se quita el bloque entero: dejar un '- insert:' sin hijos rompe
    #    la composicion ("patch: id is required for non-insert patches").
    $insertRe = [regex]"(?ms)^(?<indent>[ \t]*)-[ \t]*insert:[ \t]*\r?\n(?<body>(?:[ \t]+[^\r\n]*\r?\n)*)"
    $idLineRe = "^\s*-?[ \t]*id:[ \t]*['`"]?" + [regex]::Escape($script:McpConsoleRowId) + "['`"]?[ \t]*$"
    foreach ($m in $insertRe.Matches($Text)) {
        $body = $m.Groups['body'].Value
        if (-not [regex]::IsMatch($body, "(?m)" + $idLineRe)) { continue }
        # La sangria de las filas hijas se toma de la PRIMERA linea del cuerpo:
        # un grupo con nombre dentro de una repeticion devuelve la ULTIMA captura.
        $childIndent = [regex]::Match($body, "^(?<ind>[ \t]+)-").Groups['ind'].Value
        if ([string]::IsNullOrEmpty($childIndent)) { continue }
        $rowStartRe = "(?m)^" + [regex]::Escape($childIndent) + "-[ \t]"
        $starts = @([regex]::Matches($body, $rowStartRe) | ForEach-Object { $_.Index })
        if ($starts.Count -eq 0) { continue }

        $kept = New-Object System.Text.StringBuilder
        $removedAny = $false
        for ($k = 0; $k -lt $starts.Count; $k++) {
            $from = $starts[$k]
            if ($k + 1 -lt $starts.Count) { $to = $starts[$k + 1] } else { $to = $body.Length }
            $chunk = $body.Substring($from, $to - $from)
            if ([regex]::IsMatch($chunk, "(?m)" + $idLineRe)) { $removedAny = $true }
            else { $null = $kept.Append($chunk) }
        }
        if (-not $removedAny) { continue }

        if ($kept.ToString().Trim() -eq '') {
            return [pscustomobject]@{ Text = $Text.Remove($m.Index, $m.Length); Strategy = 'insert-block'; Removed = $true }
        }
        $header = $m.Value.Substring(0, $m.Value.Length - $body.Length)
        $replacement = $header + $kept.ToString()
        return [pscustomobject]@{
            Text     = $Text.Remove($m.Index, $m.Length).Insert($m.Index, $replacement)
            Strategy = 'insert-row'
            Removed  = $true
        }
    }

    # 4. insert inline de una linea
    $inlineRe = "(?m)^[ \t]*-[ \t]*insert:[ \t]*\[.*" + [regex]::Escape($script:McpConsoleRowId) + ".*\][ \t]*\r?\n"
    $m4 = [regex]::Match($Text, $inlineRe)
    if ($m4.Success) {
        return [pscustomobject]@{ Text = $Text.Remove($m4.Index, $m4.Length); Strategy = 'inline'; Removed = $true }
    }

    # 5. fila suelta
    $rowRe = "(?ms)^(?<indent>[ \t]*)-[ \t]*id:[ \t]*['`"]?" + [regex]::Escape($script:McpConsoleRowId) + "['`"]?[ \t]*\r?\n(?<body>(?:(?<childIndent2>[ \t]+)[^\r\n]*\r?\n)*)"
    $m5 = [regex]::Match($Text, $rowRe)
    if ($m5.Success) {
        return [pscustomobject]@{ Text = $Text.Remove($m5.Index, $m5.Length); Strategy = 'row'; Removed = $true }
    }

    return [pscustomobject]@{ Text = $Text; Strategy = 'none'; Removed = $false }
}

function Remove-OrphanTrailingComments {
    <# Quita un bloque de comentarios AL FINAL del fichero cuando menciona nuestra
       fila o nuestro paquete. Es el caso real de un instalador ajeno (un spike)
       que dejo "# -- spike @local/dsh-mcp-console ..." justo encima de la fila:
       sin esto, el patch queda equivalente pero no byte a byte igual al original.
       Solo actua sobre comentarios finales que mencionen nuestra fila. #>
    param([string]$Text, [string]$Mention)

    if ([string]::IsNullOrEmpty($Text) -or [string]::IsNullOrEmpty($Mention)) { return $Text }
    $pattern = "(?s)(?:\r?\n)+((?:[ \t]*#[^\r\n]*(?:\r?\n|$))+)[ \t]*\r?\n?$"
    $m = [regex]::Match($Text, $pattern)
    if (-not $m.Success) { return $Text }
    if ($m.Groups[1].Value -notmatch $Mention) { return $Text }
    $kept = $Text.Substring(0, $m.Index)
    return ($kept.TrimEnd("`r", "`n") + "`n")
}

function Get-EmptyInsertBlocks {
    <# Comprobacion estatica barata: un '- insert:' sin hijos pasa el parser de
       YAML pero rompe la composicion ("patch: id is required for non-insert
       patches"). Recorre las lineas '- insert:' y mira la siguiente:
         - forma inline con contenido  -> OK
         - '[]' / 'null' / '~' / nada  -> VACIO
         - bloque: la siguiente linea debe estar MAS indentada que la marca  -> OK
       Devuelve Count + Lines (1-based). #>
    param([string]$Text)

    $empty = @()
    if ([string]::IsNullOrEmpty($Text)) { return [pscustomobject]@{ Count = 0; Lines = @() } }

    $lines = $Text -split "`r?`n"
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $m = [regex]::Match($lines[$i], "^(?<indent>[ \t]*)-[ \t]*insert:(?<rest>.*)$")
        if (-not $m.Success) { continue }
        $rest = $m.Groups['rest'].Value.Trim()

        if ($rest -ne '') {
            # inline: '- insert: []' / 'null' / '~' son vacios; con contenido no
            if ($rest -match '^(\[\s*\]|null|~)$') { $empty += ($i + 1) }
            continue
        }

        # bloque: la siguiente linea con contenido debe estar mas indentada
        $indentLen = $m.Groups['indent'].Value.Length
        $hasChild = $false
        for ($j = $i + 1; $j -lt $lines.Count; $j++) {
            if ($lines[$j].Trim() -eq '') { continue }
            $childIndent = ([regex]::Match($lines[$j], "^[ \t]*")).Value.Length
            if ($childIndent -gt $indentLen) { $hasChild = $true }
            break
        }
        if (-not $hasChild) { $empty += ($i + 1) }
    }
    return [pscustomobject]@{ Count = $empty.Count; Lines = @($empty | Sort-Object) }
}

# ------------------------------------------------------------- validacion ----

function Invoke-PatchValidation {
    <# Ejecuta el validador Node contra el compositor REAL de esta instalacion.
       Devuelve el objeto JSON o $null si no se pudo validar.
       -Mode install   : el candidato debe tener exactamente una fila nuestra mas
       -Mode uninstall : el candidato debe tener las mismas filas que la referencia
       -Mode check     : solo parsea y cuenta #>
    param(
        [Parameter(Mandatory = $true)][string]$Mode,
        [string]$CandidatePath,
        [string]$BaselinePath,
        [string]$HomePatchPath,
        [string]$AppBootJs,
        [string]$ValidatorJs,
        [string]$NodeExe,
        [string]$RowId = $script:McpConsoleRowId
    )

    if (-not (Test-Path -LiteralPath $ValidatorJs)) {
        Write-Warn ("falta el validador: " + $ValidatorJs)
        return $null
    }
    if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe)) {
        Write-Warn 'no hay node disponible para validar el YAML'
        return $null
    }
    if (-not (Test-Path -LiteralPath $AppBootJs)) {
        Write-Warn ("no encuentro el compositor extraido del asar: " + $AppBootJs)
        Write-Warn 'la validacion profunda se omite (revisar -ProjectRoot o el espejo recon/asar)'
        return $null
    }

    $args_ = @($ValidatorJs, '--mode', $Mode, '--app-boot', $AppBootJs, '--candidate', $CandidatePath, '--row-id', $RowId)
    if ($BaselinePath -and (Test-Path -LiteralPath $BaselinePath)) { $args_ += @('--baseline', $BaselinePath) }
    if ($HomePatchPath -and (Test-Path -LiteralPath $HomePatchPath)) { $args_ += @('--home', $HomePatchPath) }

    # Start-Process une el array con espacios SIN citar: hay que citar cada arg
    # (las rutas de este proyecto llevan espacios: "Config dsh").
    $quoted = (@($args_) | ForEach-Object { '"' + $_ + '"' }) -join ' '

    $stdoutFile = [System.IO.Path]::GetTempFileName()
    $stderrFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath ('"' + $NodeExe + '"') -ArgumentList $quoted -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $out = Read-Utf8Text $stdoutFile
        $err = Read-Utf8Text $stderrFile
        if ([string]::IsNullOrWhiteSpace($out)) {
            Write-Warn ("validador sin salida (exit " + $p.ExitCode + "): " + $err.Trim())
            return $null
        }
        try { $obj = $out | ConvertFrom-Json } catch {
            Write-Warn ("salida del validador ilegible: " + $out.Trim())
            return $null
        }
        return $obj
    } finally {
        Remove-Item -LiteralPath $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
    }
}

function Show-ValidationResult {
    param($Result)
    if ($null -eq $Result) {
        Write-Warn 'validacion profunda no disponible (ver avisos de arriba)'
        return $false
    }
    if (-not $Result.ok) {
        foreach ($e in $Result.errors) { Write-Bad ("YAML/composicion: " + $e) }
        foreach ($w in $Result.warnings) { Write-Warn ("YAML/composicion: " + $w) }
        return $false
    }
    foreach ($w in $Result.warnings) { Write-Warn ("YAML/composicion: " + $w) }
    Write-Ok ("YAML valido y composicion estable: " + $Result.beforeRows + " filas -> " + $Result.afterRows + " filas (delta " + $Result.delta + ")")
    return $true
}

# ------------------------------------------------------------------ enlace ---

function Get-LinkInfo {
    <# Inspecciona el enlace sin seguirlo. Devuelve Exists / IsLink / Target. #>
    param([string]$LinkPath)
    if (-not (Test-Path -LiteralPath $LinkPath)) {
        return [pscustomobject]@{ Exists = $false; IsLink = $false; Target = $null; IsDirectory = $false }
    }
    $item = $null
    try { $item = Get-Item -LiteralPath $LinkPath -Force } catch { $item = $null }
    if ($null -eq $item) {
        # Existe la entrada pero no se puede leer (junction roto, permisos...).
        return [pscustomobject]@{ Exists = $true; IsLink = $false; Target = $null; IsDirectory = $false; Unreadable = $true }
    }
    $isDir = $item.PSIsContainer
    $target = $null
    $isLink = $false
    if ($item.LinkType -in @('Junction', 'SymbolicLink')) {
        $isLink = $true
        $t = $item.Target
        if ($t -is [array]) { $target = @($t)[0] } else { $target = [string]$t }
    }
    return [pscustomobject]@{ Exists = $true; IsLink = $isLink; Target = $target; IsDirectory = $isDir; Unreadable = $false }
}

function Test-SamePath {
    param([string]$A, [string]$B)
    if (-not $A -or -not $B) { return $false }
    try {
        $a = [System.IO.Path]::GetFullPath($A).TrimEnd('\')
        $b = [System.IO.Path]::GetFullPath($B).TrimEnd('\')
        return ($a -ieq $b)
    } catch { return $false }
}

function New-DirForce {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null
    }
}

# ------------------------------------------------- copia del paquete ---------
# Decision (evidencia en docs/instalacion.md): la copia instalada son FICHEROS
# REALES, no un junction. El Host decide la capa de resolucion de un modulo por
# su ruta: si cae bajo ~/.dsh/profiles/ es capa `profile` y sus nombres bare se
# interponen; si no, solo cuenta como `linked` si su ruta real estaba en la tabla
# `linkedRoots`, calculada al construir la resolucion, no al importar
# (dsh-app-boot/lib/index.js:1337-1345 findInterceptionLayer, :1316
# resolution.linkedPaths, :664-692 linkedProfileRoots con symlinksUnder). Un
# junction apuntando al repo queda fuera de `profiles/` y su capa no es `profile`.

function Get-TreeManifest {
    <# Manifiesto deterministico de un arbol: rutas relativas ordenadas + tamano +
       sha256 por fichero. Excluye por nombre relativo (p.ej. package.json). #>
    param([string]$Path, [string[]]$Exclude = @())

    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    $root = (Resolve-Path -LiteralPath $Path).ProviderPath
    $items = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -ErrorAction SilentlyContinue)
    $rows = @()
    foreach ($f in $items) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\') -replace '\\', '/'
        if ($Exclude -contains $rel) { continue }
        $rows += [pscustomobject]@{
            rel  = $rel
            size = $f.Length
            hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
        }
    }
    return @($rows | Sort-Object rel)
}

function Get-TreeHash {
    param([string]$Path, [string[]]$Exclude = @())
    $manifest = Get-TreeManifest -Path $Path -Exclude $Exclude
    $sb = New-Object System.Text.StringBuilder
    foreach ($r in $manifest) { $null = $sb.AppendLine($r.rel + '|' + $r.size + '|' + $r.hash) }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($sb.ToString())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '') }
    finally { $sha.Dispose() }
}

function Compare-TreeManifest {
    <# Devuelve solo_izquierda / solo_derecha / distintos (rutas relativas). #>
    param($Left, $Right)
    $l = @{}
    foreach ($r in $Left) { $l[$r.rel] = $r }
    $rgt = @{}
    foreach ($r in $Right) { $rgt[$r.rel] = $r }

    $onlyLeft = @(); $onlyRight = @(); $different = @()
    foreach ($k in $l.Keys) {
        if (-not $rgt.ContainsKey($k)) { $onlyLeft += $k }
        elseif ($l[$k].hash -ne $rgt[$k].hash) { $different += $k }
    }
    foreach ($k in $rgt.Keys) { if (-not $l.ContainsKey($k)) { $onlyRight += $k } }
    return [pscustomobject]@{
        OnlyLeft  = @($onlyLeft | Sort-Object)
        OnlyRight = @($onlyRight | Sort-Object)
        Different = @($different | Sort-Object)
        Equal     = (($onlyLeft.Count + $onlyRight.Count + $different.Count) -eq 0)
    }
}

function Invoke-PackageCopy {
    <# Espeja el paquete del repo en node_modules (robocopy /MIR; /MIR borra
       lo que sobra, para que la copia no acumule ficheros viejos). Si el
       destino fuese un junction de una version anterior, se elimina antes
       (sin recursión: nunca toca el destino del enlace). #>
    param([string]$Source, [string]$Destination, [switch]$DryRun)

    $result = [pscustomobject]@{
        Ok             = $false
        RemovedLegacy  = $false
        RobocopyExit   = $null
        Mechanism      = $null
        Detail         = ''
    }

    if (-not (Test-Path -LiteralPath $Source)) {
        $result.Detail = 'no existe el origen: ' + $Source
        return $result
    }

    # Destino existente: si es un enlace (version anterior de estos scripts o
    # enlace manual) se quita; si es un directorio real se espeja encima.
    if (Test-Path -LiteralPath $Destination) {
        $info = Get-LinkInfo -LinkPath $Destination
        if ($info.IsLink -or $info.Unreadable) {
            if ($DryRun) {
                Write-Plan ('eliminaria el enlace previo ' + $Destination + ' (queda como copia real)')
                $result.RemovedLegacy = $true
            } else {
                try {
                    [System.IO.Directory]::Delete($Destination, $false)
                    $result.RemovedLegacy = $true
                    Write-Ok 'enlace previo eliminado (se sustituye por copia real)'
                } catch {
                    $result.Detail = 'no se pudo quitar el enlace previo: ' + $_.Exception.Message
                    return $result
                }
            }
        }
    }

    if ($DryRun) {
        Write-Plan ('robocopy /MIR "' + $Source + '" -> "' + $Destination + '"')
        $result.Ok = $true
        $result.Mechanism = 'dry-run'
        return $result
    }

    New-DirForce (Split-Path -Parent $Destination)

    $robocopy = Get-Command robocopy.exe -ErrorAction SilentlyContinue
    if ($robocopy) {
        $argList = '"/MIR" "' + $Source + '" "' + $Destination + '" "/NFL" "/NDL" "/NJH" "/NJS" "/NP" "/R:1" "/W:1"'
        $p = Start-Process -FilePath $robocopy.Source -ArgumentList $argList -NoNewWindow -Wait -PassThru
        $result.RobocopyExit = $p.ExitCode
        $result.Mechanism = 'robocopy'
        if ($p.ExitCode -ge 8) {
            $result.Detail = 'robocopy devolvio ' + $p.ExitCode + ' (>=8 es error)'
            return $result
        }
    } else {
        New-DirForce $Destination
        Copy-Item -LiteralPath (Join-Path $Source '*') -Destination $Destination -Recurse -Force -ErrorAction Stop
        $result.Mechanism = 'copy-item'
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Destination 'package.json'))) {
        $result.Detail = 'la copia no tiene package.json'
        return $result
    }
    $result.Ok = $true
    return $result
}

function Remove-ClientDeclaration {
    <# Quita dsh.client del package.json de la copia (ver _strip-client-decl.mjs). #>
    param([string]$PackageJsonPath, [string]$NodeExe, [string]$StripperJs, [switch]$DryRun)

    if ($DryRun) {
        Write-Plan ('quitaria dsh.client de ' + $PackageJsonPath)
        return $true
    }
    if ([string]::IsNullOrWhiteSpace($NodeExe) -or -not (Test-Path -LiteralPath $NodeExe)) { return $false }
    if (-not (Test-Path -LiteralPath $StripperJs)) { return $false }

    $outFile = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath ('"' + $NodeExe + '"') `
            -ArgumentList ('"' + $StripperJs + '" "' + $PackageJsonPath + '"') `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError ([System.IO.Path]::GetTempFileName())
        $out = Read-Utf8Text $outFile
        if ($p.ExitCode -ne 0) {
            Write-Warn ('no se pudo quitar dsh.client: ' + $out.Trim())
            return $false
        }
        Write-Ok ('package.json de la copia sin dsh.client: ' + $out.Trim())
        return $true
    } finally {
        Remove-Item -LiteralPath $outFile -Force -ErrorAction SilentlyContinue
    }
}


# ----------------------------------------------------------------- procesos --

function Get-McpProcessMap {
    <# Mapa de procesos relevante, de solo lectura.
       Host: el proceso padre mayoritario de los *-cli.exe (los servidores MCP
       stdio son hijos del host: recon/mcp-runtime.md seccion 8.1).
       Children: procesos hijo *-cli.exe de ese host. #>
    param([int]$HostPid = 0)

    $cli = @()
    try {
        $cli = @(Get-CimInstance Win32_Process -Filter "Name LIKE '%-cli.exe'" -ErrorAction Stop)
    } catch {
        $cli = @()
    }

    if ($HostPid -le 0 -and $cli.Count -gt 0) {
        $grouped = $cli | Group-Object ParentProcessId | Sort-Object Count -Descending
        if ($grouped.Count -gt 0) { $HostPid = [int]$grouped[0].Name }
    }

    $children = @()
    if ($HostPid -gt 0) {
        $children = @($cli | Where-Object { $_.ParentProcessId -eq $HostPid })
    }

    return [pscustomobject]@{
        HostPid  = $HostPid
        CliAll   = $cli
        Children = $children
    }
}

# ------------------------------------------------------------------ diff -----

function Show-TextDiff {
    <# Diff linea a linea (solo para mostrar). Devuelve el numero de lineas
       que difieren. No es un diff LCS: compara por indice y marca -, +. #>
    param([string]$Left, [string]$Right, [string]$LeftLabel = 'original', [string]$RightLabel = 'nuevo')

    $a = @()
    $b = @()
    if (-not [string]::IsNullOrEmpty($Left)) { $a = $Left -split "`n" }
    if (-not [string]::IsNullOrEmpty($Right)) { $b = $Right -split "`n" }

    $max = [Math]::Max($a.Count, $b.Count)
    $diffCount = 0
    $shown = 0
    for ($i = 0; $i -lt $max; $i++) {
        $la = if ($i -lt $a.Count) { $a[$i] } else { $null }
        $lb = if ($i -lt $b.Count) { $b[$i] } else { $null }
        if ($la -ne $lb) {
            $diffCount++
            if ($shown -lt 40) {
                if ($null -ne $la) { Write-Host ("    - [" + ($i + 1) + "] " + $la) -ForegroundColor Red }
                if ($null -ne $lb) { Write-Host ("    + [" + ($i + 1) + "] " + $lb) -ForegroundColor Green }
                $shown++
            }
        }
    }
    if ($diffCount -eq 0) { Write-Ok ("sin diferencias: " + $LeftLabel + " == " + $RightLabel) }
    else { Write-Info ($diffCount.ToString() + ' linea(s) distinta(s) entre "' + $LeftLabel + '" y "' + $RightLabel + '"') }
    return $diffCount
}
