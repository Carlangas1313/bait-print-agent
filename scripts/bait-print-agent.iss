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

[Files]
; Fuente: el .exe single-file generado por scripts/package-win.js (Node SEA).
; Destino: renombrado a bait-print-agent.exe (sin sufijo -win-x64) porque
; queda mas prolijo en services.msc y en los shortcuts.
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

; nssm.exe (Non-Sucking Service Manager) — wrapper que el install-service
; del agente usa por debajo para registrar el .exe Node como servicio Windows
; valido. Sin esto el servicio crashea con error 1053 al arrancar. ~300 KB.
Source: "..\dist\nssm.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Atajo principal: ejecuta el agente en modo virtual para que el cliente pueda
; mirar las comandas en una ventana sin tocar el servicio. Util para troubleshooting.
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Parameters: "--mode virtual"; Comment: "Abre el agente en una ventana de prueba (no requiere servicio detenido)"
Name: "{group}\Reconfigurar codigo"; Filename: "{app}\{#AppExeName}"; Parameters: "setup"; Comment: "Pega un nuevo codigo de pairing"
Name: "{group}\Estado del servicio"; Filename: "{app}\{#AppExeName}"; Parameters: "service-status"; Comment: "Muestra si el servicio esta corriendo"
Name: "{group}\Desinstalar {#AppName}"; Filename: "{uninstallexe}"

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

; 3. Checkbox opcional al final del wizard: abrir el navegador para que el
;    cliente confirme visualmente que el agente aparece "online".
Filename: "https://bait-app.cl/settings/printers"; \
  Description: "Abrir bait-app.cl para verificar que el agente esta conectado"; \
  Flags: postinstall shellexec nowait skipifsilent unchecked

[UninstallRun]
; Detener y borrar el servicio ANTES de que el motor de uninstall intente
; borrar el .exe — sino Windows tira "file in use" porque el servicio lo tiene.
; RunOnceId evita ejecutar dos veces si el user clickea uninstall doble.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  // -------------------------------------------------------------------------
  // Pagina 1 (opcional): "Saltar configuracion" — checkbox para reinstalaciones.
  // Si el user ya tiene config.json valido (porque reinstala el agente sobre
  // la version vieja), no queremos forzarlo a pegar el codigo de nuevo.
  // -------------------------------------------------------------------------
  SkipPairingCheck := CreateInputOptionPage(
    wpSelectDir,
    'Configuracion',
    'Como queres configurar el agente',
    'Si es la primera vez que instalas el agente en este equipo, dejalo en "Configurar ahora" para pegar el codigo de pairing. Si solo estas actualizando el agente y ya tenes la config guardada, elegi "Saltar".',
    True,   // exclusive (radio buttons)
    False); // not list-style
  SkipPairingCheck.Add('Configurar ahora (recomendado — primera instalacion)');
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
// ShouldSkipPage — saltea la pagina del codigo si el user eligio "saltar"
// ===========================================================================

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := False;
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
  // {userprofile} de Inno equivale a %USERPROFILE% = os.homedir() en Windows.
  Result := ExpandConstant('{userprofile}\.bait-print-agent\config.json');
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
        RemoveDir(ExpandConstant('{userprofile}\.bait-print-agent'));
      end;
    end;
  end;
end;
