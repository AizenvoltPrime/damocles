// BROWSER on a Windows host: Node runs the relay (dist/cli-remote.js --open-external) with the caller's command line after the
// program name passed on unchanged, so no cmd.exe parses & or % in an address (CERT VU#123335) and Node's C runtime splits it
// as this program's would. Built without a C runtime by scripts/browser-helper.ts; DAMOCLES_CHECKOUT runs the Node on PATH.
#include <windows.h>

// CreateProcessW's limit on a command line, in characters with the terminating null
#define MAX_COMMAND_LINE 32768

static HANDLE heap;

static WCHAR *allocate(SIZE_T chars) {
  WCHAR *block = HeapAlloc(heap, HEAP_ZERO_MEMORY, chars * sizeof(WCHAR));
  if (block == NULL) ExitProcess(ERROR_NOT_ENOUGH_MEMORY);
  return block;
}

static SIZE_T length(const WCHAR *text) {
  SIZE_T n = 0;
  while (text[n] != 0) n++;
  return n;
}

static WCHAR *append(WCHAR *at, const WCHAR *text) {
  while (*text != 0) *at++ = *text++;
  return at;
}

static void write_error(const WCHAR *text) {
  char utf8[2048];
  int bytes = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof utf8, NULL, NULL);
  DWORD written;
  if (bytes > 1) WriteFile(GetStdHandle(STD_ERROR_HANDLE), utf8, (DWORD)(bytes - 1), &written, NULL);
}

// Prints "browser.exe: <path>: <the system's own message for error>" and exits 1.
static void fail(const WCHAR *path, DWORD error) {
  WCHAR *message = NULL;
  write_error(L"browser.exe: ");
  write_error(path);
  write_error(L": ");
  if (FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, NULL, error, 0, (WCHAR *)&message, 0, NULL) != 0) {
    write_error(message);
    LocalFree(message);
  } else {
    write_error(L"error\r\n");
  }
  ExitProcess(1);
}

// What follows the program name: the C runtime ends argv[0] at the first space or tab outside double quotes, a quote only
// toggling, then skips the blanks before argv[1].
static const WCHAR *arguments_of(const WCHAR *line) {
  BOOL quoted = FALSE;
  for (; *line != 0 && (quoted || (*line != L' ' && *line != L'\t')); line++) {
    if (*line == L'"') quoted = !quoted;
  }
  while (*line == L' ' || *line == L'\t') line++;
  return line;
}

// This program's full path, or a failure.
static WCHAR *own_path(void) {
  for (DWORD size = MAX_PATH;; size *= 2) {
    WCHAR *path = allocate(size);
    DWORD got = GetModuleFileNameW(NULL, path, size);
    if (got == 0) fail(L"GetModuleFileNameW", GetLastError());
    if (got < size) return path;
    if (size >= MAX_COMMAND_LINE) fail(L"GetModuleFileNameW", ERROR_FILENAME_EXCED_RANGE);
    HeapFree(heap, 0, path);
  }
}

// Cuts `path` before its last `levels` separators: three from bin\helpers\browser.exe is the package's root.
static void strip(WCHAR *path, int levels) {
  SIZE_T end = length(path);
  while (levels-- > 0) {
    while (end > 0 && path[end - 1] != L'\\' && path[end - 1] != L'/') end--;
    if (end == 0) fail(path, ERROR_PATH_NOT_FOUND);
    end--;
  }
  path[end] = 0;
}

#ifdef DAMOCLES_CHECKOUT
// node.exe in a folder PATH names, searched in PATH alone (never the working folder), as the checkout's sh and cmd scripts run node.
static WCHAR *node_on_path(void) {
  DWORD size = GetEnvironmentVariableW(L"PATH", NULL, 0);
  if (size == 0) fail(L"PATH", ERROR_ENVVAR_NOT_FOUND);
  WCHAR *search = allocate(size);
  GetEnvironmentVariableW(L"PATH", search, size);
  WCHAR *node = allocate(MAX_COMMAND_LINE);
  DWORD found = SearchPathW(search, L"node.exe", NULL, MAX_COMMAND_LINE, node, NULL);
  if (found == 0 || found >= MAX_COMMAND_LINE) fail(L"node.exe", found == 0 ? GetLastError() : ERROR_FILENAME_EXCED_RANGE);
  return node;
}
#endif

void __stdcall entry(void) {
  heap = GetProcessHeap();
  const WCHAR *arguments = arguments_of(GetCommandLineW());
  WCHAR *root = own_path();
  strip(root, 3);
#ifdef DAMOCLES_CHECKOUT
  WCHAR *node = node_on_path();
  const WCHAR *script = L"\\cli-remote.js";
#else
  WCHAR *node = allocate(length(root) + 16);
  append(append(node, root), L"\\node\\node.exe");
  const WCHAR *script = L"\\dist\\cli-remote.js";
#endif
  // a Windows path holds no double quote, so quoting the two paths needs no escape; neither ends in a backslash
  SIZE_T size = length(node) + length(root) + length(script) + length(arguments) + 32;
  if (size > MAX_COMMAND_LINE) fail(L"browser.exe", ERROR_FILENAME_EXCED_RANGE);
  WCHAR *line = allocate(size);
  WCHAR *at = append(line, L"\"");
  at = append(at, node);
  at = append(at, L"\" \"");
  at = append(at, root);
  at = append(at, script);
  at = append(at, L"\" --open-external ");
  append(at, arguments);

  STARTUPINFOW *startup = (STARTUPINFOW *)allocate(sizeof(STARTUPINFOW));
  startup->cb = sizeof(STARTUPINFOW);
  PROCESS_INFORMATION process;
  // inherits the standard handles this program was given
  if (!CreateProcessW(node, line, NULL, NULL, TRUE, 0, NULL, NULL, startup, &process)) fail(node, GetLastError());
  CloseHandle(process.hThread);
  DWORD code = 1;
  if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0 || !GetExitCodeProcess(process.hProcess, &code)) fail(node, GetLastError());
  ExitProcess(code);
}
