; ============================================================================
; bAIt Print Agent - Inno Setup script
; ----------------------------------------------------------------------------
; Genera un instalador Windows con UI en espanol para clientes no-tecnicos.
; El wizard pide el codigo de 8 caracteres (XXXX-XXXX) en una pagina custom,
; copia el .exe a Program Files, corre `setup --code <code>` + `install-service`
; con UAC ya elevada (PrivilegesRequired=admin) y deja el servicio corriendo.
;
; Como compilar:
;   ISCC.exe /Q /DVersion=0.3.0 scripts\bait-print-agent.iss
;
; Output:
;   dist\Output\bait-print-agent-setup-0.3.0.exe
;
; Pre-requisitos:
;   - scripts/package-win.js ya corrio y genero dist/bait-print-agent-win-x64.exe
;   - Inno Setup 6.4+ instalado (windows-latest runner ya lo trae)
;
; Pascal Script:
;   - Pagina custom "Codigo de configuracion" inyectada con CreateInputQueryPage.
;   - Checkbox "Saltar configuracion" que skipea la validacion y el setup post-install.
;   - Validacion del codigo en NextButtonClick (charset [A-Z2-9]).
; ============================================================================

#ifndef Version
  #define Version "0.0.0-dev"
#endif

#define AppId            "{{B4F0C5A8-3D8E-4C9F-A1B2-1F2E3D4C5B6A}"
#define AppName          "bAIt Print Agent"
#define AppPublisher     "bAIt"
#define AppURL           "https://bait-app.cl"
#define AppExeName       "bait-print-agent.exe"
#define SourceExe        "..\dist\bait-print-agent-win-x64.exe"
; Companion (tray icon + ventana flotante) — Tauri 2 .exe que vive en la
; sesion del usuario, complementa el servicio (que corre en Session 0 y no
; puede mostrar UI). El CI build lo deja en companion/src-tauri/target/release.
#define CompanionExeName "bait-print-companion.exe"
#define CompanionSourceExe "..\companion\src-tauri\target\release\bait-print-companion.exe"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#Version}
AppVerName={#AppName} {#Version}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
DefaultDirName={autopf}\bAIt Print Agent
DefaultGroupName=bAIt Print Agent
OutputDir=..\dist\Output
OutputBaseFilename=bait-print-agent-setup-{#Version}
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
WizardStyle=modern
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableWelcomePage=no
ShowLanguageDialog=no
SetupLogging=yes
; El instalador no esta firmado todavia (Sprint 3c). SmartScreen va a quejarse
; la primera vez; el README lo documenta. Una vez firmado, sacar este comentario.

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
; Tarea opcional en el wizard: crear acceso directo en el escritorio del user.
; Default unchecked porque la mayoria de los cajeros prefiere usar el tray icon
; (que ya aparece autoarrancado por HKCU\Run) y no llenar el escritorio.
; Si el user lo tilda, se crea el .lnk en {autodesktop} apuntando al companion.
Name: "desktopicon"; Description: "Crear acceso directo en el Escritorio"; \
  GroupDescription: "Accesos directos adicionales:"; Flags: unchecked

[Files]
; Fuente: el .exe single-file generado por scripts/package-win.js (Node SEA).
; Destino: renombrado a bait-print-agent.exe (sin sufijo -win-x64) porque
; queda mas prolijo en services.msc y en los shortcuts.
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

; nssm.exe (Non-Sucking Service Manager) — wrapper que el install-service
; del agente usa por debajo para registrar el .exe Node como servicio Windows
; valido. Sin esto el servicio crashea con error 1053 al arrancar. ~300 KB.
Source: "..\dist\nssm.exe"; DestDir: "{app}"; Flags: ignoreversion

; Companion (tray icon + ventana flotante). Tauri 2 build pelado (~10-15 MB),
; sin MSI/NSIS — Inno Setup lo empaqueta junto al servicio en UN solo instalador.
; El [Registry] HKCU\...\Run lo autoarranca al login del user; el [Run] de mas
; abajo lo lanza una primera vez al finalizar el wizard. El servicio sigue
; corriendo independiente en Session 0 — el companion es solo UI premium del
; cajero, no es critico para el flujo de impresion.
Source: "{#CompanionSourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Atajo principal del companion: abre directamente el tray + ventana flotante.
; Lo dejamos primero porque es lo que el cajero usa todos los dias para ver
; cola y estado de impresoras. Comment se ve como tooltip en el Start Menu.
Name: "{group}\bAIt Print Companion"; Filename: "{app}\{#CompanionExeName}"; Comment: "Abre el dashboard del agente en el tray (estado, jobs recientes, test de impresion)"
; Atajo de troubleshooting: ejecuta el agente en modo virtual para que el cliente pueda
; mirar las comandas en una ventana sin tocar el servicio. Util para soporte.
Name: "{group}\{#AppName} (modo virtual)"; Filename: "{app}\{#AppExeName}"; Parameters: "--mode virtual"; Comment: "Abre el agente en una ventana de prueba (no requiere servicio detenido)"
Name: "{group}\Reconfigurar codigo"; Filename: "{app}\{#AppExeName}"; Parameters: "setup"; Comment: "Pega un nuevo codigo de pairing"
Name: "{group}\Estado del servicio"; Filename: "{app}\{#AppExeName}"; Parameters: "service-status"; Comment: "Muestra si el servicio esta corriendo"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"

; Atajo opcional en el escritorio. Solo se crea si el user tildo el checkbox
; "Crear acceso directo en el Escritorio" en la pagina de Tasks del wizard.
Name: "{autodesktop}\bAIt Print Companion"; Filename: "{app}\{#CompanionExeName}"; \
  Comment: "Abre el dashboard del agente en el tray"; \
  Tasks: desktopicon

[Registry]
; Autostart del companion al login del user actual. HKCU (no HKLM) porque el
; companion vive en la sesion del usuario — Session 0 (donde corre el servicio
; Windows) no tiene desktop ni tray icons. uninsdeletevalue borra la entry
; cuando se desinstala el agente, asi no quedan keys huerfanas en el registry.
;
; Nota: HKCU se escribe en el contexto del user que esta corriendo el setup
; (que con PrivilegesRequired=admin sigue siendo el user humano, no SYSTEM).
; Si el restaurant tiene varios users Windows que se loguean en la misma PC,
; el companion solo va a arrancar para el user que instalo. Para autostart
; multi-user habria que usar HKLM\...\Run, pero eso requiere repensar el
; tema de ventanas alwaysOnTop entre sesiones.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; \
  ValueType: string; ValueName: "bAItPrintCompanion"; \
  ValueData: """{app}\{#CompanionExeName}"""; \
  Flags: uninsdeletevalue

[Run]
; ----------------------------------------------------------------------------
; Post-install (se ejecuta DESPUES de copiar archivos, ANTES de mostrar la
; pagina final). El check de Pascal Script `ShouldRunSetup` lee la variable
; global PairingCode + el checkbox "saltar". Si el user pego codigo, lo pasamos.
; ----------------------------------------------------------------------------

; 1. Canjear el codigo de pairing y guardar config en %USERPROFILE%\.bait-print-agent\config.json.
;    Si el RPC falla (codigo invalido/expirado), el .exe sale con exit != 0 y
;    AfterInstall ShowSetupErrorIfAny() muestra un MsgBox con el detalle.
Filename: "{app}\{#AppExeName}"; \
  Parameters: "setup --code {code:PairingCode}"; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Vinculando este equipo con bait-app.cl..."; \
  Check: ShouldRunSetup; \
  AfterInstall: ShowSetupErrorIfAny

; 2. Instalar y arrancar el servicio Windows. Es el paso que justifica
;    PrivilegesRequired=admin: sc.exe create necesita elevation.
Filename: "{app}\{#AppExeName}"; \
  Parameters: "install-service"; \
  Flags: runhidden waituntilterminated; \
  StatusMsg: "Instalando el servicio Windows..."; \
  Check: ShouldInstallService; \
  AfterInstall: ShowServiceErrorIfAny

; 3. Lanzar el companion en el tray al terminar el wizard. postinstall +
;    skipifsilent = checkbox marcado por default en la pagina final del wizard
;    que el user puede destildar (ej. si esta instalando remotamente y no
;    necesita el tray ahi). nowait = no esperamos a que el companion termine
;    porque es long-running (vive en el tray hasta que el user lo cierre).
;    En reinicios futuros el companion arranca solo por el HKCU\...\Run entry.
Filename: "{app}\{#CompanionExeName}"; \
  Description: "Iniciar bAIt Print Companion en el tray"; \
  Flags: nowait postinstall skipifsilent

; 4. Checkbox opcional al final del wizard: abrir el navegador para que el
;    cliente confirme visualmente que el agente aparece "online".
Filename: "https://bait-app.cl/settings/printers"; \
  Description: "Abrir bait-app.cl para verificar que el agente esta conectado"; \
  Flags: postinstall shellexec nowait skipifsilent unchecked

[UninstallRun]
; 1. Matar el companion ANTES de borrar archivos. Sin esto el .exe del
;    companion queda lockeado (el user lo dejo corriendo en el tray) y Inno
;    tira "file in use" exactamente igual que pasaria con el servicio.
;    /F = forzar, /T = matar hijos del proceso (por si lanza webview2 hijo).
;    2>nul = no escupir error si el proceso no esta corriendo (el user pudo
;    haberlo cerrado a mano antes de desinstalar). RunOnceId evita re-ejecutar
;    si Inno reintenta la fase de uninstall.
Filename: "{cmd}"; \
  Parameters: "/C taskkill /F /IM {#CompanionExeName} /T 2>nul"; \
  Flags: runhidden; \
  RunOnceId: "KillCompanion"

; 2. Detener y borrar el servicio ANTES de que el motor de uninstall intente
;    borrar el .exe — sino Windows tira "file in use" porque el servicio lo tiene.
;    RunOnceId evita ejecutar dos veces si el user clickea uninstall doble.
Filename: "{app}\{#AppExeName}"; \
  Parameters: "uninstall-service"; \
  Flags: runhidden waituntilterminated; \
  RunOnceId: "UninstallService"

[Code]
// ===========================================================================
// Variables globales del Pascal Script.
// ===========================================================================

var
  PairingPage: TInputQueryWizardPage;
  SkipPairingCheck: TInputOptionWizardPage;
  CurrentPairingCode: String;
  SkipPairing: Boolean;
  // True solo si encontramos config.json en %USERPROFILE%\.bait-print-agent\
  // al iniciar el wizard. Si no existe, la pagina "Saltar configuracion" se
  // skipea entera y forzamos pairing — sino el cliente reinstala despues de
  // desinstalar y queda con servicio en crash loop por config faltante.
  ExistingConfigFound: Boolean;
  // True cuando el setup fue lanzado por el companion (boton "Instalar update").
  // El companion pasa /COMPANIONUPDATE como argumento al Start-Process. En ese
  // caso saltamos Welcome + SelectDir + las paginas de pairing (asume Saltar)
  // porque sabemos que es un upgrade con config preservada. Si el user corre
  // el setup manual (doble click desde Downloads), este flag queda False y el
  // wizard muestra todas las opciones para que pueda re-vincular o re-configurar.
  IsCompanionUpdate: Boolean;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Chequea si alguno de los argumentos pasados al setup.exe es `flag`
// (case-insensitive). El companion lo invoca con /COMPANIONUPDATE cuando
// quiere ejecutar un upgrade "smart defaults" sin preguntas redundantes.
//
// Inno expone los args via ParamCount/ParamStr (sintaxis Pascal-like). El
// matching es exacto (no permite ":valor" tipo /CODE:XXXX); para flags
// booleanos eso alcanza.
function HasCmdLineFlag(const Flag: String): Boolean;
var
  i: Integer;
begin
  Result := False;
  for i := 1 to ParamCount do
  begin
    if CompareText(ParamStr(i), Flag) = 0 then
    begin
      Result := True;
      Exit;
    end;
  end;
end;

// Valida el formato del codigo XXXX-XXXX (o XXXXXXXX sin guion). Acepta
// minusculas (las normalizamos a mayuscula antes de pasarlo al .exe). Mantiene
// el mismo charset que CODE_REGEX en src/setup.ts: [A-Z2-9] (sin 0 ni 1 para
// evitar ambiguedad visual con O e I). Aceptamos todas las letras A-Z porque
// el backend ya rechaza codigos invalidos via RPC claim_pairing_code.
function IsValidPairingCode(const Code: String): Boolean;
var
  I: Integer;
  Ch: Char;
  CleanCode: String;
begin
  Result := False;
  CleanCode := '';
  // Strip guion + whitespace por si el user pego con espacios/tabs.
  for I := 1 to Length(Code) do
  begin
    Ch := Code[I];
    if (Ch <> '-') and (Ch <> ' ') and (Ch <> #9) then
      CleanCode := CleanCode + Ch;
  end;
  if Length(CleanCode) <> 8 then
    Exit;
  // Uppercase del string completo en una sola pasada (Pascal Script de
  // Inno expone Uppercase: String -> String, no tiene UpCase de Char).
  CleanCode := Uppercase(CleanCode);
  for I := 1 to Length(CleanCode) do
  begin
    Ch := CleanCode[I];
    // [A-Z2-9] — letras + digitos sin 0 ni 1.
    if not (((Ch >= 'A') and (Ch <= 'Z'))
         or ((Ch >= '2') and (Ch <= '9'))) then
      Exit;
  end;
  Result := True;
end;

// Normaliza el codigo a la forma canonica XXXX-XXXX en mayuscula.
function NormalizePairingCode(const Code: String): String;
var
  I: Integer;
  Ch: Char;
  Clean: String;
begin
  Clean := '';
  for I := 1 to Length(Code) do
  begin
    Ch := Code[I];
    if (Ch <> '-') and (Ch <> ' ') and (Ch <> #9) then
      Clean := Clean + Ch;
  end;
  Clean := Uppercase(Clean);
  if Length(Clean) = 8 then
    Result := Copy(Clean, 1, 4) + '-' + Copy(Clean, 5, 4)
  else
    Result := Clean;
end;

// ===========================================================================
// InitializeWizard — crea las paginas custom
// ===========================================================================

procedure InitializeWizard;
begin
  // Default: si la pagina de skip se oculta (porque no hay config previa),
  // SkipPairing queda False y el wizard fuerza el flujo de pairing.
  SkipPairing := False;

  // -------------------------------------------------------------------------
  // Chequeo de config previa. Si NO existe config.json en el home del user,
  // saltamos la pagina de "Saltar configuracion" mas abajo y forzamos pairing.
  //
  // Usamos GetEnv en lugar de ExpandConstant('{userprofile}') porque
  // {userprofile} NO es una constante de Inno Setup (solo {userdocs},
  // {userappdata}, etc lo son). GetEnv lee USERPROFILE del env del proceso
  // del instalador, que siempre apunta al home del user humano que esta
  // corriendo el .exe del instalador.
  // -------------------------------------------------------------------------
  ExistingConfigFound := FileExists(
    GetEnv('USERPROFILE') + '\.bait-print-agent\config.json');

  // -------------------------------------------------------------------------
  // Modo "update via companion" — el companion paso /COMPANIONUPDATE.
  // En este modo asumimos upgrade silencioso: skip Welcome, SelectDir,
  // SkipPairingCheck y PairingPage. Solo el user ve Tasks (desktop shortcut)
  // + Ready (1 click confirm) + Installing + Finished.
  //
  // Si NO esta el flag (instalacion manual descargada de GitHub), el wizard
  // muestra todas las paginas como siempre — el user controla todo.
  // -------------------------------------------------------------------------
  IsCompanionUpdate := HasCmdLineFlag('/COMPANIONUPDATE');
  if IsCompanionUpdate and ExistingConfigFound then
  begin
    // En upgrade via companion con config: pre-elegimos "Saltar" porque
    // ShouldSkipPage va a esconder SkipPairingCheck y NextButtonClick no
    // se va a invocar para esa pagina. Sin esto, SkipPairing quedaria
    // False y ShouldRunSetup intentaria correr `setup --code` con codigo
    // vacio (que romperia el upgrade).
    SkipPairing := True;
  end;

  // -------------------------------------------------------------------------
  // Pagina 1 (condicional): "Saltar configuracion" — checkbox para reinstalaciones.
  // Solo tiene sentido si el user ya tiene config.json. La creamos siempre por
  // simplicidad (el ID se reusa abajo), pero ShouldSkipPage la oculta cuando
  // no hay config previa, asi el wizard fuerza al user a pegar el codigo.
  // -------------------------------------------------------------------------
  SkipPairingCheck := CreateInputOptionPage(
    wpSelectDir,
    'Configuracion',
    'Como queres configurar el agente',
    'Detectamos una configuracion previa en este equipo. Si solo estas actualizando el agente, elegi "Saltar". Si queres re-vincularlo con un codigo nuevo, dejalo en "Configurar ahora".',
    True,   // exclusive (radio buttons)
    False); // not list-style
  SkipPairingCheck.Add('Configurar ahora (recomendado — usa un codigo nuevo)');
  SkipPairingCheck.Add('Saltar configuracion (ya tengo el agente configurado)');
  SkipPairingCheck.SelectedValueIndex := 0;

  // -------------------------------------------------------------------------
  // Pagina 2: input del codigo de pairing.
  // -------------------------------------------------------------------------
  PairingPage := CreateInputQueryPage(
    SkipPairingCheck.ID,
    'Codigo de configuracion',
    'Pega el codigo de 8 caracteres que te dio bait-app.cl',
    'Genera el codigo desde bait-app.cl -> Configuracion -> Impresoras -> "+ Conectar nueva impresora". Pegalo aca, en formato XXXX-XXXX. El codigo expira a los 10 minutos.');
  PairingPage.Add('Codigo de pairing:', False);
  PairingPage.Values[0] := '';

  // Hint visual: monoespaciada para que el codigo se lea claro al pegar.
  // En Inno Setup 6.x el TNewEdit expuesto al Pascal Script tiene .Font
  // accesible. Si en alguna version futura no esta, esto deberia simplemente
  // dejar la fuente por defecto sin tirar error de compilacion.
  PairingPage.Edits[0].Font.Name := 'Consolas';
  PairingPage.Edits[0].Font.Size := 14;
  // MaxLength: aceptamos hasta 20 caracteres por si el user pega con espacios
  // o tabs extras. La validacion en NextButtonClick los descarta y verifica
  // que queden exactamente 8 caracteres validos.
  PairingPage.Edits[0].MaxLength := 20;
end;

// ===========================================================================
// CurStepChanged(ssInstall) — anti-zombie pre-install
// ===========================================================================
//
// PROBLEMA QUE RESUELVE (descubierto en cliente real con v0.6.0):
// Cuando el user actualiza el agente (re-corre el setup sobre una instalacion
// previa), Inno Setup intenta sobrescribir bait-print-agent.exe pero el
// servicio Windows lo tiene LOCKEADO. El user ve "File in use, retry?" y
// peor: si Inno se las arregla para reemplazar, el proceso hijo de NSSM puede
// quedar HUERFANO (zombie) con el puerto 17891 todavia tomado. Al arrancar
// el nuevo servicio, NSSM tira crash loop por EADDRINUSE → PAUSED forever.
//
// FIX: Antes de copiar archivos, paramos el servicio (sc.exe stop) y
// taskkilleamos cualquier .exe huerfano del agente o del companion. El
// sleep da tiempo al SO a liberar handles y puertos TCP.
//
// Esto corre SIEMPRE — si es instalacion fresca, sc.exe stop falla (no
// existe el servicio), taskkill no encuentra procesos, todo no-op. Si es
// upgrade, hace su trabajo limpio.

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    // 1. Stop graceful del servicio Windows. sc.exe esta en %SystemRoot%\system32
    //    de toda PC Win11. Exit code 1060 = "servicio no existe", lo ignoramos.
    Exec('sc.exe', 'stop bAItPrintAgent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // 2. Esperar 2s para que NSSM ejecute el shutdown del child + libere
    //    socket. Sin esto el child puede seguir vivo en TIME_WAIT del TCP.
    Sleep(2000);
    // 3. Taskkill defensivo por si NSSM no limpio bien (caso del bug que vimos
    //    con la v0.6.0: child quedaba huerfano tomando puerto 17891). /T mata
    //    procesos hijos tambien (webview2 del companion, etc).
    Exec('cmd.exe', '/C taskkill /F /IM bait-print-companion.exe /T',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec('cmd.exe', '/C taskkill /F /IM bait-print-agent.exe /T',
      '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // 4. Otro segundo para que Windows libere los file handles antes de
    //    que el motor de Inno empiece a copiar al destino.
    Sleep(1500);
  end;
end;

// ===========================================================================
// ShouldSkipPage — saltea la pagina del codigo si el user eligio "saltar"
// ===========================================================================

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;

  // -------------------------------------------------------------------------
  // Update via companion (flag /COMPANIONUPDATE + config existente):
  // saltamos las paginas que el companion ya sabe.
  // -------------------------------------------------------------------------
  if IsCompanionUpdate and ExistingConfigFound then
  begin
    if (PageID = wpWelcome) or
       (PageID = wpSelectDir) or
       (PageID = SkipPairingCheck.ID) or
       (PageID = PairingPage.ID) then
    begin
      Result := True;
      Exit;
    end;
    // Tasks (desktop shortcut), Ready y Finished se MANTIENEN visibles
    // — son confirmaciones rapidas que el user puede tildar/destildar.
  end;

  // -------------------------------------------------------------------------
  // Instalacion manual (sin flag): comportamiento clasico.
  // -------------------------------------------------------------------------
  // Si no hay config previa, ocultamos "Saltar configuracion" y mandamos
  // directo a la pagina del codigo.
  if (PageID = SkipPairingCheck.ID) and (not ExistingConfigFound) then
  begin
    Result := True;
    Exit;
  end;
  // Si hay config previa y el user eligio "saltar", skipeamos PairingPage.
  if (PageID = PairingPage.ID) and (SkipPairingCheck.SelectedValueIndex = 1) then
    Result := True;
end;

// ===========================================================================
// NextButtonClick — valida el codigo antes de avanzar
// ===========================================================================

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: String;
begin
  Result := True;

  // Si esta saliendo de la pagina de skip, registramos la eleccion.
  if CurPageID = SkipPairingCheck.ID then
  begin
    SkipPairing := (SkipPairingCheck.SelectedValueIndex = 1);
    Exit;
  end;

  // Validacion del codigo solo cuando salimos de la pagina del codigo.
  if CurPageID = PairingPage.ID then
  begin
    Code := Trim(PairingPage.Values[0]);
    if Code = '' then
    begin
      MsgBox('Pega el codigo de pairing antes de continuar.' + #13#10 +
             'Si todavia no lo generaste, entra a bait-app.cl -> Configuracion -> Impresoras.',
             mbError, MB_OK);
      Result := False;
      Exit;
    end;
    if not IsValidPairingCode(Code) then
    begin
      MsgBox('El codigo debe tener formato XXXX-XXXX (8 caracteres, letras y numeros).' + #13#10 +
             'Revisa que no falten o sobren caracteres.',
             mbError, MB_OK);
      Result := False;
      Exit;
    end;
    CurrentPairingCode := NormalizePairingCode(Code);
  end;
end;

// ===========================================================================
// Helpers de [Run] checks
// ===========================================================================

// True solo si el user no eligio "saltar" y dejo un codigo no vacio.
function ShouldRunSetup: Boolean;
begin
  Result := (not SkipPairing) and (CurrentPairingCode <> '');
end;

// Siempre instalamos el servicio (con o sin pairing). Si el user salteo
// la config, el .exe del servicio va a tirar warnings hasta que corra
// el `setup --code` manualmente desde el atajo "Reconfigurar codigo".
function ShouldInstallService: Boolean;
begin
  Result := True;
end;

// ===========================================================================
// Constant resolver para {code:PairingCode} en el [Run]
// ===========================================================================

// Inno permite referenciar funciones Pascal desde Parameters/Filename del [Run]
// con la sintaxis {code:NombreFuncion|Default}. Esta funcion devuelve el codigo
// normalizado que el user pego en la pagina custom. Si el user salteo el paso,
// devuelve string vacio (el ShouldRunSetup ya filtra ese caso, asi que el .exe
// no se invoca con codigo vacio).
function PairingCode(Param: String): String;
begin
  Result := CurrentPairingCode;
end;

// ===========================================================================
// AfterInstall callbacks — capturan exit codes para mostrar errores al user
// ===========================================================================

// Inno expone GetExceptionMessage + (mas usable aca) la propiedad Exec/ResultCode
// del [Run] item. Como Inno NO da acceso directo al exit code del [Run] desde
// Pascal en versiones <6.3, usamos un truco: corremos Exec() dentro del
// AfterInstall para volver a llamar al .exe si el flag indica fallo.
//
// Solucion mas robusta: leer la output del log de [Run] no es trivial.
// En la practica usamos `waituntilterminated` y delegamos el reporte de
// errores al .exe (escribe a stderr; el log de Inno lo guarda). Si el cliente
// reporta "no quedo conectado", le pedimos %TEMP%\Setup Log *.txt.
//
// Para este V1 dejamos los AfterInstall vacios — el error queda en el log
// del instalador. En V2 podemos parsear el log y mostrar MsgBox aca.

procedure ShowSetupErrorIfAny;
begin
  // V1: confiamos en el log del instalador. Si el `setup --code` falla,
  // el `install-service` va a arrancar igual y el servicio va a quedar
  // logueando "no hay config persistente" — el cliente lo nota en
  // bait-app.cl porque el agente no aparece online.
end;

procedure ShowServiceErrorIfAny;
begin
  // V1: igual que arriba. Si el servicio falla al crearse, services.msc
  // no lo lista. El cliente ve "no online" en bait-app.cl y pide soporte.
end;

// ===========================================================================
// UninstallStep — pregunta si borrar la config persistente
// ===========================================================================

function GetUserConfigPath: String;
begin
  // src/persistent-config.ts usa os.homedir() + '/.bait-print-agent/config.json'.
  // GetEnv('USERPROFILE') equivale a %USERPROFILE% = os.homedir() en Windows.
  // (No usamos ExpandConstant('{userprofile}') porque {userprofile} no es
  // una constante valida de Inno Setup — los constantes documentados son
  // {userdocs}, {userappdata}, etc.)
  Result := GetEnv('USERPROFILE') + '\.bait-print-agent\config.json';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ConfigPath: String;
  Response: Integer;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    ConfigPath := GetUserConfigPath;
    if FileExists(ConfigPath) then
    begin
      Response := MsgBox(
        'Encontre la configuracion guardada en:' + #13#10 +
        ConfigPath + #13#10 + #13#10 +
        'Si la borro, vas a tener que generar un codigo nuevo en bait-app.cl ' +
        'cuando reinstales el agente.' + #13#10 + #13#10 +
        'Queres borrarla?',
        mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
      if Response = IDYES then
      begin
        DeleteFile(ConfigPath);
        // Intentamos borrar tambien la carpeta padre si quedo vacia.
        RemoveDir(GetEnv('USERPROFILE') + '\.bait-print-agent');
      end;
    end;
  end;
end;
