// Desktop color schemes (KDE, qt5ct/qt6ct, GTK) read into palette roles: pure text in, no I/O, nothing from core.
export { SchemeImportError, type SchemeRefusal } from './errors';
export { iniList, iniValue, MAX_INI_GROUPS, MAX_INI_LINES, readIni, type Ini } from './ini';
export { lookFromRoles, opaqueOver, qtColor, type LookSeed, type PaletteRoles, type SchemeRoles } from './palette';
export { kdeColor, kdeRoles, kdeRolesOfIni } from './kde';
export { qtRoles, qtRolesOfIni, QT_ROLES } from './qt';
export { gtkRoles, MAX_GTK_DEPTH } from './gtk';
export { LIBADWAITA_INFO, LIBADWAITA_SEEDS } from './libadwaita';
