# Writes what each Windows keyboard layout types for Ctrl+Alt+Shift (AltGr+Shift) on every digit, letter and punctuation key,
# which commands.test.ts reads to keep the theme accelerators from swallowing a character. Windows only:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/altgr-layouts.ps1
param(
  [string] $Out = (Join-Path $PSScriptRoot '..\src\desktop\main\__tests__\altgr-layouts.json'),
  # en-US, Greek, German, French, Polish (Programmers)
  [string[]] $Layouts = @('00000409', '00000408', '00000407', '0000040C', '00000415')
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class AltGrLayouts {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr LoadKeyboardLayout(string klid, uint flags);
  [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr hkl);
  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int count, IntPtr[] list);
  [DllImport("user32.dll")] public static extern uint MapVirtualKeyEx(uint code, uint mapType, IntPtr hkl);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int ToUnicodeEx(uint vk, uint scanCode, byte[] keyState, StringBuilder buffer, int size, uint flags, IntPtr hkl);
}
'@

# KLF_NOTELLSHELL; a layout this run loaded is unloaded again, so the user's input languages stay as they were
$KLF_NOTELLSHELL = 0x80
# MAPVK_VK_TO_VSC
$VK_TO_VSC = 0
# leave the keyboard's dead key state alone (Windows 10 1607 and later)
$NO_STATE_CHANGE = 0x4
# Electron's accelerator keys on Windows: the digits, the letters and the OEM punctuation keys
$keys = @(0x30..0x39) + @(0x41..0x5A) + @(0xBA..0xC0) + @(0xDB..0xDF) + @(0xE2)
$state = New-Object byte[] 256
# VK_SHIFT, VK_CONTROL, VK_MENU, VK_LSHIFT, VK_LCONTROL, VK_RMENU: AltGr is left Ctrl with right Alt
foreach ($vk in 0x10, 0x11, 0x12, 0xA0, 0xA2, 0xA5) { $state[$vk] = 0x80 }

$before = New-Object IntPtr[] 64
$loaded = $before[0..([AltGrLayouts]::GetKeyboardLayoutList(64, $before) - 1)]

function JsonString([string] $text) {
  $escaped = ($text.ToCharArray() | ForEach-Object {
    $code = [int] $_
    if ($code -lt 0x20 -or $code -gt 0x7e -or $_ -eq '"' -or $_ -eq '\') { '\u{0:x4}' -f $code } else { [string] $_ }
  }) -join ''
  return '"' + $escaped + '"'
}

$entries = @()
foreach ($klid in $Layouts) {
  $name = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Keyboard Layouts\$klid").'Layout Text'
  $hkl = [AltGrLayouts]::LoadKeyboardLayout($klid, $KLF_NOTELLSHELL)
  if ($hkl -eq [IntPtr]::Zero) { throw "Windows cannot load the keyboard layout $klid" }
  try {
    $typed = @()
    foreach ($vk in $keys) {
      $buffer = New-Object System.Text.StringBuilder 8
      $scan = [AltGrLayouts]::MapVirtualKeyEx($vk, $VK_TO_VSC, $hkl)
      $count = [AltGrLayouts]::ToUnicodeEx($vk, $scan, $state, $buffer, $buffer.Capacity, $NO_STATE_CHANGE, $hkl)
      if ($count -eq 0) { continue }
      # a negative count is a dead key, which types the next key's accented form
      $text = $buffer.ToString().Substring(0, [Math]::Max(1, [Math]::Abs($count)))
      $value = if ($count -lt 0) { "dead $text" } else { $text }
      $typed += '        "0x{0:X2}": {1}' -f $vk, (JsonString $value)
      Write-Host ('{0} {1}: Ctrl+Alt+Shift+VK 0x{2:X2} types {3}' -f $klid, $name, $vk, $value)
    }
  } finally {
    if ($loaded -notcontains $hkl) { [void] [AltGrLayouts]::UnloadKeyboardLayout($hkl) }
  }
  $map = if ($typed.Count -eq 0) { '{}' } else { "{`r`n" + ($typed -join ",`r`n") + "`r`n      }" }
  $entries += "    `"$klid`": {`r`n      `"name`": $(JsonString $name),`r`n      `"ctrlAltShift`": $map`r`n    }"
}

$keyList = ($keys | ForEach-Object { '"0x{0:X2}"' -f $_ }) -join ', '
$json = "{`r`n  `"keys`": [$keyList],`r`n  `"layouts`": {`r`n" + ($entries -join ",`r`n") + "`r`n  }`r`n}`r`n"
[IO.File]::WriteAllText([IO.Path]::GetFullPath($Out), $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Wrote $Out"
